/**
 * Pi Web Addon proxy — HTTP e WebSocket forward per ingress Home Assistant.
 * Ascolta su :3000 (ingress_port dell'add-on), inoltra a pi-web-ui su 127.0.0.1:8888.
 * Strippa il prefisso ingress (X-Ingress-Path) dal path in ingresso e riscrive
 * i riferimenti assoluti (src/href, /api/, /ws) nei body HTML/JS con quel prefisso.
 * Stesso pattern di /data/pi-web-proxy.mjs (già integrato nel server pi-web-ui).
 */

import http from "node:http";
import net from "node:net";

const PI_WEB_UI_PORT = 8888;
const PI_WEB_UI_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 3000);

const TEXT_TYPES = /^text\/(html|css|javascript|x-javascript|plain)|^application\/(json|javascript|x-javascript)/;

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

/** Riscrive i path assoluti della UI aggiungendo il prefisso ingress */
function rewriteBody(bodyStr, ingressBase) {
  if (!ingressBase) return bodyStr;
  const base = ingressBase.replace(/^\//, ""); // senza slash iniziale
  // Ordine importante: prima /api/ e /ws (altrimenti matchherebbero il prefisso appena inserito)
  let s = bodyStr
    .replace(/(["'`])\/api\//g, (m, q) => `${q}/${base}/api/`)
    .replace(/(["'`])\/ws(["'`])/g, (m, q1, q2) => `${q1}/${base}/ws${q2}`);
  return s
    .replace(/="\/(assets\/|favicon\.svg|manifest\.webmanifest|icons\/)/g, (m, p1) => `="/${base}/${p1}`)
    .replace(/'\/(assets\/|favicon\.svg)/g, (m, p1) => `'/${base}/${p1}`);
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
      "x-forwarded-prefix": base,
      "x-forwarded-host": req.headers.host || "",
    },
  };
  delete opts.headers["x-ingress-path"];
  delete opts.headers["x-forwarded-prefix"];

  const proxyReq = http.request(opts, (proxyRes) => {
    const ctype = (proxyRes.headers["content-type"] || "");
    const isText = TEXT_TYPES.test(ctype) && proxyRes.statusCode !== 204;
    if (!isText || !base) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }
    // Body testuale con prefisso ingress → raccogli, riscrivi, invia
    const chunks = [];
    let total = 0;
    proxyRes.on("data", (c) => { chunks.push(c); total += c.length; });
    proxyRes.on("end", () => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      const body = Buffer.concat(chunks, total).toString("utf8");
      res.write(rewriteBody(body, base));
      res.end();
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
  console.log(`[pi-web-addon proxy] upgrade url="${request.url}" base="${base}" hkeys=${Object.keys(request.headers).join(",")}`);
  const path = targetPath(request.url, base);
  try {
    const up = net.connect({ hostname: PI_WEB_UI_HOST, port: PI_WEB_UI_PORT, remoteAddress: "127.0.0.1" });
    up.on("ready", () => {
      console.log(`[pi-web-addon proxy] WS ready, sending handshake to ${path}`);
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