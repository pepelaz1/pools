const test = require("node:test");
const assert = require("node:assert/strict");
const { closeComparison } = require("./close-position");
const { ethers } = require("ethers");
const { withdrawnPrincipal } = require("../close-income");

test("withdrawal principal is decoded from confirmed events for the selected NFT only", () => {
  const iface = new ethers.Interface([
    "event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  ]);
  const manager = "0x0000000000000000000000000000000000000001";
  const makeLog = (tokenId, address = manager) => ({ address,
    ...iface.encodeEventLog(iface.getEvent("DecreaseLiquidity"), [tokenId, 10n, 100n, 200n]) });
  assert.deepEqual(withdrawnPrincipal({ logs:[makeLog(2n), makeLog(1n)] }, iface, manager, 1n),
    { amount0:100n, amount1:200n });
  assert.equal(withdrawnPrincipal({ logs:[makeLog(1n, ethers.ZeroAddress)] }, iface, manager, 1n), null);
  assert.equal(withdrawnPrincipal({ logs:[] }, iface, manager, 1n), null);
});

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
