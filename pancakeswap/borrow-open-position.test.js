const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, checkRisk, validateJob } = require("./borrow-open-position");

test("BNB borrow/open accepts 200 USDT at 650–670 and rejects malformed input", () => {
  assert.deepEqual(parseArgs(["--wallet", "697e", "650", "670", "200"]), {
    wallet:"697e", lower:"650", upper:"670", amount:"200", "dry-run":false, resume:false, "new-job":false,
  });
  for (const args of [["670", "650", "200"], ["650", "670", "0"], ["650", "670", "200", "--resume", "--new-job"], ["650", "670", "200", "--unknown"]]) {
    assert.throws(() => parseArgs(["--wallet", "697e", ...args]));
  }
});

test("risk guard counts existing debt and enforces available debt and HF 1.5", () => {
  const unit = 10n ** 8n;
  const account = [714n * unit, 0n, 499n * unit, 7500n];
  assert.equal(checkRisk(account, 200n * unit), 2677500000000000000n);
  assert.throws(() => checkRisk(account, 500n * unit), /доступного/);
  assert.throws(() => checkRisk([714n * unit, 300n * unit, 300n * unit, 7500n], 200n * unit), /HF/);
  assert.throws(() => checkRisk(account, 0n));
});

test("resume cannot duplicate a loan or silently change amount/wallet/range", () => {
  const job = { address:"wallet", lower:"650", upper:"670", amount:"200" };
  for (const stage of ["borrowing", "opening", "complete"]) {
    assert.throws(() => validateJob(job, { ...job, stage }, { resume:true }));
  }
  assert.doesNotThrow(() => validateJob(job, { ...job, stage:"borrowed" }, { resume:true }));
  assert.throws(() => validateJob({ ...job, amount:"250" }, { ...job, stage:"borrowed" }, { resume:true }));
  assert.throws(() => validateJob(job, { ...job, stage:"opening" }, { "new-job":true }));
  assert.doesNotThrow(() => validateJob(job, { ...job, stage:"complete" }, { "new-job":true }));
});
