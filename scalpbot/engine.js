const DEFAULTS = Object.freeze({
  capital: 100, tradeUsd: 25, pollSeconds: 10, candleSeconds: 60,
  takeProfitPct: 0.8, stopLossPct: 0.5, maxHoldMinutes: 60,
  cooldownMinutes: 15, maxDailyLossUsd: 3, maxDailyTrades: 3,
  gasUsdPerSwap: 0.03, executionBufferBps: 10, maxRoundTripCostPct: 0.6,
});

function validateConfig(c) {
  for (const key of Object.keys(DEFAULTS)) {
    if (!Number.isFinite(c[key]) || c[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  for (const key of ["pollSeconds", "candleSeconds", "maxDailyTrades"]) {
    if (!Number.isInteger(c[key])) throw new Error(`${key} must be an integer`);
  }
  if (c.tradeUsd + c.gasUsdPerSwap > c.capital) throw new Error("Trade exceeds capital");
  if (c.pollSeconds > c.candleSeconds) throw new Error("Polling exceeds candle interval");
  if (c.executionBufferBps >= 10000 || c.stopLossPct >= 100) throw new Error("Invalid risk limit");
  if (c.maxRoundTripCostPct >= c.takeProfitPct) throw new Error("Costs must be below profit target");
}

function ema(values, period) {
  if (values.length < period) return null;
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const alpha = 2 / (period + 1);
  for (const value of values.slice(period)) result += alpha * (value - result);
  return result;
}

function indicators(candles) {
  if (candles.length < 51) return null;
  const closes = candles.map(c => c.close);
  const recent = candles.slice(-15);
  let gain = 0, loss = 0, tr = 0;
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].close - recent[i - 1].close;
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
    tr += Math.max(recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close));
  }
  return {
    ema20: ema(closes, 20), ema50: ema(closes, 50),
    previousEma20: ema(closes.slice(0, -1), 20),
    rsi14: gain + loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss),
    sampledAtrPct: tr / 14 / closes.at(-1) * 100,
  };
}

function entrySignal(candles) {
  const i = indicators(candles);
  if (!i) return { enter: false, reason: "warming_up" };
  const previous = candles.at(-2), current = candles.at(-1);
  const enter = i.ema20 > i.ema50 && previous.close <= i.previousEma20
    && current.close > i.ema20 && current.close > current.open
    && i.rsi14 >= 45 && i.rsi14 <= 65
    && i.sampledAtrPct >= 0.05 && i.sampledAtrPct <= 2;
  return { enter, reason: enter ? "trend_pullback" : "no_signal", ...i };
}

function createState(config) {
  validateConfig(config);
  return { version: 1, config: { ...config }, cash: config.capital, position: null,
    candles: [], currentCandle: null, lastSample: null, lastDecisionBucket: null,
    cooldownUntil: 0, daily: {}, trades: [], samples: 0 };
}

function validateState(s, config) {
  if (s.version !== 1 || JSON.stringify(s.config) !== JSON.stringify(config)) {
    throw new Error("State/config mismatch. Use another --state path for a new experiment.");
  }
  if (!Number.isFinite(s.cash) || s.cash < 0 || !Array.isArray(s.candles)
    || !Array.isArray(s.trades) || !s.daily || typeof s.daily !== "object"
    || !Number.isFinite(s.cooldownUntil) || !Number.isInteger(s.samples)) {
    throw new Error("Invalid paper state; refusing to reset capital");
  }
  const validCandle = c => Number.isInteger(c.bucket)
    && [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0);
  if (!s.candles.every(validCandle) || (s.currentCandle && !validCandle(s.currentCandle))) {
    throw new Error("Invalid candle history");
  }
  if (s.lastSample && (!Number.isInteger(s.lastSample.block)
    || !Number.isFinite(s.lastSample.time))) throw new Error("Invalid sample state");
  if (s.position && (![s.position.eth, s.position.cost, s.position.openedAt]
    .every(v => Number.isFinite(v) && v > 0) || !/^\d+$/.test(s.position.ethRaw))) {
    throw new Error("Invalid paper position");
  }
}

// Candles represent observed pool samples, not full trade-by-trade exchange OHLC.
function ingest(s, sample) {
  if (![sample.price, sample.time].every(v => Number.isFinite(v) && v > 0)
    || !Number.isInteger(sample.block)) throw new Error("Invalid pool sample");
  if (s.lastSample && (sample.block <= s.lastSample.block || sample.time <= s.lastSample.time)) {
    return { accepted: false, closed: false, gap: false };
  }
  const c = s.config;
  const bucket = Math.floor(sample.time / c.candleSeconds) * c.candleSeconds;
  const gap = !!s.lastSample && sample.time - s.lastSample.time > Math.max(c.pollSeconds * 3, 30);
  let closed = false;
  if (gap) {
    s.candles = [];
    s.currentCandle = null;
  }
  if (s.currentCandle && bucket !== s.currentCandle.bucket) {
    s.candles.push(s.currentCandle);
    s.candles = s.candles.slice(-300);
    closed = true;
    s.currentCandle = null;
  }
  if (!s.currentCandle) {
    s.currentCandle = { bucket, open: sample.price, high: sample.price,
      low: sample.price, close: sample.price };
  } else {
    s.currentCandle.high = Math.max(s.currentCandle.high, sample.price);
    s.currentCandle.low = Math.min(s.currentCandle.low, sample.price);
    s.currentCandle.close = sample.price;
  }
  s.lastSample = { block: sample.block, time: sample.time };
  s.samples++;
  return { accepted: true, closed, gap };
}

function dayKey(time) { return new Date(time * 1000).toISOString().slice(0, 10); }
function day(s, time) {
  const key = dayKey(time);
  return s.daily[key] ||= { pnl: 0, entries: 0 };
}

function canEnter(s, time) {
  const d = day(s, time), c = s.config;
  return !s.position && time >= s.cooldownUntil && d.pnl > -c.maxDailyLossUsd
    && d.entries < c.maxDailyTrades && s.cash >= c.tradeUsd + c.gasUsdPerSwap;
}

function netSale(s, quoteUsdc) {
  return quoteUsdc * (1 - s.config.executionBufferBps / 10000) - s.config.gasUsdPerSwap;
}

function roundTripCostPct(s, buyBackQuoteUsdc) {
  return (1 - netSale(s, buyBackQuoteUsdc) / (s.config.tradeUsd + s.config.gasUsdPerSwap)) * 100;
}

function openPosition(s, time, ethRaw, eth) {
  if (!canEnter(s, time) || !Number.isFinite(eth) || eth <= 0 || !/^\d+$/.test(ethRaw)) {
    throw new Error("Paper entry rejected");
  }
  const cost = s.config.tradeUsd + s.config.gasUsdPerSwap;
  s.cash -= cost;
  s.position = { ethRaw, eth, cost, openedAt: time };
  day(s, time).entries++;
}

function exitReason(s, time, quoteUsdc) {
  if (!s.position) return null;
  const pnlPct = (netSale(s, quoteUsdc) / s.position.cost - 1) * 100;
  if (pnlPct <= -s.config.stopLossPct) return "stop_loss";
  if (pnlPct >= s.config.takeProfitPct) return "take_profit";
  if (time - s.position.openedAt >= s.config.maxHoldMinutes * 60) return "time_limit";
  const d = day(s, time);
  if (d.pnl + netSale(s, quoteUsdc) - s.position.cost <= -s.config.maxDailyLossUsd) return "daily_loss";
  return null;
}

function closePosition(s, time, quoteUsdc, reason) {
  if (!s.position || !Number.isFinite(quoteUsdc) || quoteUsdc <= 0) throw new Error("Invalid paper exit");
  const proceeds = netSale(s, quoteUsdc);
  const trade = { ...s.position, closedAt: time, proceeds, pnl: proceeds - s.position.cost, reason };
  s.cash += proceeds;
  day(s, time).pnl += trade.pnl;
  s.trades.push(trade);
  s.position = null;
  s.cooldownUntil = time + s.config.cooldownMinutes * 60;
  return trade;
}

module.exports = { DEFAULTS, validateConfig, createState, validateState, ema, indicators,
  entrySignal, ingest, canEnter, netSale, roundTripCostPct, openPosition, exitReason, closePosition };
