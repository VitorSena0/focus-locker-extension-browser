import test from "node:test";
import assert from "node:assert/strict";

import { IDLE_PAUSE_REASON, evaluateFocusActivity } from "../src/shared/activity.js";

test("pauses immediately when page is out of focus", () => {
  const result = evaluateFocusActivity({
    nowMs: 1_000_000,
    lastInteractionAtMs: 999_900,
    idleTimeoutSeconds: 120,
    windowFocused: true,
    hasAllowedTab: false
  });

  assert.equal(result.isActive, false);
  assert.equal(result.reason, IDLE_PAUSE_REASON.PAGE_OUT_OF_FOCUS);
});

test("pauses when window is not focused", () => {
  const result = evaluateFocusActivity({
    nowMs: 1_000_000,
    lastInteractionAtMs: 999_900,
    idleTimeoutSeconds: 120,
    windowFocused: false,
    hasAllowedTab: true
  });

  assert.equal(result.isActive, false);
  assert.equal(result.reason, IDLE_PAUSE_REASON.WINDOW_NOT_FOCUSED);
});

test("pauses when no interaction exists yet", () => {
  const result = evaluateFocusActivity({
    nowMs: 1_000_000,
    lastInteractionAtMs: null,
    idleTimeoutSeconds: 120,
    windowFocused: true,
    hasAllowedTab: true
  });

  assert.equal(result.isActive, false);
  assert.equal(result.reason, IDLE_PAUSE_REASON.NO_RECENT_INTERACTION);
});

test("pauses when interaction exceeds configured timeout", () => {
  const result = evaluateFocusActivity({
    nowMs: 1_000_000,
    lastInteractionAtMs: 1_000_000 - 121_000,
    idleTimeoutSeconds: 120,
    windowFocused: true,
    hasAllowedTab: true
  });

  assert.equal(result.isActive, false);
  assert.equal(result.reason, IDLE_PAUSE_REASON.NO_RECENT_INTERACTION);
});

test("remains active with focused page and recent interaction", () => {
  const result = evaluateFocusActivity({
    nowMs: 1_000_000,
    lastInteractionAtMs: 1_000_000 - 20_000,
    idleTimeoutSeconds: 120,
    windowFocused: true,
    hasAllowedTab: true
  });

  assert.equal(result.isActive, true);
  assert.equal(result.reason, null);
});
