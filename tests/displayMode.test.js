import test from "node:test";
import assert from "node:assert/strict";

import { DISPLAY_MODE, normalizeDisplayMode } from "../src/shared/displayMode.js";

test("normalizeDisplayMode accepts valid values", () => {
  assert.equal(normalizeDisplayMode(DISPLAY_MODE.POPUP), DISPLAY_MODE.POPUP);
  assert.equal(normalizeDisplayMode(DISPLAY_MODE.OVERLAY), DISPLAY_MODE.OVERLAY);
});

test("normalizeDisplayMode falls back on invalid input", () => {
  assert.equal(normalizeDisplayMode("invalid", DISPLAY_MODE.OVERLAY), DISPLAY_MODE.OVERLAY);
  assert.equal(normalizeDisplayMode(undefined, DISPLAY_MODE.POPUP), DISPLAY_MODE.POPUP);
});
