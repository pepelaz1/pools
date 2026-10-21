const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { principalProceeds, recordCloseIncome, closingIncomeSinceFriday } = require("./close-income");

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-income-test-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return dir;
}
const closing = { dex:"uniswap", chain:"arbitrum", tokenId:"1", address:"wallet",
  initialUsd:250, receivedUsd:320, principalReceivedUsd:280, closedAt:"2026-10-16T17:00:00Z" };

test("actual swap proceeds are allocated to liquidity, excluding native and stable fees", () => {
  assert.equal(principalProceeds({ stablePrincipal:200n, nativePrincipal:80n,
    stableCollected:220n, nativeCollected:100n, swapReceived:100n }), 280n);
  assert.equal(principalProceeds({ stablePrincipal:200n, nativePrincipal:0n,
    stableCollected:220n, nativeCollected:0n, swapReceived:0n }), 200n);
  assert.equal(principalProceeds({ stablePrincipal:200n, nativePrincipal:80n,
    stableCollected:220n, nativeCollected:70n, swapReceived:100n }), null);
});

test("positive profit excludes fees and each chain/NFT is credited only once", t => {
  const dir = directory(t);
  assert.equal(recordCloseIncome(closing, dir), true);
  assert.equal(recordCloseIncome({ ...closing, principalReceivedUsd:300 }, dir), false);
  assert.equal(closingIncomeSinceFriday("2026-10-17", dir).totalUsd, 30);
  assert.equal(closingIncomeSinceFriday("2026-10-17", dir).totalUsd, 30);
  recordCloseIncome({ ...closing, chain:"avalanche" }, dir);
  assert.equal(closingIncomeSinceFriday("2026-10-17", dir).totalUsd, 60);
});

test("negative capital result adds zero even when fees make the gross result positive", t => {
  const dir = directory(t);
  recordCloseIncome({ ...closing, principalReceivedUsd:240 }, dir);
  assert.equal(closingIncomeSinceFriday("2026-10-17", dir).totalUsd, 0);
});

test("close date uses Tomsk midnight and a new Friday resets the window", t => {
  const dir = directory(t);
  recordCloseIncome({ ...closing, closedAt:"2026-10-15T17:00:00Z" }, dir);
  recordCloseIncome({ ...closing, tokenId:"2", closedAt:"2026-10-15T16:59:59Z" }, dir);
  recordCloseIncome({ ...closing, tokenId:"3", closedAt:"2026-10-17T17:00:00Z" }, dir);
  assert.equal(closingIncomeSinceFriday("2026-10-16", dir).totalUsd, 30);
  assert.equal(closingIncomeSinceFriday("2026-10-23", dir).totalUsd, 0);
});

test("unknown opening value and incomplete conversion cannot fabricate profit", t => {
  const dir = directory(t);
  recordCloseIncome({ ...closing, initialUsd:null }, dir);
  recordCloseIncome({ ...closing, tokenId:"2", principalReceivedUsd:null }, dir);
  const result = closingIncomeSinceFriday("2026-10-17", dir);
  assert.equal(result.totalUsd, 0);
  assert.equal(result.unknownCount, 2);
  fs.writeFileSync(path.join(dir, "damaged.json"), "{");
  assert.equal(closingIncomeSinceFriday("2026-10-17", dir).totalUsd, null);
});
