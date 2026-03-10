import { SESSION_STATUS } from "./shared/constants.js";
import { DISPLAY_MODE, displayModeLabel, normalizeDisplayMode } from "./shared/displayMode.js";
import { normalizeMusicUrl } from "./shared/music.js";
import { formatDurationMs } from "./shared/time.js";
import { normalizeWhitelist } from "./shared/whitelist.js";

const ext = globalThis.browser ?? globalThis.chrome;

const el = {
  sessionStatus: document.getElementById("session-status"),
  displayMode: document.getElementById("display-mode"),
  remainingTime: document.getElementById("remaining-time"),
  penaltyAdded: document.getElementById("penalty-added"),
  pauseLeft: document.getElementById("pause-left"),
  idleTime: document.getElementById("idle-time"),
  whitelistInput: document.getElementById("whitelist-input"),
  focusDuration: document.getElementById("focus-duration"),
  pauseLimit: document.getElementById("pause-limit"),
  idleTimeoutMinutes: document.getElementById("idle-timeout-minutes"),
  penaltyEnabled: document.getElementById("penalty-enabled"),
  externalAppName: document.getElementById("external-app-name"),
  addExternalApp: document.getElementById("add-external-app"),
  externalAppList: document.getElementById("external-app-list"),
  tabButtons: Array.from(document.querySelectorAll(".tab-btn")),
  tabContents: Array.from(document.querySelectorAll(".tab-content")),
  musicUrl: document.getElementById("music-url"),
  saveMusic: document.getElementById("save-music"),
  clearMusic: document.getElementById("clear-music"),
  saveConfig: document.getElementById("save-config"),
  startSession: document.getElementById("start-session"),
  startChoice: document.getElementById("start-choice"),
  startChoiceText: document.getElementById("start-choice-text"),
  startWithPopup: document.getElementById("start-with-popup"),
  startWithOverlay: document.getElementById("start-with-overlay"),
  cancelStartChoice: document.getElementById("cancel-start-choice"),
  toggleDisplayMode: document.getElementById("toggle-display-mode"),
  togglePause: document.getElementById("toggle-pause"),
  confirmUnlock: document.getElementById("confirm-unlock"),
  exportData: document.getElementById("export-data"),
  importFile: document.getElementById("import-file"),
  feedback: document.getElementById("feedback"),
  integrityList: document.getElementById("integrity-list")
};

let latestState = null;
let pollingId = null;
let formDirty = false;
let musicDirty = false;
const LAST_DISPLAY_MODE_KEY = "focus_lock_last_display_mode";
const LAST_TAB_KEY = "focus_lock_last_tab";

function setFeedback(message, isError = false) {
  if (!el.feedback) {
    return;
  }
  el.feedback.textContent = message;
  el.feedback.classList.remove("success", "error", "visible");
  void el.feedback.offsetWidth;
  el.feedback.classList.add("visible", isError ? "error" : "success");
}

async function sendMessage(message) {
  const response = await ext.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "Falha na operação.");
  }
  return response.data;
}

function getSuggestedDisplayMode() {
  try {
    const stored = window.localStorage.getItem(LAST_DISPLAY_MODE_KEY);
    return normalizeDisplayMode(stored, DISPLAY_MODE.OVERLAY);
  } catch {
    return DISPLAY_MODE.OVERLAY;
  }
}

function saveSuggestedDisplayMode(mode) {
  try {
    window.localStorage.setItem(
      LAST_DISPLAY_MODE_KEY,
      normalizeDisplayMode(mode, DISPLAY_MODE.POPUP)
    );
  } catch {
    // localStorage may be unavailable in strict privacy modes.
  }
}

function closeStartChoice() {
  el.startChoice.classList.add("hidden");
}

function openStartChoice() {
  const suggested = getSuggestedDisplayMode();
  const suggestedLabel = displayModeLabel(suggested);
  el.startChoiceText.textContent =
    `Como você quer acompanhar esta sessão? Sugestão: ${suggestedLabel}.`;
  el.startChoice.classList.remove("hidden");
}

function setActiveTab(tabId) {
  el.tabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  el.tabContents.forEach((content) => {
    content.classList.toggle("active", content.id === `tab-${tabId}`);
  });
  try {
    window.localStorage.setItem(LAST_TAB_KEY, tabId);
  } catch {
    // ignore storage issues
  }
}

function initTabs() {
  let initial = "focus";
  try {
    const stored = window.localStorage.getItem(LAST_TAB_KEY);
    if (stored) {
      initial = stored;
    }
  } catch {
    // ignore storage issues
  }
  setActiveTab(initial);
  el.tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
}

function idleReasonLabel(reason) {
  if (reason === "page_out_of_focus") {
    return "página fora de foco";
  }
  if (reason === "window_not_focused") {
    return "navegador sem foco";
  }
  if (reason === "no_recent_interaction") {
    return "sem interação recente";
  }
  if (reason === "external_app_active") {
    return "app externo ativo";
  }
  return "sem atividade";
}

function statusLabel(session) {
  switch (session.status) {
    case SESSION_STATUS.IDLE:
      return "Aguardando";
    case SESSION_STATUS.RUNNING:
      return "Foco em execução";
    case SESSION_STATUS.PAUSED_MANUAL:
      return "Pausa manual";
    case SESSION_STATUS.PAUSED_IDLE:
      return `Pausa por inatividade (${idleReasonLabel(session.idlePauseReason)})`;
    case SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION:
      return "Concluído, aguardando confirmação";
    case SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT:
      return "Livre até meia-noite";
    default:
      return session.status;
  }
}

function isActiveCycle(status) {
  return (
    status === SESSION_STATUS.RUNNING ||
    status === SESSION_STATUS.PAUSED_MANUAL ||
    status === SESSION_STATUS.PAUSED_IDLE ||
    status === SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION
  );
}

function renderIntegrityWarnings(session) {
  const warnings = Array.isArray(session?.integrityWarnings) ? session.integrityWarnings : [];
  el.integrityList.innerHTML = "";

  if (!warnings.length) {
    const li = document.createElement("li");
    li.textContent = "Nenhum alerta de integridade registrado nesta sessão.";
    el.integrityList.appendChild(li);
    return;
  }

  warnings.slice(-5).forEach((warning) => {
    const li = document.createElement("li");
    const at = warning?.atMs ? new Date(warning.atMs).toLocaleString() : "momento desconhecido";
    li.textContent = `${at}: ${warning?.message ?? "interrupção detectada"}`;
    el.integrityList.appendChild(li);
  });
}

function canToggleExternalApps(session) {
  return (
    session.status === SESSION_STATUS.RUNNING ||
    session.status === SESSION_STATUS.PAUSED_MANUAL ||
    session.status === SESSION_STATUS.PAUSED_IDLE
  );
}

function resolveExternalAppsForUi(config, session) {
  if (isActiveCycle(session.status) && Array.isArray(session.externalApps)) {
    return session.externalApps;
  }
  return (config.externalApps ?? []).map((name) => ({
    name,
    enabled: false,
    activeMs: 0
  }));
}

function renderExternalApps(config, session) {
  const externalApps = resolveExternalAppsForUi(config, session);
  el.externalAppList.innerHTML = "";

  if (!externalApps.length) {
    const empty = document.createElement("div");
    empty.className = "external-app-empty";
    empty.textContent = "Nenhum app externo cadastrado.";
    el.externalAppList.appendChild(empty);
    return;
  }

  const togglesEnabled = canToggleExternalApps(session);
  const canEdit = !isActiveCycle(session.status);

  externalApps.forEach((app) => {
    const row = document.createElement("div");
    row.className = "external-app-row";

    const meta = document.createElement("div");
    meta.className = "external-app-meta";
    const name = document.createElement("div");
    name.className = "external-app-name";
    name.textContent = app.name;
    const time = document.createElement("div");
    time.className = "external-app-time";
    time.textContent = `Uso: ${formatDurationMs(app.activeMs ?? 0)}`;
    meta.appendChild(name);
    meta.appendChild(time);

    const actions = document.createElement("div");
    actions.className = "external-app-actions";

    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(app.enabled);
    checkbox.disabled = !togglesEnabled;
    checkbox.addEventListener("change", () => {
      void safeAction(async () => {
        await sendMessage({
          type: "TOGGLE_EXTERNAL_APP",
          name: app.name,
          enabled: checkbox.checked
        });
        await refreshState();
      });
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(slider);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn external-app-remove";
    remove.textContent = "Remover";
    remove.disabled = !canEdit;
    remove.addEventListener("click", () => {
      void safeAction(async () => {
        await sendMessage({ type: "REMOVE_EXTERNAL_APP", name: app.name });
        await refreshState();
      });
    });

    actions.appendChild(switchLabel);
    actions.appendChild(remove);

    row.appendChild(meta);
    row.appendChild(actions);
    el.externalAppList.appendChild(row);
  });
}

function render(state) {
  latestState = state;
  const { config, session } = state;

  el.sessionStatus.textContent = statusLabel(session);
  el.displayMode.textContent = displayModeLabel(session.displayMode);
  el.remainingTime.textContent = formatDurationMs(session.effectiveRemainingMs ?? session.remainingMs ?? 0);
  el.penaltyAdded.textContent = formatDurationMs(session.penaltyAddedMs ?? 0);
  el.pauseLeft.textContent = formatDurationMs(session.manualPauseRemainingMs ?? 0);
  const idleMs =
    session.status === SESSION_STATUS.PAUSED_IDLE && session.idlePauseStartedAtMs
      ? Math.max(0, Date.now() - session.idlePauseStartedAtMs)
      : 0;
  el.idleTime.textContent = formatDurationMs(idleMs);
  if (idleMs > 0) {
    el.idleTime.classList.remove("idle-off");
  } else {
    el.idleTime.classList.add("idle-off");
  }

  const configLocked = isActiveCycle(session.status);
  if (configLocked || !formDirty) {
    fillConfigForm(config);
  }
  if (configLocked || !musicDirty) {
    fillMusicForm(config);
  }

  el.whitelistInput.disabled = configLocked;
  el.focusDuration.disabled = configLocked;
  el.pauseLimit.disabled = configLocked;
  el.idleTimeoutMinutes.disabled = configLocked;
  el.penaltyEnabled.disabled = configLocked;
  el.saveConfig.disabled = configLocked;
  el.externalAppName.disabled = configLocked;
  el.addExternalApp.disabled = configLocked;
  el.musicUrl.disabled = configLocked;
  el.saveMusic.disabled = configLocked;
  el.clearMusic.disabled = configLocked;

  el.startSession.disabled = isActiveCycle(session.status);
  if (isActiveCycle(session.status)) {
    closeStartChoice();
  }
  if (session.externalOverrideActive) {
    el.togglePause.disabled = true;
  } else {
    el.togglePause.disabled = !(
      session.status === SESSION_STATUS.RUNNING ||
      session.status === SESSION_STATUS.PAUSED_MANUAL ||
      session.status === SESSION_STATUS.PAUSED_IDLE
    );
  }
  el.confirmUnlock.disabled = session.status !== SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION;
  el.toggleDisplayMode.disabled = !isActiveCycle(session.status);
  if (isActiveCycle(session.status)) {
    el.toggleDisplayMode.textContent =
      session.displayMode === DISPLAY_MODE.OVERLAY ? "Ocultar visor" : "Mostrar visor";
  } else {
    el.toggleDisplayMode.textContent = "Mostrar visor";
  }

  renderIntegrityWarnings(session);
  renderExternalApps(config, session);
}

function fillConfigForm(config) {
  el.whitelistInput.value = (config.whitelist ?? []).join("\n");
  el.focusDuration.value = String(config.focusDurationMinutes ?? 25);
  el.pauseLimit.value = String(config.manualPauseLimitMinutes ?? 10);
  const idleMinutes = (config.idleTimeoutSeconds ?? 120) / 60;
  el.idleTimeoutMinutes.value = String(Number.isInteger(idleMinutes) ? idleMinutes : idleMinutes.toFixed(1));
  el.penaltyEnabled.checked = Boolean(config.penaltyEnabled);
}

function fillMusicForm(config) {
  el.musicUrl.value = config.musicUrl ?? "";
}

async function refreshState() {
  const state = await sendMessage({ type: "GET_STATE" });
  render(state);
}

function configFromForm() {
  const whitelist = normalizeWhitelist(
    el.whitelistInput.value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const timeoutMinutes = Number(el.idleTimeoutMinutes.value);
  const idleTimeoutSeconds = Number.isFinite(timeoutMinutes)
    ? Math.round(timeoutMinutes * 60)
    : latestState?.config?.idleTimeoutSeconds;

  return {
    ...(latestState?.config ?? {}),
    whitelist,
    focusDurationMinutes: Number(el.focusDuration.value),
    manualPauseLimitMinutes: Number(el.pauseLimit.value),
    idleTimeoutSeconds,
    penaltyEnabled: Boolean(el.penaltyEnabled.checked)
  };
}

async function onAddExternalApp() {
  const name = el.externalAppName.value.trim();
  if (!name) {
    setFeedback("Informe o nome do app externo.", true);
    return;
  }
  const state = await sendMessage({ type: "ADD_EXTERNAL_APP", name });
  el.externalAppName.value = "";
  render(state);
  setFeedback("App externo adicionado.");
}

async function onSaveConfig() {
  const config = configFromForm();
  const state = await sendMessage({ type: "SAVE_CONFIG", config });
  formDirty = false;
  render(state);
  setFeedback("Configuração salva.");
}

async function onSaveMusic() {
  const raw = el.musicUrl.value.trim();
  const normalized = normalizeMusicUrl(raw);
  if (raw && !normalized) {
    setFeedback("Link inválido. Use um link do YouTube ou YouTube Music.", true);
    return;
  }
  const state = await sendMessage({
    type: "SAVE_CONFIG",
    config: { ...latestState?.config, musicUrl: normalized }
  });
  musicDirty = false;
  render(state);
  setFeedback("Música salva.");
}

async function onClearMusic() {
  const state = await sendMessage({
    type: "SAVE_CONFIG",
    config: { ...latestState?.config, musicUrl: "" }
  });
  musicDirty = false;
  render(state);
  setFeedback("Música removida.");
}

async function startSessionWithDisplayMode(mode) {
  const normalizedMode = normalizeDisplayMode(mode, DISPLAY_MODE.POPUP);
  const state = await sendMessage({ type: "START_SESSION", displayMode: normalizedMode });
  saveSuggestedDisplayMode(normalizedMode);
  closeStartChoice();
  render(state);
  setFeedback(`Sessão iniciada com ${displayModeLabel(normalizedMode).toLowerCase()}.`);
}

async function onStartSession() {
  openStartChoice();
}

async function onTogglePause() {
  const state = await sendMessage({ type: "TOGGLE_PAUSE" });
  render(state);
  setFeedback("Estado de pausa atualizado.");
}

async function onConfirmUnlock() {
  const state = await sendMessage({ type: "CONFIRM_UNLOCK" });
  render(state);
  setFeedback("Navegação liberada até meia-noite local.");
}

async function onToggleDisplayMode() {
  const currentMode = latestState?.session?.displayMode ?? DISPLAY_MODE.POPUP;
  const nextMode = currentMode === DISPLAY_MODE.OVERLAY ? DISPLAY_MODE.POPUP : DISPLAY_MODE.OVERLAY;
  const state = await sendMessage({ type: "SET_DISPLAY_MODE", displayMode: nextMode });
  render(state);
  setFeedback(`Modo alterado para ${displayModeLabel(nextMode).toLowerCase()}.`);
}

async function onExport() {
  const payload = await sendMessage({ type: "EXPORT_DATA" });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  anchor.href = url;
  anchor.download = `focus-lock-backup-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setFeedback("Backup exportado.");
}

async function onImport(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const rawText = await file.text();
  const state = await sendMessage({ type: "IMPORT_DATA", rawText });
  formDirty = false;
  render(state);
  setFeedback("Backup importado com sucesso.");
  el.importFile.value = "";
}

async function safeAction(action) {
  try {
    await action();
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : String(error), true);
  }
}

function startPolling() {
  pollingId = setInterval(() => {
    void safeAction(refreshState);
  }, 1000);
}

function stopPolling() {
  if (pollingId) {
    clearInterval(pollingId);
    pollingId = null;
  }
}

function markFormDirty() {
  formDirty = true;
}

el.saveConfig.addEventListener("click", () => void safeAction(onSaveConfig));
el.startSession.addEventListener("click", () => void safeAction(onStartSession));
el.startWithPopup.addEventListener("click", () =>
  void safeAction(() => startSessionWithDisplayMode(DISPLAY_MODE.POPUP))
);
el.startWithOverlay.addEventListener("click", () =>
  void safeAction(() => startSessionWithDisplayMode(DISPLAY_MODE.OVERLAY))
);
el.cancelStartChoice.addEventListener("click", closeStartChoice);
el.togglePause.addEventListener("click", () => void safeAction(onTogglePause));
el.toggleDisplayMode.addEventListener("click", () => void safeAction(onToggleDisplayMode));
el.confirmUnlock.addEventListener("click", () => void safeAction(onConfirmUnlock));
el.exportData.addEventListener("click", () => void safeAction(onExport));
el.importFile.addEventListener("change", (event) => void safeAction(() => onImport(event)));
el.addExternalApp.addEventListener("click", () => void safeAction(onAddExternalApp));
el.saveMusic.addEventListener("click", () => void safeAction(onSaveMusic));
el.clearMusic.addEventListener("click", () => void safeAction(onClearMusic));
el.externalAppName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void safeAction(onAddExternalApp);
  }
});
el.whitelistInput.addEventListener("input", markFormDirty);
el.focusDuration.addEventListener("input", markFormDirty);
el.pauseLimit.addEventListener("input", markFormDirty);
el.idleTimeoutMinutes.addEventListener("input", markFormDirty);
el.penaltyEnabled.addEventListener("change", markFormDirty);
el.musicUrl.addEventListener("input", () => {
  musicDirty = true;
});

window.addEventListener("beforeunload", stopPolling);

void safeAction(async () => {
  await refreshState();
  initTabs();
  startPolling();
});
