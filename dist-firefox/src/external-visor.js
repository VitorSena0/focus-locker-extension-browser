import { SESSION_STATUS } from "./shared/constants.js";
import { formatDurationMs } from "./shared/time.js";

const ext = globalThis.browser ?? globalThis.chrome;

const el = {
  remaining: document.getElementById("remaining"),
  status: document.getElementById("status"),
  externalApps: document.getElementById("external-apps")
};

async function sendMessage(message) {
  const response = await ext.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "Falha na operação.");
  }
  return response.data;
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

function canToggleExternalApps(session) {
  return (
    session.status === SESSION_STATUS.RUNNING ||
    session.status === SESSION_STATUS.PAUSED_MANUAL ||
    session.status === SESSION_STATUS.PAUSED_IDLE
  );
}

function renderExternalApps(session) {
  el.externalApps.innerHTML = "";
  const apps = Array.isArray(session.externalApps) ? session.externalApps : [];
  if (!apps.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nenhum app externo cadastrado.";
    el.externalApps.appendChild(empty);
    return;
  }

  const togglesEnabled = canToggleExternalApps(session);
  apps.forEach((app) => {
    const row = document.createElement("div");
    row.className = "external-app-row";

    const meta = document.createElement("div");
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
      void sendMessage({
        type: "TOGGLE_EXTERNAL_APP",
        name: app.name,
        enabled: checkbox.checked
      }).catch(() => undefined);
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(slider);

    actions.appendChild(switchLabel);

    row.appendChild(meta);
    row.appendChild(actions);
    el.externalApps.appendChild(row);
  });
}

function render(state) {
  const { session } = state;
  el.remaining.textContent = formatDurationMs(session.effectiveRemainingMs ?? session.remainingMs ?? 0);
  el.status.textContent = statusLabel(session);
  renderExternalApps(session);
}

async function refresh() {
  const state = await sendMessage({ type: "GET_STATE" });
  render(state);
}

setInterval(() => {
  void refresh().catch(() => undefined);
}, 1000);

void refresh().catch(() => undefined);
