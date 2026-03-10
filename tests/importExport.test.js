import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExportPayload,
  parseImportPayload,
  sanitizeConfig,
  sanitizeHistory
} from "../src/shared/importExport.js";
import { PENALTY_RATE } from "../src/shared/constants.js";
import { DISPLAY_MODE } from "../src/shared/displayMode.js";

test("sanitizeConfig clamps values and enforces penalty rate", () => {
  const cfg = sanitizeConfig({
    whitelist: ["youtube.com", "invalid", "www.youtube.com"],
    focusDurationMinutes: 999,
    manualPauseLimitMinutes: -2,
    idleTimeoutSeconds: 10,
    penaltyEnabled: 1,
    penaltyCapMinutes: 0,
    penaltyRate: "anything",
    externalApps: ["VS Code", "vS code", "Slack"],
    musicUrl: "https://music.youtube.com/watch?v=abc123"
  });

  assert.deepEqual(cfg.whitelist, ["youtube.com"]);
  assert.equal(cfg.focusDurationMinutes, 480);
  assert.equal(cfg.manualPauseLimitMinutes, 0);
  assert.equal(cfg.idleTimeoutSeconds, 30);
  assert.equal(cfg.penaltyEnabled, true);
  assert.equal(cfg.penaltyCapMinutes, 1);
  assert.equal(cfg.penaltyRate, PENALTY_RATE);
  assert.deepEqual(cfg.externalApps, ["VS Code", "Slack"]);
  assert.equal(cfg.musicUrl, "https://music.youtube.com/watch?v=abc123");
});

test("buildExportPayload includes schema v1", () => {
  const payload = buildExportPayload({
    config: sanitizeConfig({ whitelist: ["youtube.com"] }),
    history: []
  });

  assert.equal(payload.schemaVersion, 1);
  assert.ok(payload.exportedAt);
  assert.deepEqual(payload.config.whitelist, ["youtube.com"]);
});

test("parseImportPayload validates and sanitizes", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    config: {
      whitelist: ["youtube.com", "notdomain"],
      focusDurationMinutes: 20,
      manualPauseLimitMinutes: 5,
      idleTimeoutSeconds: 120,
      penaltyEnabled: false,
      penaltyCapMinutes: 30,
      externalApps: ["Notion", "notion", "Slack"],
      musicUrl: "https://www.youtube.com/playlist?list=PL123"
    },
    history: [
      {
        id: "abc",
        startedAtMs: 1,
        completedAtMs: 2,
        configuredDurationMs: 60_000,
        manualPauseUsedMs: 0,
        penaltyAddedMs: 0,
        penaltyEnabled: false,
        displayMode: "invalid",
        idleTimeoutSeconds: 120,
        status: "confirmed_unlocked_until_midnight"
      },
      {
        invalid: true
      }
    ]
  });

  const result = parseImportPayload(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.config.whitelist, ["youtube.com"]);
  assert.equal(result.value.history.length, 1);
  assert.equal(result.value.history[0].displayMode, DISPLAY_MODE.POPUP);
  assert.deepEqual(result.value.config.externalApps, ["Notion", "Slack"]);
  assert.equal(result.value.config.musicUrl, "https://www.youtube.com/playlist?list=PL123");
});

test("parseImportPayload rejects wrong schema", () => {
  const result = parseImportPayload(JSON.stringify({ schemaVersion: 2 }));
  assert.equal(result.ok, false);
});

test("sanitizeHistory drops invalid entries", () => {
  const history = sanitizeHistory([
    {
      id: "ok",
      startedAtMs: 1,
      completedAtMs: 2,
      configuredDurationMs: 3,
      manualPauseUsedMs: 4,
      penaltyAddedMs: 5
    },
    { invalid: true }
  ]);

  assert.equal(history.length, 1);
  assert.equal(history[0].id, "ok");
});
