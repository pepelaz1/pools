const http = require("http");
const fs = require("fs");
const path = require("path");
const { collectItems, readPosition, getPrices, getWalletBalances, valueInStable } = require("./lib");

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, "index.html");
const SNAPSHOT_FILE = path.join(__dirname, "snapshot.json");
const PRICE_CACHE_FILE = path.join(__dirname, "price-cache.json");
const CHARTS = {
  eth: { pair: "ETH/USDC", coin: "ethereum", color: "#627eea" },
  avax: { pair: "AVAX/USDC", coin: "avalanche-2", color: "#e84142" },
  bnb: { pair: "BNB/USDT", coin: "binancecoin", color: "#f0b90b" },
};

let snapshot = {};
if (fs.existsSync(SNAPSHOT_FILE)) {
  try {
    snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {}
}

let priceCache = null;
if (fs.existsSync(PRICE_CACHE_FILE)) {
  try {
    priceCache = JSON.parse(fs.readFileSync(PRICE_CACHE_FILE, "utf8"));
  } catch {}
}

function saveSnapshot() {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
}

function savePriceCache() {
  fs.writeFileSync(PRICE_CACHE_FILE, JSON.stringify(priceCache, null, 2));
}

async function getCharts() {
  if (priceCache?.updated && Date.now() - priceCache.updated < 15 * 60 * 1000) return priceCache.charts;

  const entries = await Promise.all(Object.entries(CHARTS).map(async ([key, chart]) => {
    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/coins/${chart.coin}/market_chart?vs_currency=usd&days=1&interval=hourly`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(`CoinGecko ${response.status}`);
      const data = await response.json();
      return [key, { pair: chart.pair, color: chart.color, prices: data.prices || [] }];
    } catch {
      return [key, { pair: chart.pair, color: chart.color, prices: [] }];
    }
  }));

  priceCache = { updated: Date.now(), charts: Object.fromEntries(entries) };
  savePriceCache();
  return priceCache.charts;
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
      const items = collectItems();
      const [data, prices, wallets, charts] = await Promise.all([
        Promise.all(items.map((it) => readPosition(it))),
        getPrices(),
        getWalletBalances(),
        getCharts(),
      ]);
      const filtered = data.filter(Boolean);
      filtered.sort((a, b) => Number(b.inRange) - Number(a.inRange) || b.valueUsd - a.valueUsd);
      filtered.forEach(enrich);
      saveSnapshot();
      sendJson(res, 200, { positions: filtered, prices, wallets, charts, updated: new Date().toISOString() });
    } catch (e) {
      sendJson(res, 500, { error: e.shortMessage || e.message });
    }
    return;
  }

  if (url.pathname.startsWith("/api/positions/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/positions/".length));
    const item = collectItems().find((candidate) => candidate.id === id);
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
  console.log(`Dashboard: http://localhost:${PORT}  (${collectItems().length} позиций)`);
});
