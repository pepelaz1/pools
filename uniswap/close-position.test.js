const test = require("node:test");
const assert = require("node:assert/strict");
const { closeComparison } = require("./close-position");

test("closing comparison uses the stored opening value including top-ups", () => {
  const result = closeComparison({ valueUsd: 249.75 }, 250772901n, 6);
  assert.equal(result.initialUsd, 249.75);
  assert.ok(Math.abs(result.differenceUsd - 1.022901) < 1e-9);
  assert.ok(Math.abs(result.differencePct - (1.022901 / 249.75 * 100)) < 1e-9);
});

test("closing comparison reports losses without treating missing cost basis as zero", () => {
  const loss = closeComparison({ valueUsd: 300 }, 250000000n, 6);
  assert.equal(loss.differenceUsd, -50);
  assert.equal(loss.differencePct, -50 / 300 * 100);
  for (const opened of [undefined, {}, { valueUsd: null }, { valueUsd: "invalid" }, { valueUsd: 0 }]) {
    assert.equal(closeComparison(opened, 250000000n, 6), null);
  }
});
