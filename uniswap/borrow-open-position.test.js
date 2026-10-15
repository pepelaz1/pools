const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, workflow } = require("./borrow-open-position");
const job = { address: "wallet", chain: "arbitrum", lower: "2400", upper: "2500", amount: "250.0" };

test("parse workflow parameters and reject unsafe/ambiguous input", () => {
  assert.equal(parseArgs(["--wallet", "7d13", "2400", "2500", "250"]).amount, "250.0");
  assert.equal(parseArgs(["--wallet", "697e", "9", "10", "250", "--chain", "avalanche"]).chain, "avalanche");
  for (const args of [["--wallet", "7d13", "2500", "2400", "250"],
    ["--wallet", "7d13", "2400", "2500", "0"],
    ["--wallet", "7d13", "2400", "2500", "1.0000001"],
    ["--wallet", "7d13", "2400", "2500", "250", "avalanche"],
    ["--wallet", "697e", "9", "10", "250", "--chain", "base"]]) assert.throws(() => parseArgs(args));
});

test("borrow precedes opening, with committed stages before each operation", async () => {
  const stages = [], scripts = [];
  await workflow(job, null, {}, (script) => { scripts.push(script); }, state => stages.push(state.stage));
  assert.deepEqual(scripts, ["borrow-aave-usdc.js", "open-position.js"]);
  assert.deepEqual(stages, ["borrowing", "borrowed", "opening", "complete"]);
});

test("borrow failure prevents opening and blocks blind rerun", async () => {
  let last, calls = 0;
  await assert.rejects(workflow(job, null, {}, () => { calls++; throw new Error("borrow failure"); }, s => { last = s; }));
  assert.equal(calls, 1);
  assert.equal(last.stage, "borrowing");
  await assert.rejects(workflow(job, last, {}, () => calls++, () => {}));
  assert.equal(calls, 1);
});

test("failed opening preserves stage and cannot resume or borrow automatically", async () => {
  let last;
  await assert.rejects(workflow(job, null, {}, script => {
    if (script === "open-position.js") throw new Error("mint failure");
  }, s => { last = s; }));
  assert.equal(last.stage, "opening");
  await assert.rejects(workflow(job, last, { resume: true }, () => assert.fail(), () => {}));
});

test("resume skips borrowing only for matching confirmed job", async () => {
  const scripts = [];
  await workflow(job, { ...job, stage: "borrowed" }, { resume: true }, script => scripts.push(script), () => {});
  assert.deepEqual(scripts, ["open-position.js"]);
  await workflow(job, { ...job, chain: undefined, stage: "borrowed" }, { resume: true },
    script => scripts.push(script), () => {});
  assert.deepEqual(scripts, ["open-position.js", "open-position.js"]);
  await assert.rejects(workflow(job, { ...job, amount: "500.0", stage: "borrowed" }, { resume: true }, () => assert.fail(), () => {}));
  await assert.rejects(workflow({ ...job, chain: "avalanche" }, { ...job, stage: "borrowed" },
    { resume: true }, () => assert.fail(), () => {}));
});

test("Avalanche borrow and open use the same chain and keep journal stages", async () => {
  const calls = [], stages = [];
  await workflow({ ...job, chain: "avalanche", lower: "9", upper: "10" }, null, {},
    (script, args) => calls.push({ script, args }), state => stages.push(state));
  assert.deepEqual(calls, [
    { script: "borrow-aave-usdc.js", args: ["--chain", "avalanche", "--wallet", "wallet", "250.0"] },
    { script: "open-position.js", args: ["--wallet", "wallet", "9", "10", "250.0", "avalanche"] },
  ]);
  assert.deepEqual(stages.map(state => state.stage), ["borrowing", "borrowed", "opening", "complete"]);
  assert.ok(stages.every(state => state.chain === "avalanche"));
});

test("another loan after completion requires explicit new-job", async () => {
  const previous = { ...job, stage: "complete" };
  await assert.rejects(workflow(job, previous, {}, () => assert.fail(), () => {}));
  assert.equal((await workflow(job, previous, { newJob: true }, () => {}, () => {})).stage, "complete");
});
