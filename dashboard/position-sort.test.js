const test = require("node:test");
const assert = require("node:assert/strict");
const { comparePositions } = require("./position-sort");

test("out-of-range positions show the newest opening first", () => {
  const positions = [
    { id: "new", inRange: false, openedAt: "2026-10-10T12:00:00Z", valueUsd: 500 },
    { id: "active-small", inRange: true, openedAt: "2026-10-01T12:00:00Z", valueUsd: 100 },
    { id: "old", inRange: false, openedAt: "2026-09-01T12:00:00Z", valueUsd: 10 },
    { id: "unknown", inRange: false, openedAt: null, valueUsd: 900 },
    { id: "active-large", inRange: true, openedAt: "2026-10-11T12:00:00Z", valueUsd: 200 },
    { id: "active-unknown", inRange: true, openedAt: null, valueUsd: 1000 },
  ];

  assert.deepEqual(positions.sort(comparePositions).map(({ id }) => id), [
    "active-large", "active-small", "active-unknown", "new", "old", "unknown",
  ]);
});
