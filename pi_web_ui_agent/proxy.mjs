/**
 * Pi Web Addon proxy — HTTP e WebSocket forward per ingress Home Assistant.
 * Ascolta su :3000 (ingress_port dell'add-on), inoltra a pi-web-ui su 127.0.0.1:8888.
 *
 * Come funziona l'ingress nelle versioni recenti di HA Supervisor:
 *   - L'add-on viene aperto via iframe su /api/hassio_ingress/{token}/.
 *   - Il Supervisor spoglia già il prefisso /api/hassio_ingress/{token} e
 *     inoltra la richiesta alla RADICE dell'add-on (es. GET /, /assets/..., /ws).
 *   - NON viene inviato alcun header X-Ingress-Path: l'add-on non può conoscere
 *     il prefisso. (Legacy X-Ingress-Path è comunque gestito per compatibilità.)
 *
 * Conseguenza importante (pi-web-ui v0.76.0):
 *   - Il frontend calcola il base path a runtime da document.baseURI e lo applica
 *     da solo a /ws, /api/* e alla registrazione del service worker. NON va quindi
 *     riscritto nulla in questi URL.
 *   - L'index.html usa però path asset ASSOLUTI (/assets/..., /favicon.svg): dietro
 *     ingress il browser li risolverebbe sulla radice dell'host (sbagliato).
 *     Li rendiamo RELATIVI (./assets/...), così funzionano con qualunque prefisso.
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

/** Strippa il prefisso ingress (solo se presente) dal path in ingresso. */
function targetPath(url, base) {
  let p = url || "/";
  if (base && p.startsWith(base)) p = p.slice(base.length);
  return p === "" ? "/" : p;
}

/** Rende relativi i path asset assoluti dell'HTML, così funzionano dietro
 *  qualunque prefisso ingress (anche a sessione, dove il prefisso non è noto). */
function rewriteHtml(bodyStr) {
  return bodyStr
    .replace(/(src|href)="\/(assets\/|favicon\.svg|manifest\.webmanifest|icons\/)/g, (m, attr, p1) => `${attr}="./${p1}`)
    .replace(/(src|href)='\/(assets\/|favicon\.svg)/g, (m, attr, p1) => `${attr}='./${p1}`);
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
      // IMPORTANTE: NON sovrascrivere `host` con 127.0.0.1:8888. pi-web-ui
      // valida l'ammissione WebSocket confrontando l'Origin del browser con
      // l'header Host ricevuto; sovrascrivendolo i due non coinciderebbero e
      // il server rifiuterebbe l'upgrade con 403 (schermata nera).
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

    // Tutto ciò che non è HTML (JS, CSS, JSON, immagini, WS) passa invariato:
    // content-length e content-encoding restano validi.
    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    // Solo HTML: buffera, rendi relativi gli asset, ricalcola content-length
    // (e togli gli header non più validi dopo la riscrittura).
    const chunks = [];
    let total = 0;
    proxyRes.on("data", (c) => { chunks.push(c); total += c.length; });
    proxyRes.on("end", () => {
      const body = Buffer.concat(chunks, total).toString("utf8");
      const rewritten = rewriteHtml(body);
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
        // Preserva l'Host originale del browser: pi-web-ui lo confronta con
        // l'Origin per ammettere l'upgrade WebSocket (stessa autorità).
        `Host: ${request.headers.host || `${PI_WEB_UI_HOST}:${PI_WEB_UI_PORT}`}`,
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
