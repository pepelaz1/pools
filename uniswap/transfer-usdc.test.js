const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, resolveTransfer, transferPreflight } = require("./transfer-usdc");
const wallets = [
  { name: "d71f", address: "0x0000000000000000000000000000000000000001" },
  { name: "1bcb", address: "0x0000000000000000000000000000000000000002" },
];

test("parse source, destination and exact six-decimal USDC amounts", () => {
  const options = parseArgs(["d71f", "1bcb", "250.000001", "--dry-run"]);
  assert.equal(options.amountRaw, 250000001n);
  assert.equal(options.dryRun, true);
  for (const argv of [["d71f", "1bcb"], ["d71f", "1bcb", "0"],
    ["d71f", "1bcb", "1.0000001"], ["d71f", "1bcb", "-1"],
    ["d71f", "1bcb", "1", "avalanche"], ["d71f", "1bcb", "1", "--live"]]) {
    assert.throws(() => parseArgs(argv));
  }
});

test("resolve names case-insensitively or recipient addresses", () => {
  assert.equal(resolveTransfer(wallets, "D71F", "1BcB").recipientAddress, wallets[1].address);
  assert.equal(resolveTransfer(wallets, wallets[0].address, wallets[1].address).sourceAddress, wallets[0].address);
  assert.equal(resolveTransfer(wallets, "d71f", "0x0000000000000000000000000000000000000003").recipientName, "external address");
});

test("reject unknown source, bad recipient, same account, zero and ambiguous names", () => {
  assert.throws(() => resolveTransfer(wallets, "missing", "1bcb"));
  assert.throws(() => resolveTransfer(wallets, "d71f", "missing"));
  assert.throws(() => resolveTransfer(wallets, "d71f", "d71f"));
  assert.throws(() => resolveTransfer(wallets, "d71f", "0x0000000000000000000000000000000000000000"));
  assert.throws(() => resolveTransfer([...wallets, wallets[0]], "d71f", "1bcb"));
});

test("preflight checks balance before simulation and does not send transactions", async () => {
  let simulations = 0, estimates = 0;
  const transfer = () => { throw new Error("Must not send"); };
  transfer.staticCall = async () => { simulations++; return true; };
  transfer.estimateGas = async () => { estimates++; return 100n; };
  const token = { balanceOf: async () => 250000000n, transfer };
  assert.equal((await transferPreflight(token, "from", "to", 250000000n)).gasLimit, 120n);
  await assert.rejects(transferPreflight(token, "from", "to", 250000001n), /Insufficient/);
  assert.equal(simulations, 1);
  assert.equal(estimates, 1);
  transfer.staticCall = async () => false;
  await assert.rejects(transferPreflight(token, "from", "to", 1n), /returned false/);
});
