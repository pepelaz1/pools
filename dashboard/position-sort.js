function openedTime(position) {
  const time = Date.parse(position.openedAt || "");
  return Number.isFinite(time) ? time : Infinity;
}

function comparePositions(a, b) {
  const rangeOrder = Number(b.inRange) - Number(a.inRange);
  if (rangeOrder) return rangeOrder;

  const aTime = openedTime(a);
  const bTime = openedTime(b);
  if (aTime === Infinity && bTime !== Infinity) return 1;
  if (bTime === Infinity && aTime !== Infinity) return -1;

  if (!a.inRange) {
    if (aTime !== bTime) return aTime > bTime ? -1 : 1;
  }

  return b.valueUsd - a.valueUsd;
}

module.exports = { comparePositions };
