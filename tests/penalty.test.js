import test from "node:test";
import assert from "node:assert/strict";

import { calculatePenaltyDeltaMs } from "../src/shared/penalty.js";
import { MINUTE_MS } from "../src/shared/time.js";

test("penalty disabled adds nothing", () => {
  const result = calculatePenaltyDeltaMs({
    penaltyEnabled: false,
    penaltyCapMs: 30 * MINUTE_MS,
    penaltyAddedMs: 0,
    idlePauseDurationMs: 5 * MINUTE_MS,
    alreadyAppliedIdleMinutes: 0
  });

  assert.equal(result.deltaMs, 0);
  assert.equal(result.newAppliedIdleMinutes, 0);
});

test("penalty adds one minute per full idle minute", () => {
  const result = calculatePenaltyDeltaMs({
    penaltyEnabled: true,
    penaltyCapMs: 30 * MINUTE_MS,
    penaltyAddedMs: 0,
    idlePauseDurationMs: 2 * MINUTE_MS + 25_000,
    alreadyAppliedIdleMinutes: 0
  });

  assert.equal(result.deltaMs, 2 * MINUTE_MS);
  assert.equal(result.newAppliedIdleMinutes, 2);
});

test("penalty respects already applied idle minutes", () => {
  const result = calculatePenaltyDeltaMs({
    penaltyEnabled: true,
    penaltyCapMs: 30 * MINUTE_MS,
    penaltyAddedMs: 0,
    idlePauseDurationMs: 3 * MINUTE_MS,
    alreadyAppliedIdleMinutes: 2
  });

  assert.equal(result.deltaMs, 1 * MINUTE_MS);
  assert.equal(result.newAppliedIdleMinutes, 3);
});

test("penalty respects cap per session", () => {
  const result = calculatePenaltyDeltaMs({
    penaltyEnabled: true,
    penaltyCapMs: 3 * MINUTE_MS,
    penaltyAddedMs: 2 * MINUTE_MS,
    idlePauseDurationMs: 10 * MINUTE_MS,
    alreadyAppliedIdleMinutes: 0
  });

  assert.equal(result.deltaMs, 1 * MINUTE_MS);
  assert.equal(result.newAppliedIdleMinutes, 1);
});
