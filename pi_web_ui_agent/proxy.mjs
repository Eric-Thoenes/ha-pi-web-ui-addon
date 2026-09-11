/**
 * Pi Web Addon proxy — HTTP e WebSocket forward per ingress Home Assistant.
 *
 * Ingress moderno (a sessione): /api/hassio_ingress/{token}/ → Supervisor
 * spoglia il prefisso e inoltra alla radice dell'add-on (no X-Ingress-Path).
 *
 * Pi Web UI v0.76.0: il frontend calcola il base path da document.baseURI.
 * Solo gli asset statici nell'HTML vanno resi relativi (./assets/...).
 * Il service worker deve forwardare il WebSocket con respondWith() altrimenti
 * Chrome/Edge abbattono la connessione WS (bug noto SW/#2104).
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

function targetPath(url, base) {
  let p = url || "/";
  if (base && p.startsWith(base)) p = p.slice(base.length);
  return p === "" ? "/" : p;
}

function rewriteHtml(bodyStr) {
  return bodyStr
    .replace(/(src|href)="\/(assets\/|favicon\.svg|manifest\.webmanifest|icons\/)/g, (m, attr, p1) => `${attr}="./${p1}`)
    .replace(/(src|href)='\/(assets\/|favicon\.svg)/g, (m, attr, p1) => `${attr}='./${p1}`);
}

// ── Service worker minimale ─────────────────────────────────────
// Chrome/Edge abbattono le connessioni WS quando lo SW ha un fetch handler
// che intercetta la richiesta ma non chiama respondWith(). Il SW originale
// di pi-web-ui fa questo per tutte le richieste non cacheabili (WS / API).
// Qui serviamo uno SW minimale SENZA fetch handler, così la WS passa
// inalterata. I notification click non funzioneranno, ma l'app sì.
const MINIMAL_SW = `
// pi-web-ui SW stub — nessun fetch handler (Chrome WS compat)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
`.trim();

// ── Server HTTP ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const base = getIngressBase(req);
  const path = targetPath(req.url, base);

  // /sw.js → serve service worker MINIMALE (nessun fetch handler)
  // per evitare che Chrome/Edge abbattono le WS.
  if (path === "/sw.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=UTF-8",
      "Content-Length": Buffer.byteLength(MINIMAL_SW),
      "Cache-Control": "no-cache",
    });
    res.end(MINIMAL_SW);
    return;
  }

  // Tutte le altre richieste → proxy a pi-web-ui
  const opts = {
    hostname: PI_WEB_UI_HOST,
    port: PI_WEB_UI_PORT,
    path,
    method: req.method,
    headers: {
      ...req.headers,
      "accept-encoding": "identity",
      "x-forwarded-host": req.headers.host || "",
    },
  };
  delete opts.headers["x-ingress-path"];

  const proxyReq = http.request(opts, (proxyRes) => {
    const ctype = (proxyRes.headers["content-type"] || "").toLowerCase();
    const isHtml = ctype.startsWith("text/html") && proxyRes.statusCode !== 204;

    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

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
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });

  req.pipe(proxyReq);
});

// ── WebSocket ────────────────────────────────────────────────────
server.on("upgrade", (request, socket) => {
  const base = getIngressBase(request);
  const path = targetPath(request.url, base);
  try {
    const up = net.connect({ hostname: PI_WEB_UI_HOST, port: PI_WEB_UI_PORT });
    up.on("ready", () => {
      const hdrs = [
        `GET ${path} HTTP/1.1`,
        `Host: ${request.headers.host || `${PI_WEB_UI_HOST}:${PI_WEB_UI_PORT}`}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        ...(
          ["Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Extensions", "User-Agent", "Cookie"]
            .filter((k) => request.headers[k.toLowerCase()])
            .map((k) => `${k}: ${request.headers[k.toLowerCase()]}`)
        ),
        "",
        "",
      ].join("\r\n");
      up.write(hdrs);
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