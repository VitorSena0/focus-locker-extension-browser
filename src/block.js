import { SESSION_STATUS } from "./shared/constants.js";
import { formatDurationMs } from "./shared/time.js";

const ext = globalThis.browser ?? globalThis.chrome;

const blockedDomainEl = document.getElementById("blocked-domain");
const statusTextEl = document.getElementById("status-text");
const remainingEl = document.getElementById("remaining");
const penaltyEl = document.getElementById("penalty");
const manualPauseEl = document.getElementById("manual-pause");
const idleTimeEl = document.getElementById("idle-time");
const pauseBtn = document.getElementById("pause-btn");
const reloadBtn = document.getElementById("reload-btn");

let pollId = null;

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
    case SESSION_STATUS.RUNNING:
      return "Sessão em execução";
    case SESSION_STATUS.PAUSED_MANUAL:
      return "Sessão em pausa manual";
    case SESSION_STATUS.PAUSED_IDLE:
      return `Sessão pausada por inatividade (${idleReasonLabel(session.idlePauseReason)})`;
    case SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION:
      return "Sessão concluída. Abra o popup e confirme a liberação do dia.";
    case SESSION_STATUS.UNLOCKED_UNTIL_MIDNIGHT:
      return "Livre até meia-noite local.";
    case SESSION_STATUS.IDLE:
      return "Sem sessão ativa no momento.";
    default:
      return session.status;
  }
}

function getBlockedDomain() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("blocked");
  if (!raw) {
    return "domínio desconhecido";
  }

  try {
    const parsed = new URL(raw);
    return parsed.hostname;
  } catch {
    return raw;
  }
}

async function sendMessage(message) {
  const response = await ext.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "Falha na comunicação com a extensão.");
  }
  return response.data;
}

async function refresh() {
  const data = await sendMessage({ type: "GET_STATE" });
  const session = data.session;

  statusTextEl.textContent = statusLabel(session);
  remainingEl.textContent = formatDurationMs(session.effectiveRemainingMs ?? session.remainingMs ?? 0);
  penaltyEl.textContent = formatDurationMs(session.penaltyAddedMs ?? 0);
  manualPauseEl.textContent = formatDurationMs(session.manualPauseRemainingMs ?? 0);
  const idleMs =
    session.status === SESSION_STATUS.PAUSED_IDLE && session.idlePauseStartedAtMs
      ? Math.max(0, Date.now() - session.idlePauseStartedAtMs)
      : 0;
  idleTimeEl.textContent = formatDurationMs(idleMs);
  if (idleMs > 0) {
    idleTimeEl.classList.remove("idle-off");
  } else {
    idleTimeEl.classList.add("idle-off");
  }

  pauseBtn.disabled = !(
    session.status === SESSION_STATUS.RUNNING ||
    session.status === SESSION_STATUS.PAUSED_MANUAL ||
    session.status === SESSION_STATUS.PAUSED_IDLE
  );
}

async function togglePause() {
  await sendMessage({ type: "TOGGLE_PAUSE" });
  await refresh();
}

blockedDomainEl.textContent = getBlockedDomain();

pauseBtn.addEventListener("click", () => {
  void togglePause().catch((error) => {
    statusTextEl.textContent = error instanceof Error ? error.message : String(error);
  });
});

reloadBtn.addEventListener("click", () => {
  window.history.back();
});

pollId = setInterval(() => {
  void refresh().catch(() => undefined);
}, 1000);

window.addEventListener("beforeunload", () => {
  if (pollId) {
    clearInterval(pollId);
    pollId = null;
  }
});

void refresh().catch((error) => {
  statusTextEl.textContent = error instanceof Error ? error.message : String(error);
});
