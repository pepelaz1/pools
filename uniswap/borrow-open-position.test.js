const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, workflow } = require("./borrow-open-position");
const job = { address: "wallet", lower: "2400", upper: "2500", amount: "250.0" };

test("parse workflow parameters and reject unsafe/ambiguous input", () => {
  assert.equal(parseArgs(["--wallet", "7d13", "2400", "2500", "250"]).amount, "250.0");
  for (const args of [["--wallet", "7d13", "2500", "2400", "250"],
    ["--wallet", "7d13", "2400", "2500", "0"],
    ["--wallet", "7d13", "2400", "2500", "1.0000001"],
    ["--wallet", "7d13", "2400", "2500", "250", "avalanche"]]) assert.throws(() => parseArgs(args));
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
  await assert.rejects(workflow(job, { ...job, amount: "500.0", stage: "borrowed" }, { resume: true }, () => assert.fail(), () => {}));
});

test("another loan after completion requires explicit new-job", async () => {
  const previous = { ...job, stage: "complete" };
  await assert.rejects(workflow(job, previous, {}, () => assert.fail(), () => {}));
  assert.equal((await workflow(job, previous, { newJob: true }, () => {}, () => {})).stage, "complete");
});
