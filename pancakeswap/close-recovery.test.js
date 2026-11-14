const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCloseJob } = require("./close-job");
const { swapUsdtToWbnb } = require("./lib");

test("failed close preserves original balances, resumes, and refuses duplicate completion", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pancake-close-test-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const job = { tokenId:"123", address:"0xabc", keepBnb:true };
  const baseline = { wbnbBefore:"12", usdtBefore:"34", cakeBefore:"0" };
  await assert.rejects(runCloseJob(job, false, async hooks => {
    hooks.onBaseline(baseline);
    hooks.onStage("swapping-usdt");
    throw Error("reverted");
  }, dir), /reverted/);
  const file = path.join(dir, "123.json");
  const saved = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(saved).lastStage, "swapping-usdt");
  await assert.rejects(runCloseJob(job, false, () => assert.fail("duplicate"), dir), /journal exists/);
  await assert.rejects(runCloseJob({ ...job, address:"0xdef" }, true, () => assert.fail("wrong wallet"), dir), /does not match/);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  await runCloseJob(job, true, async hooks => {
    assert.deepEqual(hooks.resumeBalances, baseline);
    return { status:"ok" };
  }, dir);
  await assert.rejects(runCloseJob(job, true, () => assert.fail("complete"), dir), /journal exists/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

function mocks({ quoteError = false, simulationError = false } = {}) {
  const events = [];
  let balance = 100n;
  const swap = async (params, options) => {
    events.push("send");
    assert.equal(params.amountIn, 37n);
    assert.equal(params.amountOutMinimum, 198n);
    assert.equal(options.gasLimit, 130000n);
    return { hash:"swap", wait:async () => { events.push("confirmed"); balance += 200n; } };
  };
  swap.staticCall = async () => { events.push("simulate"); if (simulationError) throw Error("simulation failed"); };
  swap.estimateGas = async () => 100000n;
  return { events, contracts:{
    usdt:{ allowance:async () => 0n, approve:async (_, amount) => {
      assert.equal(amount, 37n);
      events.push("approve");
      return { hash:"approve", wait:async () => events.push("approval confirmed") };
    } },
    quoter:{ quoteExactInputSingle:{ staticCall:async () => { if (quoteError) throw Error("quote failed"); return [200n]; } } },
    wbnb:{ balanceOf:async () => balance },
    router:{ exactInputSingle:swap },
  } };
}

test("recovery swap confirms approval, simulates, and returns only newly acquired WBNB", async () => {
  const { events, contracts } = mocks();
  assert.equal(await swapUsdtToWbnb({ address:"wallet" }, 37n, 100, contracts), 200n);
  assert.deepEqual(events, ["approve", "approval confirmed", "simulate", "send", "confirmed"]);
});

test("failed quote or simulation cannot send a swap", async () => {
  for (const options of [{ quoteError:true }, { simulationError:true }]) {
    const { events, contracts } = mocks(options);
    await assert.rejects(swapUsdtToWbnb({ address:"wallet" }, 37n, 100, contracts));
    assert.ok(!events.includes("send"));
    if (options.quoteError) assert.deepEqual(events, []);
  }
});
