const test = require("node:test");
const assert = require("node:assert/strict");
const { incomeWindow, summarizeIncome } = require("./income-summary");

test("365 days include today and correctly cross the year boundary", () => {
  const days = incomeWindow("2026-10-13", 365);
  assert.equal(days.length, 365);
  assert.equal(days[0], "2026-10-13");
  assert.equal(days.at(-1), "2025-10-14");
  assert.equal(incomeWindow("2024-03-01", 2)[1], "2024-02-29");
});

test("year sum includes older than 30 days but excludes older than 365 and future", () => {
  const summary = summarizeIncome({
    "2026-10-13": { incomeUsd: 2 }, "2026-08-01": { incomeUsd: 3 },
    "2025-10-14": { incomeUsd: 4 }, "2025-10-13": { incomeUsd: 100 },
    "2026-10-14": { incomeUsd: 100 },
  }, "2026-10-13");
  assert.equal(summary.totalUsd, 9);
  assert.equal(summary.recordedDays, 3);
  assert.equal(summary.firstRecordedDate, "2025-10-14");
});

test("missing history is not a fictitious zero; actual zero days count", () => {
  assert.equal(summarizeIncome({}, "2026-10-13").totalUsd, null);
  const summary = summarizeIncome({ "2026-10-13": { incomeUsd: 0 },
    "2026-10-12": { incomeUsd: null } }, "2026-10-13");
  assert.equal(summary.totalUsd, 0);
  assert.equal(summary.recordedDays, 1);
});
