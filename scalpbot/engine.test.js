const test = require("node:test");
const assert = require("node:assert/strict");
const e = require("./engine");
const { args } = require("./bot");
const state = (overrides = {}) => e.createState({ ...e.DEFAULTS, ...overrides });

test("config and CLI reject unsafe/unknown values", () => {
  assert.throws(() => state({ tradeUsd: 101 }));
  assert.throws(() => state({ pollSeconds: 0 }));
  assert.throws(() => args(["--live"]));
  assert.throws(() => args(["--trade-usd", "NaN"]));
  assert.equal(args(["--once"]).once, true);
});

test("EMA seeds with SMA and signal waits for closed candle history", () => {
  assert.equal(e.ema([1, 2, 3], 3), 2);
  assert.equal(e.ema([1, 2, 3, 4], 3), 3);
  assert.equal(e.entrySignal([]).reason, "warming_up");
});

test("duplicate blocks do not trade or change candles", () => {
  const s = state();
  e.ingest(s, { block: 1, time: 120, price: 2000 });
  assert.equal(e.ingest(s, { block: 1, time: 120, price: 2100 }).accepted, false);
  assert.equal(s.currentCandle.close, 2000);
  assert.equal(s.samples, 1);
});

test("candle closes only in next bucket; gaps invalidate warmup", () => {
  const s = state();
  for (const [block, time, price] of [[1, 120, 2000], [2, 140, 2010], [3, 160, 1990]]) {
    assert.equal(e.ingest(s, { block, time, price }).closed, false);
  }
  assert.equal(e.ingest(s, { block: 4, time: 180, price: 2001 }).closed, true);
  assert.deepEqual(s.candles[0], { bucket: 120, open: 2000, high: 2010, low: 1990, close: 1990 });
  assert.equal(e.ingest(s, { block: 5, time: 300, price: 2005 }).gap, true);
  assert.equal(s.candles.length, 0);
});

test("net profit includes entry and exit gas and execution buffer", () => {
  const s = state();
  e.openPosition(s, 1000, "10000000000000000", 0.01);
  assert.equal(s.cash, 74.97);
  assert.equal(e.exitReason(s, 1010, 25), null);
  assert.equal(e.exitReason(s, 1010, 26), "take_profit");
  const trade = e.closePosition(s, 1010, 26, "take_profit");
  assert.ok(Math.abs(trade.pnl - 0.914) < 1e-9);
  assert.ok(Math.abs(s.cash - 100.914) < 1e-9);
  assert.equal(e.canEnter(s, 1100), false);
  assert.equal(e.canEnter(s, 2000), true);
});

test("stop and timeout work; daily limit blocks entry but not exit", () => {
  const s = state();
  e.openPosition(s, 1000, "10000000000000000", 0.01);
  assert.equal(e.exitReason(s, 1010, 24), "stop_loss");
  assert.equal(e.exitReason(s, 5000, 25), "time_limit");
  e.closePosition(s, 1010, 20, "stop_loss");
  assert.equal(e.canEnter(s, 10000), false);
  assert.equal(e.canEnter(s, 86401), true);
});

test("entry count is bounded each UTC day", () => {
  const s = state({ maxDailyTrades: 1 });
  e.openPosition(s, 1000, "10000000000000000", 0.01);
  e.closePosition(s, 1010, 25, "manual_test");
  assert.equal(e.canEnter(s, 10000), false);
  assert.equal(e.canEnter(s, 86401), true);
});

test("round trip model does not charge pool fee a second time", () => {
  const s = state();
  const expected = (1 - (25 * 0.999 - 0.03) / 25.03) * 100;
  assert.equal(e.roundTripCostPct(s, 25), expected);
});

test("default cost filter allows modeled small trade but rejects expensive execution", () => {
  const s = state();
  const roundTrip = 25 * 0.9995 * 0.999 * 0.9995;
  assert.ok(e.roundTripCostPct(s, roundTrip) < s.config.maxRoundTripCostPct);
  assert.ok(e.roundTripCostPct(s, 24.5) > s.config.maxRoundTripCostPct);
});

test("restart preserves open position and rejects changed experiment config", () => {
  const s = state();
  e.openPosition(s, 1000, "10000000000000000", 0.01);
  const resumed = JSON.parse(JSON.stringify(s));
  e.validateState(resumed, { ...e.DEFAULTS });
  assert.equal(resumed.position.eth, 0.01);
  assert.throws(() => e.validateState(resumed, { ...e.DEFAULTS, tradeUsd: 30 }));
  resumed.cash = -1;
  assert.throws(() => e.validateState(resumed, { ...e.DEFAULTS }));
});

test("flat prices have finite indicators and do not create entry", () => {
  const candles = Array.from({ length: 60 }, (_, n) => ({
    bucket: n * 60, open: 2000, high: 2000, low: 2000, close: 2000,
  }));
  assert.equal(e.indicators(candles).rsi14, 50);
  assert.equal(e.entrySignal(candles).enter, false);
});
