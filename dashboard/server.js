const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS, collectItems, readPosition, getPrices, getWalletBalances, valueInStable } = require("./lib");

const PORT = process.env.PORT || 3000;
const INDEX_FILE = path.join(__dirname, "index.html");
const SNAPSHOT_FILE = path.join(__dirname, "snapshot.json");
const PRICE_CACHE_FILE = path.join(__dirname, "price-cache.json");
const INCOME_HISTORY_FILE = path.join(__dirname, "income-history.json");
const CHARTS = [
  {
    key: "btc",
    pair: "BTC/USDC",
    chain: "arbitrum",
    token: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", // WBTC
    stable: CHAINS.arbitrum.stableToken,
    fee: 500,
    color: "#f7931a",
  },
  { key: "eth", pair: "ETH/USDC", chain: "arbitrum", token: CHAINS.arbitrum.native, stable: CHAINS.arbitrum.stableToken, fee: 500, color: "#627eea" },
  { key: "avax", pair: "AVAX/USDC", chain: "avalanche", token: CHAINS.avalanche.native, stable: CHAINS.avalanche.stableToken, fee: 500, color: "#e84142" },
  { key: "bnb", pair: "BNB/USDT", chain: "bsc", token: CHAINS.bsc.native, stable: CHAINS.bsc.stableToken, fee: 100, color: "#f0b90b" },
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];
const POOL_ABI = [
  "function token0() view returns(address)",
  "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function observe(uint32[] secondsAgos) view returns(int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
];
const ERC20_ABI = ["function decimals() view returns(uint8)"];
const chartProviders = {};

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

let incomeHistory = { positions: {}, days: {} };
if (fs.existsSync(INCOME_HISTORY_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(INCOME_HISTORY_FILE, "utf8"));
    if (parsed && typeof parsed === "object") incomeHistory = {
      positions: parsed.positions || {},
      days: parsed.days || {},
    };
  } catch {}
}

function saveSnapshot() {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
}

function savePriceCache() {
  fs.writeFileSync(PRICE_CACHE_FILE, JSON.stringify(priceCache, null, 2));
}

function saveIncomeHistory() {
  fs.writeFileSync(INCOME_HISTORY_FILE, JSON.stringify(incomeHistory, null, 2));
}

function incomeDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tomsk", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function feeTokenValues(position) {
  const price = position.currentPrice;
  return {
    fee0UnitUsd: position.stableIs0 ? 1 : price,
    fee1UnitUsd: position.stableIs0 ? 1 / price : 1,
    cakeUnitUsd: position.cake?.amount ? position.cake.usd / position.cake.amount : 0,
  };
}

function recordIncome(positions) {
  const day = incomeDayKey();
  const entry = incomeHistory.days[day] ||= { incomeUsd: 0 };
  let changed = false;

  for (const position of positions) {
    const current = {
      fee0: position.fee0,
      fee1: position.fee1,
      cake: position.cake?.amount || 0,
      ...feeTokenValues(position),
    };
    const previous = incomeHistory.positions[position.id];
    let earned = 0;

    if (previous) {
      // A lower pending amount means that it was collected; only fees accrued
      // after that collection belong to the new balance.
      earned += (current.fee0 >= previous.fee0 ? current.fee0 - previous.fee0 : current.fee0) * current.fee0UnitUsd;
      earned += (current.fee1 >= previous.fee1 ? current.fee1 - previous.fee1 : current.fee1) * current.fee1UnitUsd;
      earned += (current.cake >= previous.cake ? current.cake - previous.cake : current.cake) * current.cakeUnitUsd;
      if (Number.isFinite(earned) && earned > 0) {
        entry.incomeUsd += earned;
        changed = true;
      }
    }
    incomeHistory.positions[position.id] = current;
    changed = true;
  }

  const keepAfter = new Date();
  keepAfter.setDate(keepAfter.getDate() - 30);
  const oldest = incomeDayKey(keepAfter);
  for (const key of Object.keys(incomeHistory.days)) {
    if (key < oldest) delete incomeHistory.days[key];
  }
  if (changed) saveIncomeHistory();
}

function incomeDays(count = 14) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - index);
    const key = incomeDayKey(date);
    return { date: key, incomeUsd: incomeHistory.days[key]?.incomeUsd || 0 };
  });
}

function chartProvider(chain) {
  if (!chartProviders[chain]) chartProviders[chain] = new ethers.JsonRpcProvider(CHAINS[chain].rpc);
  return chartProviders[chain];
}

async function readDexSpot(chart) {
  const chain = CHAINS[chart.chain];
  const p = chartProvider(chart.chain);
  const factory = new ethers.Contract(chain.factory, FACTORY_ABI, p);
  const poolAddress = await factory.getPool(chart.token, chart.stable, chart.fee);
  if (poolAddress === ethers.ZeroAddress) throw new Error("пул не найден");

  const pool = new ethers.Contract(poolAddress, POOL_ABI, p);
  const [token0, slot0] = await Promise.all([pool.token0(), pool.slot0()]);
  const token1 = token0.toLowerCase() === chart.token.toLowerCase() ? chart.stable : chart.token;
  const [dec0, dec1] = await Promise.all([
    new ethers.Contract(token0, ERC20_ABI, p).decimals(),
    new ethers.Contract(token1, ERC20_ABI, p).decimals(),
  ]);
  const token1PerToken0 = (Number(slot0.sqrtPriceX96) / 2 ** 96) ** 2 * Math.pow(10, Number(dec0) - Number(dec1));
  return token0.toLowerCase() === chart.token.toLowerCase() ? token1PerToken0 : 1 / token1PerToken0;
}

async function refreshChartSpots(charts) {
  await Promise.all(CHARTS.map(async (chart) => {
    try {
      const points = charts[chart.key]?.prices;
      const price = await readDexSpot(chart);
      if (points?.length && Number.isFinite(price) && price > 0) points[points.length - 1] = [Date.now(), price];
    } catch {
      // Keep the latest cached point if the RPC is temporarily unavailable.
    }
  }));
}

async function readDexChart(chart) {
  const chain = CHAINS[chart.chain];
  const p = chartProvider(chart.chain);
  const factory = new ethers.Contract(chain.factory, FACTORY_ABI, p);
  const poolAddress = await factory.getPool(chart.token, chart.stable, chart.fee);
  if (poolAddress === ethers.ZeroAddress) throw new Error("пул не найден");

  const pool = new ethers.Contract(poolAddress, POOL_ABI, p);
  const [token0, latestBlock, slot0] = await Promise.all([pool.token0(), p.getBlock("latest"), pool.slot0()]);
  const token1 = token0.toLowerCase() === chart.token.toLowerCase() ? chart.stable : chart.token;
  const [dec0, dec1] = await Promise.all([
    new ethers.Contract(token0, ERC20_ABI, p).decimals(),
    new ethers.Contract(token1, ERC20_ABI, p).decimals(),
  ]);
  let historySeconds = 86_400;
  while (historySeconds >= 60) {
    try {
      await pool.observe([historySeconds, 0]);
      break;
    } catch {
      historySeconds = Math.floor(historySeconds / 2);
    }
  }
  if (historySeconds < 60) return { pair: chart.pair, color: chart.color, prices: [], durationHours: null };

  // Some pools retain less than 24 hours of observations. Use their full available
  // history rather than falling back to an unrelated market-price feed.
  const pointCount = Math.max(2, Math.min(25, Math.floor(historySeconds / 3_600) + 1));
  const secondsAgos = Array.from(
    { length: pointCount },
    (_, index) => Math.round(historySeconds * (pointCount - index - 1) / (pointCount - 1)),
  );
  const [tickCumulatives] = await pool.observe(secondsAgos);
  const tokenIs0 = token0.toLowerCase() === chart.token.toLowerCase();
  const now = Number(latestBlock.timestamp) * 1000;
  const prices = [];

  for (let index = 0; index < tickCumulatives.length - 1; index += 1) {
    const intervalSeconds = secondsAgos[index] - secondsAgos[index + 1];
    const averageTick = Number(tickCumulatives[index + 1] - tickCumulatives[index]) / intervalSeconds;
    const token1PerToken0 = Math.pow(1.0001, averageTick) * Math.pow(10, Number(dec0) - Number(dec1));
    const price = tokenIs0 ? token1PerToken0 : 1 / token1PerToken0;
    if (Number.isFinite(price) && price > 0) prices.push([now - secondsAgos[index + 1] * 1_000, price]);
  }
  const spotToken1PerToken0 = (Number(slot0.sqrtPriceX96) / 2 ** 96) ** 2 * Math.pow(10, Number(dec0) - Number(dec1));
  const spotPrice = tokenIs0 ? spotToken1PerToken0 : 1 / spotToken1PerToken0;
  if (prices.length === 1) prices.unshift([now - historySeconds * 1_000, prices[0][1]]);
  if (prices.length && Number.isFinite(spotPrice) && spotPrice > 0) prices[prices.length - 1] = [now, spotPrice];
  return { pair: chart.pair, color: chart.color, prices, durationHours: historySeconds / 3_600 };
}

async function getMarketData() {
  if (priceCache?.source === "dex-twap-v3" && priceCache.updated && Date.now() - priceCache.updated < 15 * 60 * 1000 && Number.isFinite(priceCache.rubPerUsd)) {
    await refreshChartSpots(priceCache.charts);
    return { charts: priceCache.charts, rubPerUsd: priceCache.rubPerUsd };
  }

  const [entries, rubPerUsd] = await Promise.all([
    Promise.all(CHARTS.map(async (chart) => {
      try {
        return [chart.key, await readDexChart(chart)];
      } catch {
        return [chart.key, { pair: chart.pair, color: chart.color, prices: [] }];
      }
    })),
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=rub", {
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`CoinGecko ${response.status}`);
        const data = await response.json();
        return Number(data["usd-coin"]?.rub);
      })
      .catch(() => null),
  ]);

  priceCache = { source: "dex-twap-v3", updated: Date.now(), charts: Object.fromEntries(entries), rubPerUsd };
  savePriceCache();
  return { charts: priceCache.charts, rubPerUsd };
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
      const [data, prices, wallets, marketData] = await Promise.all([
        Promise.all(items.map((it) => readPosition(it))),
        getPrices(),
        getWalletBalances(),
        getMarketData(),
      ]);
      const filtered = data.filter(Boolean);
      filtered.sort((a, b) => Number(b.inRange) - Number(a.inRange) || b.valueUsd - a.valueUsd);
      filtered.forEach(enrich);
      recordIncome(filtered);
      saveSnapshot();
      sendJson(res, 200, {
        positions: filtered,
        prices,
        wallets,
        charts: marketData.charts,
        rubPerUsd: marketData.rubPerUsd,
        incomeDays: incomeDays(),
        updated: new Date().toISOString(),
      });
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
