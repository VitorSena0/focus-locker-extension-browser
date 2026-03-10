export const STORAGE_KEYS = {
  config: "focus_config",
  session: "focus_session",
  history: "focus_history",
  overlayPrefs: "focus_overlay_prefs"
};

export const SESSION_STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED_MANUAL: "paused_manual",
  PAUSED_IDLE: "paused_idle",
  COMPLETED_PENDING_CONFIRMATION: "completed_pending_confirmation",
  UNLOCKED_UNTIL_MIDNIGHT: "unlocked_until_midnight"
};

export const PENALTY_RATE = "1_to_1_per_minute";

export const DEFAULT_CONFIG = {
  whitelist: [],
  focusDurationMinutes: 25,
  manualPauseLimitMinutes: 10,
  idleTimeoutSeconds: 120,
  penaltyEnabled: false,
  penaltyRate: PENALTY_RATE,
  penaltyCapMinutes: 30,
  externalApps: [],
  musicUrl: ""
};

export const ACTIVE_CYCLE_STATUSES = new Set([
  SESSION_STATUS.RUNNING,
  SESSION_STATUS.PAUSED_MANUAL,
  SESSION_STATUS.PAUSED_IDLE,
  SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION
]);

export const BLOCKING_STATUSES = new Set(ACTIVE_CYCLE_STATUSES);

export const TICK_MS_ACTIVE = 1000;
export const TICK_MS_UNLOCKED = 30_000;
