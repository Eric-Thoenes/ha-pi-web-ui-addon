/**
 * Pi Web Addon proxy — HTTP e WebSocket forward per ingress Home Assistant.
 * Ascolta su :3000 (ingress_port dell'add-on), inoltra a pi-web-ui su 127.0.0.1:8888.
 * Strippa il prefisso ingress (X-Ingress-Path) dal path in ingresso e riscrive
 * SOLO i riferimenti asset assoluti (src/href) nell'HTML con quel prefisso.
 *
 * IMPORTANTE (pi-web-ui v0.76.0): il frontend calcola già il base path a runtime
 * da `document.baseURI` (funzioni Kl()/cr()/at() nel bundle) e lo applica a /ws,
 * /api/* e alla registrazione del service worker. Riscrivere "/api/" e "/ws" nei
 * body JS causerebbe un DOPPIO prefisso (es. .../pi_web_ui_agent/pi_web_ui_agent/api/...)
 * e romperebbe API e WebSocket. Qui si riscrivono quindi solo i path asset assoluti
 * dell'index.html (/assets/, /favicon.svg, ecc.), che il frontend NON riscrive da solo.
 */

import http from "node:http";
import net from "node:net";

const PI_WEB_UI_PORT = 8888;
const PI_WEB_UI_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 3000);

function getIngressBase(req) {
  const p = (req.headers["x-ingress-path"] || "").replace(/\/+$/, "");
  return p || "";
}

/** Strippa il prefisso ingress dal path; ritorna path relativo a pi-web-ui */
function targetPath(url, base) {
  let p = url || "/";
  if (base && p.startsWith(base)) p = p.slice(base.length);
  return p === "" ? "/" : p;
}

/** Riscrive i path asset assoluti dell'HTML aggiungendo il prefisso ingress */
function rewriteHtml(bodyStr, ingressBase) {
  if (!ingressBase) return bodyStr;
  const base = ingressBase.replace(/^\//, ""); // senza slash iniziale
  return bodyStr
    .replace(/="\/(assets\/|favicon\.svg|manifest\.webmanifest|icons\/)/g, (m, p1) => `="/${base}/${p1}`)
    .replace(/='\/(assets\/|favicon\.svg)/g, (m, p1) => `='/${base}/${p1}`);
}

const server = http.createServer((req, res) => {
  const base = getIngressBase(req);
  const path = targetPath(req.url, base);
  const opts = {
    hostname: PI_WEB_UI_HOST,
    port: PI_WEB_UI_PORT,
    path,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${PI_WEB_UI_HOST}:${PI_WEB_UI_PORT}`,
      // Chiediamo sempre identity: se l'upstream comprime (gzip) non potremmo
      // riscrivere il body testuale in modo sicuro. Su LAN il costo è trascurabile.
      "accept-encoding": "identity",
      "x-forwarded-host": req.headers.host || "",
    },
  };
  // Header del client/ingress che non devono arrivare all'upstream.
  delete opts.headers["x-ingress-path"];

  const proxyReq = http.request(opts, (proxyRes) => {
    const ctype = (proxyRes.headers["content-type"] || "");
    const isHtml = /^text\/html/i.test(ctype) && proxyRes.statusCode !== 204;

    // Tutto ciò che non è HTML (JS, CSS, JSON, immagini, WS-adjacent) passa
    // invariato: content-length e content-encoding restano validi.
    if (!isHtml || !base) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    // Solo HTML con prefisso ingress: buffera, riscrivi gli asset, ricalcola
    // content-length (e togli gli header non più validi dopo la riscrittura).
    const chunks = [];
    let total = 0;
    proxyRes.on("data", (c) => { chunks.push(c); total += c.length; });
    proxyRes.on("end", () => {
      const body = Buffer.concat(chunks, total).toString("utf8");
      const rewritten = rewriteHtml(body, base);
      const headers = { ...proxyRes.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      delete headers["etag"];
      delete headers["accept-ranges"];
      headers["content-length"] = Buffer.byteLength(rewritten);
      res.writeHead(proxyRes.statusCode, headers);
      res.end(rewritten);
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[pi-web-addon proxy] ${err.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });

  req.pipe(proxyReq);
});

// WebSocket: handshake scritto a mano verso pi-web-ui (path stripped, key client
// originale, nessun ricalcolo accept), poi tunnel puro dei byte in entrambe le direzioni.
server.on("upgrade", (request, socket) => {
  const base = getIngressBase(request);
  const path = targetPath(request.url, base);
  try {
    const up = net.connect({ hostname: PI_WEB_UI_HOST, port: PI_WEB_UI_PORT });
    up.on("ready", () => {
      const hdrs = [
        `GET ${path} HTTP/1.1`,
        `Host: ${PI_WEB_UI_HOST}:${PI_WEB_UI_PORT}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        ...(
          ["Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions", "Origin", "User-Agent", "Cookie"]
            .filter((k) => request.headers[k.toLowerCase()])
            .map((k) => `${k}: ${request.headers[k.toLowerCase()]}`)
        ),
        "",
        "",
      ].join("\r\n");
      up.write(hdrs);
      // splice bidirezionale: i byte del 101 e dei frame passano intatti
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", (err) => {
      console.error(`[pi-web-addon proxy] WS: ${err.message}`);
      socket.destroy();
    });
  } catch (err) {
    console.error(`[pi-web-addon proxy] WS: ${err.message}`);
    socket.destroy();
  }
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`pi-web-addon proxy on :${LISTEN_PORT} -> ${PI_WEB_UI_HOST}:${PI_WEB_UI_PORT}`);
});
