import test from "node:test";
import assert from "node:assert/strict";

import { formatDurationMs, getNextLocalMidnightMs } from "../src/shared/time.js";

test("formatDurationMs keeps hh:mm:ss", () => {
  assert.equal(formatDurationMs(0), "00:00:00");
  assert.equal(formatDurationMs(3_661_000), "01:01:01");
  assert.equal(formatDurationMs(86_400_000), "24:00:00");
});

test("getNextLocalMidnightMs returns a future midnight", () => {
  const now = new Date("2026-03-09T10:30:00").getTime();
  const next = getNextLocalMidnightMs(now);
  assert.ok(next > now);

  const nextDate = new Date(next);
  assert.equal(nextDate.getHours(), 0);
  assert.equal(nextDate.getMinutes(), 0);
  assert.equal(nextDate.getSeconds(), 0);
});
