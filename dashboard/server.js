const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectItems, readPosition, getPrices, valueInStable } = require("./lib");

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, "index.html");
const SNAPSHOT_FILE = path.join(__dirname, "snapshot.json");

const items = collectItems();
const byId = new Map(items.map((it) => [it.id, it]));

let snapshot = {};
if (fs.existsSync(SNAPSHOT_FILE)) {
  try {
    snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {}
}

function saveSnapshot() {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
}

function enrich(p) {
  let s = snapshot[p.id];
  if (!s) {
    s = { amt0: p.amt0, amt1: p.amt1, price: p.currentPrice };
    snapshot[p.id] = s;
  }
  const hodl = valueInStable(s.amt0, s.amt1, p.currentPrice, p.stableIs0);
  p.hodlUsd = hodl;
  p.ilUsd = p.valueUsd - hodl;
  p.ilPct = hodl > 0 ? (p.ilUsd / hodl) * 100 : 0;
  return p;
}

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
      const filtered = data.filter(Boolean);
      filtered.sort((a, b) => b.valueUsd - a.valueUsd);
      filtered.forEach(enrich);
      saveSnapshot();
      sendJson(res, 200, { positions: filtered, prices, updated: new Date().toISOString() });
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
      if (!data) { sendJson(res, 404, { error: "position closed" }); return; }
      enrich(data);
      saveSnapshot();
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
