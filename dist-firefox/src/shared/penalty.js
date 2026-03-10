import { MINUTE_MS } from "./time.js";

export function calculatePenaltyDeltaMs({
  penaltyEnabled,
  penaltyCapMs,
  penaltyAddedMs,
  idlePauseDurationMs,
  alreadyAppliedIdleMinutes
}) {
  if (!penaltyEnabled) {
    return {
      deltaMs: 0,
      newAppliedIdleMinutes: alreadyAppliedIdleMinutes
    };
  }

  const elapsedIdleMinutes = Math.floor(Math.max(0, idlePauseDurationMs) / MINUTE_MS);
  const newlyEligibleMinutes = elapsedIdleMinutes - alreadyAppliedIdleMinutes;

  if (newlyEligibleMinutes <= 0) {
    return {
      deltaMs: 0,
      newAppliedIdleMinutes: alreadyAppliedIdleMinutes
    };
  }

  const remainingCapMs = Math.max(0, penaltyCapMs - penaltyAddedMs);
  const capEligibleMinutes = Math.floor(remainingCapMs / MINUTE_MS);
  const minutesToAdd = Math.min(newlyEligibleMinutes, capEligibleMinutes);

  if (minutesToAdd <= 0) {
    return {
      deltaMs: 0,
      newAppliedIdleMinutes: alreadyAppliedIdleMinutes
    };
  }

  return {
    deltaMs: minutesToAdd * MINUTE_MS,
    newAppliedIdleMinutes: alreadyAppliedIdleMinutes + minutesToAdd
  };
}
