const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs } = require("./borrow-aave-usdc");

test("borrow defaults to Arbitrum and accepts Avalanche explicitly", () => {
  assert.deepEqual(parseArgs(["--wallet", "7d13", "250"]),
    { dryRun: false, chain: "arbitrum", walletSelector: "7d13", amount: "250" });
  assert.deepEqual(parseArgs(["--dry-run", "--chain", "avalanche", "--wallet", "697e", "250"]),
    { dryRun: true, chain: "avalanche", walletSelector: "697e", amount: "250" });
  assert.throws(() => parseArgs(["--chain", "base", "--wallet", "697e", "250"]));
});
