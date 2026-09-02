const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectItems, readPosition, getPrices } = require("./lib");

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, "index.html");

const items = collectItems();
const byId = new Map(items.map((it) => [it.id, it]));

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/positions") {
    try {
      const [data, prices] = await Promise.all([
        Promise.all(items.map((it) => readPosition(it))),
        getPrices(),
      ]);
      data.sort((a, b) => b.valueUsd - a.valueUsd);
      sendJson(res, 200, { positions: data, prices, updated: new Date().toISOString() });
    } catch (e) {
      sendJson(res, 500, { error: e.shortMessage || e.message });
    }
    return;
  }

  if (url.pathname.startsWith("/api/positions/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/positions/".length));
    const item = byId.get(id);
    if (!item) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      const data = await readPosition(item);
      sendJson(res, 200, { position: data, updated: new Date().toISOString() });
    } catch (e) {
      sendJson(res, 500, { error: e.shortMessage || e.message });
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    fs.readFile(INDEX_FILE, (err, html) => {
      if (err) {
        res.writeHead(500);
        res.end("index.html not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}  (${items.length} позиций)`);
});
