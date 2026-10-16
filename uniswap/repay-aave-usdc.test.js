const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { parseArgs, repaymentPlan, executeRepayment } = require("./repay-aave-usdc");

test("parse wallet-balance, partial, full and dry-run; reject ambiguous or imprecise input", () => {
  assert.equal(parseArgs(["--wallet", "037f"]).amount, undefined);
  assert.equal(parseArgs(["--wallet", "037f"]).chain, "arbitrum");
  assert.equal(parseArgs(["--chain", "avalanche", "--wallet", "697e"]).chain, "avalanche");
  assert.equal(parseArgs(["--wallet", "037f", "--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--wallet", "037f", "250", "--dry-run"]).amount, "250");
  assert.equal(parseArgs(["--all", "--wallet", "1bcb"]).all, true);
  for (const argv of [["250"], ["--wallet", "037f", "0"],
    ["--wallet", "037f", "1.1234567"], ["--wallet", "037f", "--all", "1"],
    ["--wallet", "037f", "--all", "--all"], ["--wallet", "--all"],
    ["--wallet", "037f", "--chain", "base"], ["--wallet", "037f", "--chain", "avalanche", "--chain", "arbitrum"]]) {
    assert.throws(() => parseArgs(argv));
  }
});

test("partial repayment is capped by debt in preview, not by silently spending more", () => {
  const p = repaymentPlan({ amount: "250" }, 300000000n, 100000000n);
  assert.equal(p.amountRaw, 250000000n);
  assert.equal(p.expected, 100000000n);
  assert.equal(p.approvalRaw, 250000000n);
  assert.throws(() => repaymentPlan({ amount: "250" }, 249999999n, 300000000n));
  assert.equal(repaymentPlan({ amount: "250" }, 0n, 0n), null);
});

test("full repayment includes interest cushion and limits approval to wallet balance", () => {
  assert.throws(() => repaymentPlan({ all: true }, 100000000n, 100000000n));
  const p = repaymentPlan({ all: true }, 100010000n, 100000000n);
  assert.equal(p.amountRaw, ethers.MaxUint256);
  assert.equal(p.approvalRaw, 100010000n);
});

test("omitted amount spends available USDC up to debt", () => {
  const partial = repaymentPlan({}, 75000000n, 100000000n);
  assert.equal(partial.amountRaw, 75000000n);
  assert.equal(partial.approvalRaw, 75000000n);
  assert.equal(partial.expected, 75000000n);
  const exactDebt = repaymentPlan({}, 100000000n, 100000000n);
  assert.equal(exactDebt.amountRaw, 100000000n);
  assert.equal(exactDebt.approvalRaw, 100000000n);
  const full = repaymentPlan({}, 200000000n, 100000000n);
  assert.equal(full.amountRaw, ethers.MaxUint256);
  assert.equal(full.approvalRaw, 200000000n);
  assert.equal(full.expected, 100000000n);
  assert.throws(() => repaymentPlan({}, 0n, 100000000n), /No USDC available/);
  assert.equal(repaymentPlan({}, 0n, 0n), null);
});

function mocks({ approvalFails = false, simulationFails = false } = {}) {
  const calls = [];
  const approve = async () => {
    calls.push("approve");
    return { hash: "approve", wait: async () => { calls.push("approve-confirmed"); if (approvalFails) throw new Error("approval failed"); } };
  };
  approve.staticCall = async () => true;
  approve.estimateGas = async () => 100n;
  const repay = async () => {
    calls.push("repay");
    return { hash: "repay", wait: async () => ({ logs: [] }) };
  };
  repay.staticCall = async () => {
    calls.push("simulate");
    if (simulationFails) throw new Error("simulation failed");
    return 100n;
  };
  repay.estimateGas = async () => 100n;
  return { calls, token: { approve }, pool: { repay }, asset: "USDC", owner: "owner",
    plan: { amountRaw: 100n, approvalRaw: 100n }, allowance: 0n, log: () => {} };
}

test("approval must confirm before repay simulation and send", async () => {
  const m = mocks();
  await executeRepayment(m);
  assert.deepEqual(m.calls, ["approve", "approve-confirmed", "simulate", "repay"]);
});

test("approval/simulation failure prevents repayment", async () => {
  for (const options of [{ approvalFails: true }, { simulationFails: true }]) {
    const m = mocks(options);
    await assert.rejects(executeRepayment(m));
    assert.equal(m.calls.includes("repay"), false);
  }
});

test("existing sufficient allowance needs no new approval", async () => {
  const m = mocks(); m.allowance = 100n;
  await executeRepayment(m);
  assert.deepEqual(m.calls, ["simulate", "repay"]);
});
