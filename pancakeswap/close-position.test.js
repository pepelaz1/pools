const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { closingSummary } = require("./close-position");
const usdt = value => ethers.parseUnits(value, 18);

test("closing summary excludes pre-existing wallet USDT and reports gain and percentage", () => {
  const lines = closingSummary({ valueUsd:300 }, usdt("100"), usdt("402"));
  assert.ok(lines[0].includes("302.0 USDT"));
  assert.ok(lines[1].includes("$300.00"));
  assert.ok(lines[2].includes("+$2.0000 (+0.67%)"));
});

test("closing summary reports loss and handles missing entry value", () => {
  assert.ok(closingSummary({ valueUsd:300 }, 0n, usdt("290"))[2].includes("-$10.0000 (-3.33%)"));
  for (const opened of [undefined, {}, { valueUsd:null }, { valueUsd:"invalid" }]) {
    const lines = closingSummary(opened, 0n, usdt("290"));
    assert.ok(lines.at(-1).includes("нет исходной стоимости"));
  }
});

test("closing in BNB or incomplete conversion does not fabricate a dollar loss", () => {
  const bnb = closingSummary({ valueUsd:300 }, usdt("100"), 0n, { keepBnb:true });
  assert.ok(bnb.at(-1).includes("закрыта в BNB"));
  assert.ok(!bnb.some(line => line.includes("-$300")));
  const incomplete = closingSummary({ valueUsd:300 }, 0n, usdt("10"), { complete:false });
  assert.ok(incomplete.at(-1).includes("не подтверждена полная конвертация"));
});
