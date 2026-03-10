import {
  DEFAULT_CONFIG,
  PENALTY_RATE,
  SESSION_STATUS,
  STORAGE_KEYS,
  TICK_MS_ACTIVE,
  TICK_MS_UNLOCKED
} from "./shared/constants.js";
import {
  buildExportPayload,
  parseImportPayload,
  sanitizeConfig,
  sanitizeHistory
} from "./shared/importExport.js";
import { IDLE_PAUSE_REASON, evaluateFocusActivity } from "./shared/activity.js";
import { DISPLAY_MODE, normalizeDisplayMode } from "./shared/displayMode.js";
import { normalizeExternalApps } from "./shared/externalApps.js";
import { calculatePenaltyDeltaMs } from "./shared/penalty.js";
import { createIdleSession, isActiveCycleStatus, isBlockingStatus } from "./shared/session.js";
import { getNextLocalMidnightMs, MINUTE_MS } from "./shared/time.js";
import { isAllowedUrl, isNavigableHttpUrl } from "./shared/whitelist.js";

const ext = globalThis.browser ?? globalThis.chrome;
const ALARM_NAME = "focus_lock_tick";
const INTERACTION_HEARTBEAT_TRIGGERS = new Set([
  "keydown",
  "mousedown",
  "mousemove",
  "scroll",
  "touchstart",
  "click",
  "window_focus",
  "visibilitychange",
  "pageshow"
]);
const EXTERNAL_VISOR_URL = ext.runtime.getURL("src/external-visor.html");
const EXTERNAL_VISOR_SIZE = { width: 360, height: 520 };
const state = {
  config: { ...DEFAULT_CONFIG },
  session: createIdleSession(),
  history: []
};

const actionApi = ext.action ?? ext.browserAction ?? null;

let initialized = false;
let tickIntervalId = null;
let tickInFlight = false;
let externalVisorWindowId = null;
let externalVisorSuppressed = false;

function nowMs() {
  return Date.now();
}

function normalizeExternalAppName(input) {
  return String(input ?? "").trim();
}

function buildExternalAppsSession(externalApps) {
  return normalizeExternalApps(externalApps).map((name) => ({
    name,
    enabled: false,
    activeMs: 0
  }));
}

function isExternalOverrideActive(externalApps) {
  return Array.isArray(externalApps) && externalApps.some((app) => app.enabled);
}

function updateExternalOverrideFlag(session) {
  session.externalOverrideActive = isExternalOverrideActive(session.externalApps);
}

async function openExternalVisorWindow() {
  if (externalVisorWindowId) {
    return;
  }
  if (!ext?.windows?.create) {
    return;
  }
  try {
    const baseOptions = {
      url: EXTERNAL_VISOR_URL,
      type: "popup",
      width: EXTERNAL_VISOR_SIZE.width,
      height: EXTERNAL_VISOR_SIZE.height,
      focused: true
    };
    let win = null;
    try {
      win = await ext.windows.create({ ...baseOptions, alwaysOnTop: true });
    } catch {
      win = await ext.windows.create(baseOptions);
    }
    externalVisorWindowId = win?.id ?? null;
  } catch {
    // ignore window open issues
  }
}

async function closeExternalVisorWindow() {
  if (!externalVisorWindowId) {
    return;
  }
  try {
    await ext.windows.remove(externalVisorWindowId);
  } catch {
    // ignore close issues
  } finally {
    externalVisorWindowId = null;
  }
}

async function syncExternalVisorWindow() {
  if (!isActiveCycleStatus(state.session.status)) {
    await closeExternalVisorWindow();
    return;
  }

  if (state.session.externalOverrideActive) {
    if (!externalVisorSuppressed) {
      await openExternalVisorWindow();
    }
    return;
  }

  externalVisorSuppressed = false;
  await closeExternalVisorWindow();
}


function cloneStateForUi() {
  return {
    config: state.config,
    session: state.session,
    history: state.history,
    capabilities: {
      canPreventDisableOrUninstall: false,
      antiTamperMode: "transparent"
    },
    warnings: [
      "Navegadores pessoais não permitem impedir 100% desativação/desinstalação da extensão pelo próprio usuário."
    ]
  };
}

function getSessionWhitelist() {
  if (Array.isArray(state.session.whitelistSnapshot) && state.session.whitelistSnapshot.length > 0) {
    return state.session.whitelistSnapshot;
  }
  return state.config.whitelist;
}

async function persistState() {
  await ext.storage.local.set({
    [STORAGE_KEYS.config]: state.config,
    [STORAGE_KEYS.session]: state.session,
    [STORAGE_KEYS.history]: state.history
  });
}

async function getOverlayPrefs() {
  const saved = await ext.storage.local.get([STORAGE_KEYS.overlayPrefs]);
  return saved?.[STORAGE_KEYS.overlayPrefs] ?? null;
}

async function setOverlayPrefs(prefs) {
  const safePrefs = prefs && typeof prefs === "object" ? prefs : null;
  if (!safePrefs) {
    return;
  }
  await ext.storage.local.set({ [STORAGE_KEYS.overlayPrefs]: safePrefs });
}

async function loadState() {
  const saved = await ext.storage.local.get([
    STORAGE_KEYS.config,
    STORAGE_KEYS.session,
    STORAGE_KEYS.history
  ]);

  state.config = sanitizeConfig(saved[STORAGE_KEYS.config] ?? DEFAULT_CONFIG);
  state.history = sanitizeHistory(saved[STORAGE_KEYS.history] ?? []);

  if (saved[STORAGE_KEYS.session] && typeof saved[STORAGE_KEYS.session] === "object") {
    state.session = {
      ...createIdleSession(),
      ...saved[STORAGE_KEYS.session]
    };
    state.session.displayMode = normalizeDisplayMode(state.session.displayMode, DISPLAY_MODE.POPUP);
  } else {
    state.session = createIdleSession();
  }

  if (!Array.isArray(state.session.externalApps)) {
    state.session.externalApps = [];
  }
  updateExternalOverrideFlag(state.session);

  if (state.session.status === SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT) {
    if (!state.session.unlockedUntilMs || nowMs() >= state.session.unlockedUntilMs) {
      state.session = createIdleSession();
    }
  }

  if (
    isActiveCycleStatus(state.session.status) &&
    state.session.lastLifecycleSignalAtMs &&
    nowMs() - state.session.lastLifecycleSignalAtMs > 5 * MINUTE_MS
  ) {
    state.session.integrityWarnings = [
      ...(state.session.integrityWarnings ?? []),
      {
        atMs: nowMs(),
        type: "session_interruption",
        message:
          "Sessão foi interrompida por um período longo. Isso pode indicar tentativa de bypass ou fechamento do navegador."
      }
    ].slice(-20);
  }
}

function buildBlockPageUrl(blockedUrl) {
  const base = ext.runtime.getURL("src/block.html");
  const params = new URLSearchParams();
  params.set("blocked", blockedUrl);
  return `${base}?${params.toString()}`;
}

async function enforceTab(tab) {
  if (!tab || typeof tab.id !== "number" || !tab.url) {
    return;
  }

  if (!isBlockingStatus(state.session.status)) {
    return;
  }

  const extensionRoot = ext.runtime.getURL("");
  if (tab.url.startsWith(extensionRoot)) {
    return;
  }

  if (!isNavigableHttpUrl(tab.url)) {
    return;
  }

  const whitelist = getSessionWhitelist();
  if (isAllowedUrl(tab.url, whitelist)) {
    return;
  }

  const redirectUrl = buildBlockPageUrl(tab.url);
  if (tab.url === redirectUrl) {
    return;
  }

  await ext.tabs.update(tab.id, { url: redirectUrl });
}

async function enforceActiveTab() {
  if (!isBlockingStatus(state.session.status)) {
    return;
  }

  const tabs = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) {
    return;
  }

  await enforceTab(tabs[0]);
}

async function enforceAllTabs() {
  if (!isBlockingStatus(state.session.status)) {
    return;
  }
  const tabs = await ext.tabs.query({});
  await Promise.all(tabs.map((tab) => enforceTab(tab)));
}

function isInjectableTab(tab) {
  if (!tab || typeof tab.id !== "number" || !tab.url) {
    return false;
  }

  const extensionRoot = ext.runtime.getURL("");
  if (tab.url.startsWith(extensionRoot)) {
    return false;
  }

  if (!isNavigableHttpUrl(tab.url)) {
    return false;
  }

  return true;
}

async function injectContentScriptIntoTab(tabId) {
  if (ext.scripting?.executeScript) {
    await ext.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
    return;
  }

  if (ext.tabs?.executeScript) {
    await ext.tabs.executeScript(tabId, { file: "src/content.js" });
  }
}

async function ensureOverlayInjected() {
  const tabs = await ext.tabs.query({});
  const tasks = tabs.filter(isInjectableTab).map((tab) =>
    injectContentScriptIntoTab(tab.id).catch(() => undefined)
  );
  await Promise.all(tasks);
}

function getBadgeTextForSession() {
  const session = state.session;

  if (session.status === SESSION_STATUS.RUNNING) {
    const minutes = Math.ceil(Math.max(0, session.effectiveRemainingMs) / MINUTE_MS);
    return String(minutes);
  }

  if (session.status === SESSION_STATUS.PAUSED_MANUAL || session.status === SESSION_STATUS.PAUSED_IDLE) {
    return "II";
  }

  if (session.status === SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION) {
    return "OK";
  }

  if (session.status === SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT) {
    return "FREE";
  }

  return "";
}

async function updateBadge() {
  if (!actionApi?.setBadgeText) {
    return;
  }
  const text = getBadgeTextForSession();
  try {
    await actionApi.setBadgeText({ text });
  } catch {
    return;
  }

  const status = state.session.status;
  if (status === SESSION_STATUS.RUNNING) {
    await actionApi.setBadgeBackgroundColor({ color: "#1144cc" });
    return;
  }

  if (status === SESSION_STATUS.PAUSED_MANUAL || status === SESSION_STATUS.PAUSED_IDLE) {
    await actionApi.setBadgeBackgroundColor({ color: "#cc7a00" });
    return;
  }

  if (status === SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION) {
    await actionApi.setBadgeBackgroundColor({ color: "#006d32" });
    return;
  }

  if (status === SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT) {
    await actionApi.setBadgeBackgroundColor({ color: "#2a9d8f" });
    return;
  }

  await actionApi.setBadgeBackgroundColor({ color: "#6c757d" });
}

function setTickLoop() {
  if (tickIntervalId) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }

  let intervalMs = 0;
  if (isActiveCycleStatus(state.session.status)) {
    intervalMs = TICK_MS_ACTIVE;
  } else if (state.session.status === SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT) {
    intervalMs = TICK_MS_UNLOCKED;
  }

  if (intervalMs > 0) {
    tickIntervalId = setInterval(() => {
      void runTickCycle();
    }, intervalMs);
  }
}

async function getFocusContextState(now) {
  const context = await getActiveTabContext();
  const focusState = evaluateFocusActivity({
    nowMs: now,
    lastInteractionAtMs: state.session.lastInteractionAtMs,
    idleTimeoutSeconds: state.config.idleTimeoutSeconds,
    windowFocused: context.windowFocused,
    hasAllowedTab: context.allowed
  });
  return focusState;
}

async function getActiveTabContext() {
  const tabs = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) {
    return {
      tab: null,
      windowFocused: false,
      allowed: false
    };
  }

  const activeTab = tabs[0];
  const allowed = Boolean(activeTab.url && isAllowedUrl(activeTab.url, getSessionWhitelist()));

  let windowFocused = true;
  if (typeof activeTab.windowId === "number") {
    let windowInfo;
    try {
      windowInfo = await ext.windows.get(activeTab.windowId);
    } catch {
      return {
        tab: activeTab,
        windowFocused: false,
        allowed
      };
    }
    windowFocused = Boolean(windowInfo?.focused);
  }

  return {
    tab: activeTab,
    windowFocused,
    allowed
  };
}

async function getFocusedAllowedTab() {
  const context = await getActiveTabContext();
  if (!context.windowFocused || !context.allowed) {
    return null;
  }
  return context.tab;
}

async function isSenderTabActiveAndFocused(tab) {
  if (!tab || typeof tab.id !== "number") {
    return false;
  }

  const windowId = typeof tab.windowId === "number" ? tab.windowId : null;
  if (windowId === null) {
    return Boolean(tab.active);
  }

  let windowInfo;
  try {
    windowInfo = await ext.windows.get(windowId);
  } catch {
    return false;
  }

  if (!windowInfo?.focused) {
    return false;
  }

  if (tab.active) {
    return true;
  }

  const activeTabs = await ext.tabs.query({ active: true, windowId });
  return activeTabs.some((activeTab) => activeTab.id === tab.id);
}

function isInteractionHeartbeatTrigger(trigger) {
  return INTERACTION_HEARTBEAT_TRIGGERS.has(trigger);
}

function updateManualPauseUsage(now) {
  if (state.session.status !== SESSION_STATUS.PAUSED_MANUAL) {
    return;
  }

  if (!state.session.manualPauseStartedAtMs) {
    state.session.manualPauseStartedAtMs = now;
    return;
  }

  const elapsedMs = Math.max(0, now - state.session.manualPauseStartedAtMs);
  if (elapsedMs <= 0) {
    return;
  }

  state.session.manualPauseUsedMs = Math.min(
    state.session.manualPauseLimitMs,
    state.session.manualPauseUsedMs + elapsedMs
  );
  state.session.manualPauseRemainingMs = Math.max(
    0,
    state.session.manualPauseLimitMs - state.session.manualPauseUsedMs
  );
  state.session.manualPauseStartedAtMs = now;
}

function applyIdlePenalty(now) {
  if (state.session.status !== SESSION_STATUS.PAUSED_IDLE) {
    return;
  }
  if (state.session.externalOverrideActive) {
    return;
  }
  if (
    state.session.idlePauseReason === IDLE_PAUSE_REASON.WINDOW_NOT_FOCUSED ||
    state.session.idlePauseReason === IDLE_PAUSE_REASON.EXTERNAL_APP_ACTIVE
  ) {
    return;
  }

  if (!state.session.idlePauseStartedAtMs) {
    state.session.idlePauseStartedAtMs = now;
  }

  const idlePauseDurationMs = Math.max(0, now - state.session.idlePauseStartedAtMs);
  const penaltyResult = calculatePenaltyDeltaMs({
    penaltyEnabled: state.session.penaltyEnabled,
    penaltyCapMs: state.session.penaltyCapMs,
    penaltyAddedMs: state.session.penaltyAddedMs,
    idlePauseDurationMs,
    alreadyAppliedIdleMinutes: state.session.idlePenaltyAppliedMinutes
  });

  if (penaltyResult.deltaMs > 0) {
    state.session.remainingMs += penaltyResult.deltaMs;
    state.session.penaltyAddedMs += penaltyResult.deltaMs;
  }

  state.session.idlePenaltyAppliedMinutes = penaltyResult.newAppliedIdleMinutes;
}

function buildHistoryEntry(now) {
  return {
    id: state.session.sessionId,
    startedAtMs: state.session.startedAtMs,
    completedAtMs: now,
    configuredDurationMs: state.session.configuredDurationMs,
    manualPauseUsedMs: state.session.manualPauseUsedMs,
    penaltyAddedMs: state.session.penaltyAddedMs,
    penaltyEnabled: state.session.penaltyEnabled,
    displayMode: normalizeDisplayMode(state.session.displayMode, DISPLAY_MODE.POPUP),
    idleTimeoutSeconds: state.config.idleTimeoutSeconds,
    status: "completed_pending_confirmation",
    confirmedAtMs: null,
    unlockedUntilMs: null,
    integrityWarnings: state.session.integrityWarnings ?? []
  };
}

async function completeSession(now) {
  const historyEntry = buildHistoryEntry(now);
  state.history = [historyEntry, ...state.history].slice(0, 300);
  state.session.status = SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION;
  state.session.completedAtMs = now;
  state.session.remainingMs = 0;
  state.session.effectiveRemainingMs = 0;
  state.session.lastTickAtMs = now;
  if (Array.isArray(state.session.externalApps)) {
    state.session.externalApps = state.session.externalApps.map((app) => ({
      ...app,
      enabled: false
    }));
  }
  state.session.externalOverrideActive = false;
}

async function runTickCycle() {
  if (tickInFlight) {
    return;
  }
  tickInFlight = true;

  try {
    const now = nowMs();
    state.session.lastLifecycleSignalAtMs = now;

    if (state.session.status === SESSION_STATUS.IDLE) {
      await updateBadge();
      await syncExternalVisorWindow();
      return;
    }

    if (state.session.status === SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT) {
      if (state.session.unlockedUntilMs && now >= state.session.unlockedUntilMs) {
        state.session = createIdleSession();
        setTickLoop();
      }
      await persistState();
      await updateBadge();
      await syncExternalVisorWindow();
      return;
    }

    if (state.session.status === SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION) {
      state.session.effectiveRemainingMs = 0;
      state.session.lastTickAtMs = now;
      await persistState();
      await updateBadge();
      await enforceActiveTab();
      await syncExternalVisorWindow();
      return;
    }

    const previousTick = state.session.lastTickAtMs ?? now;
    const deltaMs = Math.max(0, now - previousTick);
    state.session.lastTickAtMs = now;

    const previousOverride = state.session.externalOverrideActive;
    updateExternalOverrideFlag(state.session);

    if (state.session.status === SESSION_STATUS.PAUSED_MANUAL) {
      updateManualPauseUsage(now);

      if (state.session.externalOverrideActive && Array.isArray(state.session.externalApps)) {
        state.session.externalApps = state.session.externalApps.map((app) => {
          if (!app.enabled) {
            return app;
          }
          return {
            ...app,
            activeMs: (app.activeMs ?? 0) + deltaMs
          };
        });
      }

      if (state.session.manualPauseRemainingMs <= 0) {
        state.session.status = SESSION_STATUS.RUNNING;
        state.session.manualPauseStartedAtMs = null;
      }

      state.session.effectiveRemainingMs = Math.max(0, state.session.remainingMs);
      await persistState();
      await updateBadge();
      await enforceActiveTab();
      if (previousOverride !== state.session.externalOverrideActive) {
        externalVisorSuppressed = false;
      }
      await syncExternalVisorWindow();
      return;
    }

    if (state.session.externalOverrideActive) {
      if (state.session.status !== SESSION_STATUS.RUNNING) {
        state.session.status = SESSION_STATUS.RUNNING;
        state.session.idlePauseStartedAtMs = null;
        state.session.idlePenaltyAppliedMinutes = 0;
        state.session.idlePauseReason = null;
      }

      if (Array.isArray(state.session.externalApps)) {
        state.session.externalApps = state.session.externalApps.map((app) => {
          if (!app.enabled) {
            return app;
          }
          return {
            ...app,
            activeMs: (app.activeMs ?? 0) + deltaMs
          };
        });
      }

      state.session.remainingMs = Math.max(0, state.session.remainingMs - deltaMs);
      state.session.effectiveRemainingMs = state.session.remainingMs;
      if (state.session.remainingMs <= 0) {
        await completeSession(now);
      }

      await persistState();
      await updateBadge();
      await enforceActiveTab();
      if (previousOverride !== state.session.externalOverrideActive) {
        externalVisorSuppressed = false;
      }
      await syncExternalVisorWindow();
      return;
    }

    if (state.session.status === SESSION_STATUS.PAUSED_IDLE) {
      applyIdlePenalty(now);
      const focusState = await getFocusContextState(now);
      if (focusState.isActive) {
        state.session.status = SESSION_STATUS.RUNNING;
        state.session.idlePauseStartedAtMs = null;
        state.session.idlePenaltyAppliedMinutes = 0;
        state.session.idlePauseReason = null;
      } else {
        state.session.idlePauseReason = focusState.reason ?? IDLE_PAUSE_REASON.NO_RECENT_INTERACTION;
      }

      state.session.effectiveRemainingMs = Math.max(0, state.session.remainingMs);
      await persistState();
      await updateBadge();
      await enforceActiveTab();
      if (previousOverride !== state.session.externalOverrideActive) {
        externalVisorSuppressed = false;
      }
      await syncExternalVisorWindow();
      return;
    }

    if (state.session.status === SESSION_STATUS.RUNNING) {
      const focusState = await getFocusContextState(now);
      if (!focusState.isActive) {
        state.session.status = SESSION_STATUS.PAUSED_IDLE;
        state.session.idlePauseStartedAtMs = now;
        state.session.idlePenaltyAppliedMinutes = 0;
        state.session.idlePauseReason = focusState.reason ?? IDLE_PAUSE_REASON.NO_RECENT_INTERACTION;
      } else {
        state.session.remainingMs = Math.max(0, state.session.remainingMs - deltaMs);
        state.session.effectiveRemainingMs = state.session.remainingMs;
      }

      if (state.session.remainingMs <= 0) {
        await completeSession(now);
      }

      await persistState();
      await updateBadge();
      await enforceActiveTab();
      if (previousOverride !== state.session.externalOverrideActive) {
        externalVisorSuppressed = false;
      }
      await syncExternalVisorWindow();
      return;
    }
  } finally {
    tickInFlight = false;
  }
}

function createSessionId(now) {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `focus_${now}_${Math.random().toString(16).slice(2)}`;
}

function ensureConfigEditable() {
  if (isActiveCycleStatus(state.session.status)) {
    throw new Error("Configuração não pode ser alterada durante ciclo de foco ativo.");
  }
}

async function startSession(displayModeInput) {
  if (isActiveCycleStatus(state.session.status)) {
    throw new Error("Já existe uma sessão de foco em andamento.");
  }

  if (!state.config.whitelist.length) {
    throw new Error("Adicione pelo menos um domínio à whitelist antes de iniciar.");
  }

  const now = nowMs();
  const configuredDurationMs = state.config.focusDurationMinutes * MINUTE_MS;
  const manualPauseLimitMs = state.config.manualPauseLimitMinutes * MINUTE_MS;
  const displayMode = normalizeDisplayMode(displayModeInput, DISPLAY_MODE.POPUP);
  const tabContext = await getActiveTabContext();
  const focusedAllowedTab =
    tabContext.windowFocused && tabContext.allowed ? tabContext.tab : null;
  const hasFocusedAllowedPage = Boolean(focusedAllowedTab);
  const initialInteractionAtMs = hasFocusedAllowedPage ? now : null;
  const externalApps = buildExternalAppsSession(state.config.externalApps);
  const focusState = evaluateFocusActivity({
    nowMs: now,
    lastInteractionAtMs: initialInteractionAtMs,
    idleTimeoutSeconds: state.config.idleTimeoutSeconds,
    windowFocused: tabContext.windowFocused,
    hasAllowedTab: tabContext.allowed
  });

  state.session = {
    ...createIdleSession(),
    status: hasFocusedAllowedPage ? SESSION_STATUS.RUNNING : SESSION_STATUS.PAUSED_IDLE,
    sessionId: createSessionId(now),
    startedAtMs: now,
    lastTickAtMs: now,
    lastLifecycleSignalAtMs: now,
    lastInteractionAtMs: initialInteractionAtMs,
    lastInteractionTabId:
      typeof focusedAllowedTab?.id === "number" ? focusedAllowedTab.id : null,
    lastInteractionWindowId:
      typeof focusedAllowedTab?.windowId === "number" ? focusedAllowedTab.windowId : null,
    remainingMs: configuredDurationMs,
    effectiveRemainingMs: configuredDurationMs,
    configuredDurationMs,
    displayMode,
    whitelistSnapshot: [...state.config.whitelist],
    manualPauseLimitMs,
    manualPauseUsedMs: 0,
    manualPauseRemainingMs: manualPauseLimitMs,
    manualPauseStartedAtMs: null,
    penaltyEnabled: state.config.penaltyEnabled,
    penaltyCapMs: state.config.penaltyCapMinutes * MINUTE_MS,
    penaltyAddedMs: 0,
    idlePauseStartedAtMs: hasFocusedAllowedPage ? null : now,
    idlePauseReason: hasFocusedAllowedPage
      ? null
      : focusState.reason ?? IDLE_PAUSE_REASON.NO_RECENT_INTERACTION,
    idlePenaltyAppliedMinutes: 0,
    externalApps,
    externalOverrideActive: false,
    musicOwnerTabId: null,
    unlockRequiresConfirmation: true,
    unlockedUntilMs: null,
    integrityWarnings: []
  };

  setTickLoop();
  await persistState();
  await updateBadge();
  await enforceAllTabs();

  if (displayMode === DISPLAY_MODE.OVERLAY) {
    await ensureOverlayInjected();
  }
}

async function togglePause() {
  const now = nowMs();

  if (state.session.status === SESSION_STATUS.RUNNING) {
    if (state.session.manualPauseRemainingMs <= 0) {
      throw new Error("Limite de pausa manual já foi atingido nesta sessão.");
    }
    state.session.status = SESSION_STATUS.PAUSED_MANUAL;
    state.session.manualPauseStartedAtMs = now;
    state.session.lastTickAtMs = now;
    state.session.idlePauseStartedAtMs = null;
    state.session.idlePauseReason = null;
    state.session.idlePenaltyAppliedMinutes = 0;
    await persistState();
    await updateBadge();
    await enforceActiveTab();
    return;
  }

  if (state.session.status === SESSION_STATUS.PAUSED_MANUAL) {
    updateManualPauseUsage(now);
    state.session.status = SESSION_STATUS.RUNNING;
    state.session.manualPauseStartedAtMs = null;
    state.session.lastTickAtMs = now;
    await persistState();
    await updateBadge();
    await enforceActiveTab();
    return;
  }

  if (state.session.status === SESSION_STATUS.PAUSED_IDLE) {
    const focusState = await getFocusContextState(now);
    if (focusState.isActive) {
      state.session.status = SESSION_STATUS.RUNNING;
      state.session.idlePauseStartedAtMs = null;
      state.session.idlePauseReason = null;
      state.session.idlePenaltyAppliedMinutes = 0;
      state.session.lastTickAtMs = now;
      await persistState();
      await updateBadge();
      await enforceActiveTab();
      return;
    }

    if (state.session.manualPauseRemainingMs <= 0) {
      throw new Error("Sem pausa manual restante e a página ainda está fora de foco.");
    }

    state.session.status = SESSION_STATUS.PAUSED_MANUAL;
    state.session.manualPauseStartedAtMs = now;
    state.session.idlePauseStartedAtMs = null;
    state.session.idlePauseReason = null;
    state.session.idlePenaltyAppliedMinutes = 0;
    state.session.lastTickAtMs = now;
    await persistState();
    await updateBadge();
    await enforceActiveTab();
    return;
  }

  throw new Error("Pausa indisponível para o estado atual.");
}

async function confirmUnlock() {
  if (state.session.status !== SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION) {
    throw new Error("A sessão ainda não está aguardando confirmação de liberação.");
  }

  const now = nowMs();
  const unlockedUntilMs = getNextLocalMidnightMs(now);

  state.session.status = SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT;
  state.session.unlockedUntilMs = unlockedUntilMs;
  state.session.lastTickAtMs = now;

  const historyEntry = state.history.find((entry) => entry.id === state.session.sessionId);
  if (historyEntry) {
    historyEntry.status = "confirmed_unlocked_until_midnight";
    historyEntry.confirmedAtMs = now;
    historyEntry.unlockedUntilMs = unlockedUntilMs;
  }

  setTickLoop();
  await persistState();
  await updateBadge();
}

async function setDisplayMode(displayModeInput) {
  if (!isActiveCycleStatus(state.session.status)) {
    throw new Error("Não há sessão ativa para mudar o modo de visualização.");
  }

  const nextMode = normalizeDisplayMode(displayModeInput, DISPLAY_MODE.POPUP);
  state.session.displayMode = nextMode;
  await persistState();

  if (nextMode === DISPLAY_MODE.OVERLAY) {
    await ensureOverlayInjected();
  }
}

async function saveConfig(nextConfig) {
  ensureConfigEditable();
  state.config = sanitizeConfig(nextConfig);
  await persistState();
  await updateBadge();
}

async function addExternalApp(nameInput) {
  ensureConfigEditable();
  const name = normalizeExternalAppName(nameInput);
  if (!name) {
    throw new Error("Informe um nome de app externo.");
  }
  const nextList = normalizeExternalApps([...(state.config.externalApps ?? []), name]);
  state.config = sanitizeConfig({ ...state.config, externalApps: nextList });
  await persistState();
  await updateBadge();
}

async function removeExternalApp(nameInput) {
  ensureConfigEditable();
  const name = normalizeExternalAppName(nameInput);
  if (!name) {
    throw new Error("Informe o app externo a remover.");
  }
  const target = name.toLowerCase();
  const nextList = (state.config.externalApps ?? []).filter(
    (app) => String(app ?? "").toLowerCase() !== target
  );
  state.config = sanitizeConfig({ ...state.config, externalApps: nextList });
  await persistState();
  await updateBadge();
}

async function toggleExternalApp(nameInput, enabled) {
  if (!isActiveCycleStatus(state.session.status)) {
    throw new Error("Só é possível ativar apps externos durante uma sessão ativa.");
  }
  const name = normalizeExternalAppName(nameInput);
  if (!name) {
    throw new Error("Informe o app externo.");
  }

  const target = name.toLowerCase();
  let found = false;
  state.session.externalApps = (state.session.externalApps ?? []).map((app) => {
    if (String(app?.name ?? "").toLowerCase() !== target) {
      return app;
    }
    found = true;
    return {
      ...app,
      enabled: Boolean(enabled)
    };
  });

  if (!found) {
    throw new Error("App externo não encontrado.");
  }

  const prevOverride = state.session.externalOverrideActive;
  updateExternalOverrideFlag(state.session);
  const now = nowMs();
  externalVisorSuppressed = false;
  if (state.session.externalOverrideActive) {
    if (state.session.status !== SESSION_STATUS.PAUSED_MANUAL) {
      state.session.status = SESSION_STATUS.RUNNING;
      state.session.manualPauseStartedAtMs = null;
      state.session.idlePauseStartedAtMs = null;
      state.session.idlePauseReason = null;
      state.session.idlePenaltyAppliedMinutes = 0;
    }
    state.session.lastTickAtMs = now;
  } else if (prevOverride && !state.session.externalOverrideActive) {
    if (state.session.status !== SESSION_STATUS.PAUSED_MANUAL) {
      const focusState = await getFocusContextState(now);
      if (focusState.isActive) {
        state.session.status = SESSION_STATUS.RUNNING;
        state.session.idlePauseStartedAtMs = null;
        state.session.idlePauseReason = null;
        state.session.idlePenaltyAppliedMinutes = 0;
      } else {
        state.session.status = SESSION_STATUS.PAUSED_IDLE;
        state.session.idlePauseStartedAtMs = now;
        state.session.idlePauseReason =
          focusState.reason ?? IDLE_PAUSE_REASON.NO_RECENT_INTERACTION;
        state.session.idlePenaltyAppliedMinutes = 0;
      }
      state.session.manualPauseStartedAtMs = null;
    }
    state.session.lastTickAtMs = now;
  }

  await persistState();
  await updateBadge();
  await enforceActiveTab();
  await syncExternalVisorWindow();
}

async function importData(rawText) {
  ensureConfigEditable();

  const parsed = parseImportPayload(rawText);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  state.config = parsed.value.config;
  state.history = parsed.value.history;
  state.session = createIdleSession();

  setTickLoop();
  await persistState();
  await updateBadge();
}

async function claimMusicOwner(sender) {
  if (!isActiveCycleStatus(state.session.status)) {
    throw new Error("Não há sessão ativa para assumir o player.");
  }
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("Aba inválida para assumir o player.");
  }
  const tabUrl = sender?.tab?.url ?? "";
  if (!isAllowedUrl(tabUrl, getSessionWhitelist())) {
    throw new Error("O player só pode ser assumido em uma aba permitida.");
  }

  state.session.musicOwnerTabId = tabId;
  await persistState();
}

async function handleHeartbeat(message, sender) {
  if (!isActiveCycleStatus(state.session.status)) {
    return;
  }

  const tab = sender.tab;
  const trigger = typeof message.trigger === "string" ? message.trigger : "";
  const url = typeof message.url === "string" ? message.url : tab?.url;
  if (!url || !isAllowedUrl(url, getSessionWhitelist())) {
    return;
  }

  if (!isInteractionHeartbeatTrigger(trigger)) {
    return;
  }

  if (!(await isSenderTabActiveAndFocused(tab))) {
    return;
  }

  const now = nowMs();
  state.session.lastInteractionAtMs = now;
  state.session.lastLifecycleSignalAtMs = now;
  state.session.lastInteractionTabId = tab.id;
  state.session.lastInteractionWindowId =
    typeof tab.windowId === "number" ? tab.windowId : null;

  await persistState();
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Mensagem inválida." };
  }

  switch (message.type) {
    case "GET_STATE":
      return {
        ok: true,
        data: {
          ...cloneStateForUi(),
          context: {
            isMusicOwner:
              typeof sender?.tab?.id === "number" &&
              sender.tab.id === state.session.musicOwnerTabId
          }
        }
      };

    case "SAVE_CONFIG":
      await saveConfig({ ...state.config, ...message.config });
      return { ok: true, data: cloneStateForUi() };

    case "ADD_EXTERNAL_APP":
      await addExternalApp(message.name);
      return { ok: true, data: cloneStateForUi() };

    case "REMOVE_EXTERNAL_APP":
      await removeExternalApp(message.name);
      return { ok: true, data: cloneStateForUi() };

    case "START_SESSION":
      await startSession(message.displayMode);
      return { ok: true, data: cloneStateForUi() };

    case "SET_DISPLAY_MODE":
      await setDisplayMode(message.displayMode);
      return { ok: true, data: cloneStateForUi() };

    case "TOGGLE_PAUSE":
      await togglePause();
      return { ok: true, data: cloneStateForUi() };

    case "TOGGLE_EXTERNAL_APP":
      await toggleExternalApp(message.name, message.enabled);
      return { ok: true, data: cloneStateForUi() };

    case "CONFIRM_UNLOCK":
      await confirmUnlock();
      return { ok: true, data: cloneStateForUi() };

    case "EXPORT_DATA":
      return {
        ok: true,
        data: buildExportPayload({ config: state.config, history: state.history })
      };

    case "IMPORT_DATA":
      await importData(message.rawText ?? "");
      return { ok: true, data: cloneStateForUi() };

    case "HEARTBEAT":
      await handleHeartbeat(message, sender);
      return { ok: true };

    case "CLAIM_MUSIC_OWNER":
      await claimMusicOwner(sender);
      return { ok: true, data: cloneStateForUi() };

    case "GET_OVERLAY_PREFS": {
      const prefs = await getOverlayPrefs();
      return { ok: true, data: prefs };
    }

    case "SET_OVERLAY_PREFS":
      await setOverlayPrefs(message.prefs);
      return { ok: true };

    default:
      return { ok: false, error: "Tipo de mensagem não suportado." };
  }
}

async function initAlarm() {
  try {
    await ext.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  } catch {
    // Ignore alarm issues; interval loop remains active while service worker is alive.
  }
}

function registerListeners() {
  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  });

  ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      void enforceTab(tab).catch(() => undefined);
    }
    if (
      typeof tabId === "number" &&
      tabId === state.session.musicOwnerTabId &&
      tab?.url &&
      !isAllowedUrl(tab.url, getSessionWhitelist())
    ) {
      state.session.musicOwnerTabId = null;
      void persistState();
    }
  });

  ext.tabs.onActivated.addListener((activeInfo) => {
    void ext.tabs
      .get(activeInfo.tabId)
      .then((tab) => enforceTab(tab))
      .catch(() => undefined);
  });

  ext.tabs.onRemoved.addListener((tabId) => {
    if (tabId === state.session.musicOwnerTabId) {
      state.session.musicOwnerTabId = null;
      void persistState();
    }
  });

  ext.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === ext.windows.WINDOW_ID_NONE) {
      return;
    }

    void ext.tabs
      .query({ active: true, windowId })
      .then((tabs) => {
        if (tabs.length > 0) {
          return enforceTab(tabs[0]);
        }
        return undefined;
      })
      .catch(() => undefined);
  });

  ext.windows.onRemoved.addListener((windowId) => {
    if (windowId === externalVisorWindowId) {
      externalVisorWindowId = null;
      externalVisorSuppressed = true;
    }
  });

  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === ALARM_NAME) {
      void runTickCycle();
    }
  });
}

async function bootstrap() {
  if (initialized) {
    return;
  }
  initialized = true;

  await loadState();
  await persistState();
  await updateBadge();
  setTickLoop();
  await initAlarm();

  if (isBlockingStatus(state.session.status)) {
    await enforceAllTabs();
  }

  if (isActiveCycleStatus(state.session.status) && state.session.displayMode === DISPLAY_MODE.OVERLAY) {
    await ensureOverlayInjected();
  }

  await syncExternalVisorWindow();
}

registerListeners();
void bootstrap();
