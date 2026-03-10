import { DEFAULT_CONFIG, PENALTY_RATE } from "./constants.js";
import { DISPLAY_MODE, normalizeDisplayMode } from "./displayMode.js";
import { normalizeExternalApps } from "./externalApps.js";
import { normalizeMusicUrl } from "./music.js";
import { clampNumber, safeInteger } from "./time.js";
import { normalizeWhitelist } from "./whitelist.js";

export function sanitizeConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

  const focusDurationMinutes = clampNumber(
    safeInteger(source.focusDurationMinutes, DEFAULT_CONFIG.focusDurationMinutes),
    1,
    8 * 60
  );

  const manualPauseLimitMinutes = clampNumber(
    safeInteger(source.manualPauseLimitMinutes, DEFAULT_CONFIG.manualPauseLimitMinutes),
    0,
    120
  );

  const idleTimeoutSeconds = clampNumber(
    safeInteger(source.idleTimeoutSeconds, DEFAULT_CONFIG.idleTimeoutSeconds),
    30,
    600
  );

  const penaltyEnabled = Boolean(source.penaltyEnabled);

  const penaltyCapMinutes = clampNumber(
    safeInteger(source.penaltyCapMinutes, DEFAULT_CONFIG.penaltyCapMinutes),
    1,
    180
  );

  const externalApps = normalizeExternalApps(
    source.externalApps ?? DEFAULT_CONFIG.externalApps
  );
  const musicUrl = normalizeMusicUrl(
    source.musicUrl ?? DEFAULT_CONFIG.musicUrl
  );

  return {
    whitelist: normalizeWhitelist(source.whitelist ?? DEFAULT_CONFIG.whitelist),
    focusDurationMinutes,
    manualPauseLimitMinutes,
    idleTimeoutSeconds,
    penaltyEnabled,
    penaltyRate: PENALTY_RATE,
    penaltyCapMinutes,
    externalApps,
    musicUrl
  };
}

function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const requiredNumbers = [
    "startedAtMs",
    "completedAtMs",
    "configuredDurationMs",
    "manualPauseUsedMs",
    "penaltyAddedMs"
  ];

  for (const key of requiredNumbers) {
    if (typeof entry[key] !== "number" || !Number.isFinite(entry[key])) {
      return null;
    }
  }

  return {
    id: typeof entry.id === "string" ? entry.id : `hist_${entry.startedAtMs}`,
    startedAtMs: entry.startedAtMs,
    completedAtMs: entry.completedAtMs,
    configuredDurationMs: entry.configuredDurationMs,
    manualPauseUsedMs: entry.manualPauseUsedMs,
    penaltyAddedMs: entry.penaltyAddedMs,
    penaltyEnabled: Boolean(entry.penaltyEnabled),
    displayMode: normalizeDisplayMode(entry.displayMode, DISPLAY_MODE.POPUP),
    idleTimeoutSeconds:
      typeof entry.idleTimeoutSeconds === "number" && Number.isFinite(entry.idleTimeoutSeconds)
        ? entry.idleTimeoutSeconds
        : DEFAULT_CONFIG.idleTimeoutSeconds,
    status:
      typeof entry.status === "string"
        ? entry.status
        : "completed_pending_confirmation",
    confirmedAtMs:
      typeof entry.confirmedAtMs === "number" && Number.isFinite(entry.confirmedAtMs)
        ? entry.confirmedAtMs
        : null,
    unlockedUntilMs:
      typeof entry.unlockedUntilMs === "number" && Number.isFinite(entry.unlockedUntilMs)
        ? entry.unlockedUntilMs
        : null,
    integrityWarnings: Array.isArray(entry.integrityWarnings)
      ? entry.integrityWarnings.slice(0, 20)
      : []
  };
}

export function sanitizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) {
    return [];
  }

  return rawHistory
    .map(sanitizeHistoryEntry)
    .filter(Boolean)
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
    .slice(0, 300);
}

export function buildExportPayload({ config, history }) {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    config: sanitizeConfig(config),
    history: sanitizeHistory(history)
  };
}

export function parseImportPayload(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "JSON inválido." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Estrutura inválida." };
  }

  if (parsed.schemaVersion !== 1) {
    return { ok: false, error: "Versão de schema não suportada." };
  }

  return {
    ok: true,
    value: {
      config: sanitizeConfig(parsed.config),
      history: sanitizeHistory(parsed.history)
    }
  };
}
