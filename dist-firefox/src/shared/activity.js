export const IDLE_PAUSE_REASON = {
  PAGE_OUT_OF_FOCUS: "page_out_of_focus",
  NO_RECENT_INTERACTION: "no_recent_interaction",
  WINDOW_NOT_FOCUSED: "window_not_focused",
  EXTERNAL_APP_ACTIVE: "external_app_active"
};

export function evaluateFocusActivity({
  nowMs,
  lastInteractionAtMs,
  idleTimeoutSeconds,
  windowFocused,
  hasAllowedTab
}) {
  if (!windowFocused) {
    return {
      isActive: false,
      reason: IDLE_PAUSE_REASON.WINDOW_NOT_FOCUSED
    };
  }

  if (!hasAllowedTab) {
    return {
      isActive: false,
      reason: IDLE_PAUSE_REASON.PAGE_OUT_OF_FOCUS
    };
  }

  if (!lastInteractionAtMs) {
    return {
      isActive: false,
      reason: IDLE_PAUSE_REASON.NO_RECENT_INTERACTION
    };
  }

  const idleTimeoutMs = idleTimeoutSeconds * 1000;
  if (nowMs - lastInteractionAtMs > idleTimeoutMs) {
    return {
      isActive: false,
      reason: IDLE_PAUSE_REASON.NO_RECENT_INTERACTION
    };
  }

  return {
    isActive: true,
    reason: null
  };
}
