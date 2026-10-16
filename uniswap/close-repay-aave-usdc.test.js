const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, workflow, failureGuidance } = require("./close-repay-aave-usdc");

const job = { tokenId:"5711381", chain:"arbitrum", address:"0xc7A48ddBC1A0A9fDeC3Eb42c101368b67A30037f", amount:null };

test("optional repayment amount and resume arguments are unambiguous", () => {
  assert.equal(parseArgs(["5711381"]).amount, null);
  assert.equal(parseArgs(["5711381"]).chain, "arbitrum");
  assert.equal(parseArgs(["87690", "--chain", "avalanche"]).chain, "avalanche");
  assert.equal(parseArgs(["5711381", "250.123456"]).amount, "250.123456");
  assert.equal(parseArgs(["5711381", "250", "--resume"]).resume, true);
  for (const argv of [[], ["0"], ["5711381", "0"], ["5711381", "1.1234567"],
    ["5711381", "250", "500"], ["5711381", "--resume", "--resume"], ["--wallet", "037f", "5711381"],
    ["87690", "--chain", "base"], ["87690", "--chain", "avalanche", "--chain", "arbitrum"]]) {
    assert.throws(() => parseArgs(argv));
  }
});

test("password failure before the first stage permits a safe retry", () => {
  assert.match(failureGuidance(false, false), /retry the same command/);
  assert.match(failureGuidance(false, true), /existing journal/);
  assert.match(failureGuidance(true, true), /transaction stage started/);
});

test("close precedes repayment, with each stage journaled first", async () => {
  const stages = [], calls = [];
  await workflow(job, null, false, stage => calls.push(stage), state => stages.push(state.stage));
  assert.deepEqual(calls, ["close", "repay"]);
  assert.deepEqual(stages, ["closing", "closed", "repaying", "complete"]);
});

test("Avalanche close and repayment retain the selected chain", async () => {
  const avalanche = { ...job, tokenId:"87690", chain:"avalanche" };
  const calls = [], saved = [];
  await workflow(avalanche, null, false, (stage, current) => calls.push([stage, current.chain]),
    state => saved.push(state));
  assert.deepEqual(calls, [["close", "avalanche"], ["repay", "avalanche"]]);
  assert.ok(saved.every(state => state.chain === "avalanche"));
  await assert.rejects(workflow(avalanche, { ...avalanche, chain:"arbitrum", stage:"closed" }, true,
    () => assert.fail(), () => {}));
});

test("failed close never repays and cannot be blindly resumed", async () => {
  let last, calls = 0;
  await assert.rejects(workflow(job, null, false, stage => {
    calls++;
    if (stage === "close") throw new Error("close failed");
  }, state => { last = state; }));
  assert.equal(last.stage, "closing");
  assert.equal(calls, 1);
  await assert.rejects(workflow(job, last, true, () => assert.fail(), () => {}));
  await assert.rejects(workflow(job, last, false, () => assert.fail(), () => {}));
});

test("resume after confirmed close skips closing but keeps original amount and wallet", async () => {
  const calls = [], closed = { ...job, stage:"closed" };
  await workflow(job, closed, true, stage => calls.push(stage), () => {});
  assert.deepEqual(calls, ["repay"]);
  await assert.rejects(workflow({ ...job, amount:"250.0" }, closed, true, () => assert.fail(), () => {}));
  await assert.rejects(workflow({ ...job, address:"0x0000000000000000000000000000000000000001" }, closed,
    true, () => assert.fail(), () => {}));
});

test("failed or completed repayment is not automatically repeated", async () => {
  let last;
  await assert.rejects(workflow(job, null, false, stage => {
    if (stage === "repay") throw new Error("repayment uncertain");
  }, state => { last = state; }));
  assert.equal(last.stage, "repaying");
  await assert.rejects(workflow(job, last, true, () => assert.fail(), () => {}));
  await assert.rejects(workflow(job, { ...job, stage:"complete" }, false, () => assert.fail(), () => {}));
});
