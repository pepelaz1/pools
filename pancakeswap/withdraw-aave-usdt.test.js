const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, preflight } = require("./withdraw-aave-usdt");

function fixture() {
  const calls = [];
  return {
    provider: { getNetwork: async () => ({ chainId: 56n }), getBalance: async () => 10n ** 18n,
      getFeeData: async () => ({ gasPrice: 10n ** 9n }) },
    usdt: { decimals: async () => 18n }, aToken: { balanceOf: async () => 500n },
    pool: { getUserAccountData: async () => [0n, 0n, 0n, 0n, 0n, 0n], withdraw: {
      staticCall: async (...args) => { calls.push(args); return 300n; }, estimateGas: async () => 100001n,
    } }, address: "0x123", amountRaw: 300n, calls,
  };
}
test("exact positive amount and explicit wallet; dry run can precede options", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--wallet", "697e", "300"]), { selector: "697e", amount: "300", dryRun: true });
  for (const args of [[], ["--wallet", "697e"], ["--wallet", "697e", "0"], ["--wallet", "697e", "-1"],
    ["--wallet", "697e", "1e3"], ["--wallet", "697e", "300", "--all"]]) assert.throws(() => parseArgs(args));
});
test("simulation sends to same address, gas margin rounds up", async () => {
  const f = fixture(); const result = await preflight(f);
  assert.equal(result.gasLimit, 120002n);
  assert.equal(f.calls[0][2], f.address);
  assert.deepEqual(f.calls[0][3], { from: f.address });
});
test("reject wrong chain, insufficient deposit, wrong decimals or gas", async () => {
  const mutations = [
    f => { f.provider.getNetwork = async () => ({ chainId: 43114n }); },
    f => { f.aToken.balanceOf = async () => 299n; },
    f => { f.usdt.decimals = async () => 6n; },
    f => { f.provider.getBalance = async () => 0n; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(preflight(f)); }
});
test("Aave risk rejection stops preflight", async () => {
  const f = fixture(); f.pool.withdraw.staticCall = async () => { throw new Error("HF too low"); };
  await assert.rejects(preflight(f), /HF too low/);
});
