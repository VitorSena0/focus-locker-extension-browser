import { BLOCKING_STATUSES, SESSION_STATUS } from "./constants.js";
import { DISPLAY_MODE } from "./displayMode.js";

export function createIdleSession() {
  return {
    status: SESSION_STATUS.IDLE,
    sessionId: null,
    startedAtMs: null,
    completedAtMs: null,
    lastTickAtMs: null,
    lastInteractionAtMs: null,
    lastInteractionTabId: null,
    lastInteractionWindowId: null,
    remainingMs: 0,
    effectiveRemainingMs: 0,
    configuredDurationMs: 0,
    displayMode: DISPLAY_MODE.POPUP,
    whitelistSnapshot: [],
    manualPauseLimitMs: 0,
    manualPauseUsedMs: 0,
    manualPauseStartedAtMs: null,
    manualPauseRemainingMs: 0,
    idlePauseStartedAtMs: null,
    idlePauseReason: null,
    idlePenaltyAppliedMinutes: 0,
    penaltyEnabled: false,
    penaltyCapMs: 0,
    penaltyAddedMs: 0,
    externalApps: [],
    externalOverrideActive: false,
    musicOwnerTabId: null,
    unlockRequiresConfirmation: false,
    unlockedUntilMs: null,
    integrityWarnings: [],
    lastLifecycleSignalAtMs: null
  };
}

export function isBlockingStatus(status) {
  return BLOCKING_STATUSES.has(status);
}

export function isActiveCycleStatus(status) {
  return (
    status === SESSION_STATUS.RUNNING ||
    status === SESSION_STATUS.PAUSED_MANUAL ||
    status === SESSION_STATUS.PAUSED_IDLE ||
    status === SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION
  );
}
