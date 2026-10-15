const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/refreshAll\(\);\s*setInterval\(updatePositionAges, 60_000\);/, "");
const elements = {};
const ui = { console, document: {
  getElementById: id => elements[id] ||= {}, querySelectorAll: () => [],
} };
vm.createContext(ui);
vm.runInContext(script, ui);
const address = n => "0x" + String(n).padStart(40, "0");
const entry = (n, amount, collateral, debt) => ({ name: `wallet${n}`, address: address(n), amount,
  healthFactor: debt > 0 ? 3 : null, aaveCollateralUsd: collateral, aaveDebtUsd: debt,
  aaveAvailableBorrowUsd: 50 });
const group = (chain, wallets) => ({ chain, chainLabel: chain, symbol: chain === "bsc" ? "USDT" : "USDC", wallets });

test("one table row per wallet, including multiple networks and one aggregate row", () => {
  const groups = [group("arbitrum", [entry(1, 1, 100, 20), entry(2, 2, 200, 30)]),
    group("avalanche", [entry(1, 3, 300, 40)])];
  const positions = [{ address: address(1) }, { address: address(1) }];
  const model = ui.walletOverview(groups, positions);
  assert.equal(model.rows.length, 2);
  assert.equal(model.totals.balance, 6);
  assert.equal(model.totals.collateral, 600);
  assert.equal(model.totals.debt, 90);
  assert.equal(model.totals.positions, 2);
  const output = ui.renderWalletSection(groups, 84, positions);
  assert.equal((output.match(/class="wallet-record"/g) || []).length, 2);
  assert.equal((output.match(/<tfoot>/g) || []).length, 1);
  assert.ok(output.includes("600.00"));
  assert.ok(!output.includes("wallet-column"));
});

test("collateral without borrowing is included; zero is valid data", () => {
  const model = ui.walletOverview([group("arbitrum", [entry(1, 0, 200, 0)])], []);
  assert.equal(model.totals.balance, 0);
  assert.equal(model.totals.collateral, 200);
  assert.equal(model.totals.debt, 0);
  assert.ok(ui.renderWalletSection([group("arbitrum", [entry(1, 0, 200, 0)])], 84, []).includes("200.00"));
});

test("LP column shows total and positions outside the range per wallet and overall", () => {
  const groups = [group("arbitrum", [entry(1, 1, 100, 20), entry(2, 2, 200, 30)])];
  const positions = [{ address: address(1), inRange: true }, { address: address(1), inRange: false },
    { address: address(2), inRange: false }, { address: address(2), inRange: undefined }];
  const model = ui.walletOverview(groups, positions);
  assert.equal(model.rows[0].positionCount, 2);
  assert.equal(model.rows[0].inactiveCount, 1);
  assert.equal(model.totals.positions, 4);
  assert.equal(model.totals.inactive, 2);
  const output = ui.renderWalletSection(groups, 84, positions);
  assert.ok(output.includes("2 (1)"));
  assert.ok(output.includes("4 (2)"));
});

test("missing RPC data is not treated as zero in aggregates", () => {
  const wallet = entry(1, null, null, null);
  const groups = [group("arbitrum", [wallet])];
  const model = ui.walletOverview(groups, []);
  assert.equal(model.totals.balance, null);
  assert.equal(model.totals.collateral, null);
  assert.equal(model.totals.debt, null);
  assert.ok(ui.renderWalletSection(groups, 84, []).includes("—"));
  assert.equal(ui.walletOverview([], []).totals.balance, null);
});

test("LP totals are separate for Arbitrum, Avalanche and BSC on the same wallet", () => {
  const groups = [group("arbitrum", [entry(1, 0, 0, 0)]),
    group("avalanche", [entry(1, 0, 0, 0)]), group("bsc", [entry(1, 0, 0, 0)])];
  const positions = [{ address:address(1), chain:"arbitrum", inRange:true },
    { address:address(1), chain:"arbitrum", inRange:false },
    { address:address(1), chain:"avalanche", inRange:false },
    { address:address(1), chain:"bsc", inRange:true }];
  const model = ui.walletOverview(groups, positions);
  assert.equal(model.rows[0].balances[0].positionCount, 2);
  assert.equal(model.rows[0].balances[0].inactiveCount, 1);
  assert.equal(model.rows[0].balances[1].positionCount, 1);
  assert.equal(model.rows[0].balances[1].inactiveCount, 1);
  assert.equal(model.rows[0].balances[2].positionCount, 1);
  assert.equal(model.rows[0].balances[2].inactiveCount, 0);
  const output = ui.renderWalletSection(groups, 84, positions);
  for (const value of ["2 (1)", "1 (1)", "1 (0)", "4 (2)"]) assert.ok(output.includes(value));
  assert.ok(output.includes("bsc: всего LP"));
});

test("same address with different casing and duplicate chain do not double-count", () => {
  const first = entry(1, 2, 20, 5);
  const model = ui.walletOverview([group("arbitrum", [first, { ...first, amount: 3 }])], []);
  assert.equal(model.rows.length, 1);
  assert.equal(model.totals.balance, 3);
});

test("copy button uses the full wallet address", async () => {
  const fullAddress = address(1);
  const output = ui.renderWalletSection([group("arbitrum", [entry(1, 2, 20, 5)])], 84, []);
  assert.ok(output.includes(`data-address="${fullAddress}"`));
  let copied;
  ui.navigator = { clipboard: { writeText: async value => { copied = value; } } };
  ui.setTimeout = () => {};
  const button = { dataset: { address: fullAddress }, setAttribute() {} };
  await ui.copyWalletAddress(button);
  assert.equal(copied, fullAddress);
  assert.equal(button.title, "Адрес скопирован");
});

test("wallet names are escaped and 30-day income summary remains working", () => {
  const wallet = { ...entry(1, 2, 20, 5), name: "<script>" };
  const output = ui.renderWalletSection([group("arbitrum", [wallet])], 84, []);
  assert.ok(output.includes("&lt;script&gt;"));
  const days = Array.from({ length: 31 }, (_, n) => ({ date: "2026-10-13", incomeUsd: n === 30 ? 1000 : 2 }));
  ui.renderAll([], {}, [], {}, 84, days);
  assert.ok(elements.statDailyAverages.innerHTML.includes("$60.00"));
  assert.ok(!elements.statDailyAverages.innerHTML.includes("$1,060.00"));
  ui.renderAll([], {}, [], {}, 84, days, {
    totalUsd: 75, recordedDays: 28, firstRecordedDate: "2026-09-16",
  });
  assert.ok(elements.statDailyAverages.innerHTML.includes("$75.00*"));
  assert.ok(elements.statDailyAverages.innerHTML.includes("28 дней из 365"));
});
