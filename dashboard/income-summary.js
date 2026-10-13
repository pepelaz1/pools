function incomeWindow(today, count) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isInteger(count) || count < 1) {
    throw new Error("Invalid income window");
  }
  const date = new Date(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(date);
    day.setUTCDate(day.getUTCDate() - index);
    return day.toISOString().slice(0, 10);
  });
}

function summarizeIncome(days, today, count = 365) {
  const recorded = incomeWindow(today, count).filter(key => days[key]?.incomeUsd != null
    && Number.isFinite(Number(days[key].incomeUsd)));
  return {
    totalUsd: recorded.length ? recorded.reduce((sum, key) => sum + Number(days[key].incomeUsd), 0) : null,
    recordedDays: recorded.length,
    firstRecordedDate: recorded.at(-1) || null,
    windowDays: count,
  };
}

module.exports = { incomeWindow, summarizeIncome };
