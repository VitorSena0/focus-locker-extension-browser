(() => {
  if (globalThis.__focusLockContentInitialized) {
    return;
  }
  globalThis.__focusLockContentInitialized = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  if (!ext?.runtime?.sendMessage) {
    return;
  }

  const HEARTBEAT_THROTTLE_MS = 5000;
  const PERIODIC_HEARTBEAT_MS = 30000;
  const MONITOR_REFRESH_MS = 1000;
  const OVERLAY_PREFS_KEY = "focus_lock_overlay_prefs";
  const DEFAULT_OVERLAY_PREFS = {
    left: null,
    top: 14,
    width: 248,
    height: null,
    minimized: false,
    restoreWidth: 248,
    restoreHeight: null
  };

  const SESSION_STATUS = {
    RUNNING: "running",
    PAUSED_MANUAL: "paused_manual",
    PAUSED_IDLE: "paused_idle",
    COMPLETED_PENDING_CONFIRMATION: "completed_pending_confirmation"
  };

  const ACTIVE_VISOR_STATUSES = new Set([
    SESSION_STATUS.RUNNING,
    SESSION_STATUS.PAUSED_MANUAL,
    SESSION_STATUS.PAUSED_IDLE,
    SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION
  ]);

  let lastHeartbeatAt = 0;
  let monitorHost = null;
  let monitorShadow = null;
  let monitorMounted = false;
  let overlayPrefs = { ...DEFAULT_OVERLAY_PREFS };
  let overlaySaveTimer = null;
  let currentMusicEmbedUrl = "";
  let musicClaimPending = false;

  function sendMessageRuntime(payload) {
    if (globalThis.browser?.runtime?.sendMessage) {
      return globalThis.browser.runtime.sendMessage(payload);
    }

    return new Promise((resolve, reject) => {
      globalThis.chrome.runtime.sendMessage(payload, (response) => {
        const err = globalThis.chrome.runtime?.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function buildYoutubeEmbedUrl(input) {
    const value = String(input ?? "").trim();
    if (!value) {
      return "";
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      return "";
    }
    const host = url.hostname.toLowerCase();
    const allowed = new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be"
    ]);
    if (!allowed.has(host)) {
      return "";
    }
    const list = url.searchParams.get("list");
    let videoId = url.searchParams.get("v") ?? "";
    if (!videoId && host === "youtu.be") {
      videoId = url.pathname.replace("/", "");
    }
    if (url.pathname.startsWith("/embed/")) {
      return decorateEmbedUrl(`https://www.youtube.com${url.pathname}${url.search}`);
    }
    if (list && videoId) {
      return decorateEmbedUrl(`https://www.youtube.com/embed/${videoId}?list=${list}`);
    }
    if (list) {
      return decorateEmbedUrl(`https://www.youtube.com/embed/videoseries?list=${list}`);
    }
    if (videoId) {
      return decorateEmbedUrl(`https://www.youtube.com/embed/${videoId}`);
    }
    return "";
  }

  function decorateEmbedUrl(rawUrl) {
    let embedUrl;
    try {
      embedUrl = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    embedUrl.searchParams.set("playsinline", "1");
    embedUrl.searchParams.set("rel", "0");
    embedUrl.searchParams.set("modestbranding", "1");
    if (window.location.origin.startsWith("http")) {
      embedUrl.searchParams.set("origin", window.location.origin);
    }
    return embedUrl.toString();
  }

  async function loadOverlayPrefs() {
    try {
      const response = await sendMessageRuntime({ type: "GET_OVERLAY_PREFS" });
      const saved = response?.ok ? response.data : null;
      if (saved && typeof saved === "object") {
        overlayPrefs = {
          ...DEFAULT_OVERLAY_PREFS,
          ...saved
        };
      }
    } catch {
      // ignore storage issues when extension is reloading
    }
  }

  function scheduleOverlayPrefsSave(nextPrefs) {
    overlayPrefs = { ...overlayPrefs, ...nextPrefs };
    if (overlaySaveTimer) {
      clearTimeout(overlaySaveTimer);
    }
    overlaySaveTimer = setTimeout(() => {
      void sendMessageRuntime({ type: "SET_OVERLAY_PREFS", prefs: overlayPrefs }).catch(
        () => undefined
      );
    }, 250);
  }

  function sendHeartbeat(trigger, force = false) {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < HEARTBEAT_THROTTLE_MS) {
      return;
    }

    lastHeartbeatAt = now;
    void sendMessageRuntime({
      type: "HEARTBEAT",
      trigger,
      url: window.location.href,
      timestamp: now
    }).catch(() => undefined);
  }

  function onUserActivity(eventName) {
    if (document.visibilityState !== "visible") {
      return;
    }
    sendHeartbeat(eventName);
  }

  function formatDurationMs(inputMs) {
    const ms = Math.max(0, Math.floor(inputMs ?? 0));
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
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
      case SESSION_STATUS.RUNNING:
        return "Em foco";
      case SESSION_STATUS.PAUSED_MANUAL:
        return "Pausa manual";
      case SESSION_STATUS.PAUSED_IDLE:
        return `Pausa por inatividade (${idleReasonLabel(session.idlePauseReason)})`;
      case SESSION_STATUS.COMPLETED_PENDING_CONFIRMATION:
        return "Concluído: confirme no popup";
      default:
        return session.status;
    }
  }

  function shouldShowMonitor(session) {
    if (!session || session.displayMode !== "overlay") {
      return false;
    }
    if (session.externalOverrideActive) {
      return false;
    }
    return ACTIVE_VISOR_STATUSES.has(session.status);
  }

  function ensureMonitor() {
    if (!monitorHost) {
      monitorHost = document.createElement("div");
      monitorHost.style.position = "fixed";
      monitorHost.style.top = "14px";
      monitorHost.style.right = "14px";
      monitorHost.style.zIndex = "2147483647";

      monitorShadow = monitorHost.attachShadow({ mode: "open" });
      monitorShadow.innerHTML = `
        <style>
          :host {
            all: initial;
            font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
          }
          .box {
            width: 248px;
            border-radius: 12px;
            border: 1px solid #1d3557;
            background: linear-gradient(160deg, #0b132b, #1c2541);
            color: #f1f5f9;
            box-shadow: 0 10px 30px rgb(0 0 0 / 0.28);
            padding: 10px;
            resize: none;
            overflow: hidden;
            max-width: 560px;
            max-height: 70vh;
            display: flex;
            flex-direction: column;
          }
          .box.maximized {
            resize: both;
            min-width: 240px;
            min-height: 120px;
            max-height: 80vh;
          }
          .box.minimized {
            width: 12px;
            min-width: 0;
            min-height: 0;
            height: 100px;
            padding: 6px 4px;
            resize: none;
            transition: width 0.15s ease, transform 0.15s ease;
          }
          .box.minimized:hover {
            transform: scale(1.06);
          }
          .box.minimized.peek {
            width: 140px;
            height: 140px;
          }
          .box.minimized .head {
            margin-bottom: 0;
            flex-direction: column;
            gap: 6px;
            align-items: center;
          }
          .head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            cursor: move;
          }
          .title {
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.02em;
            transition: opacity 0.15s ease, max-height 0.15s ease;
            user-select: none;
          }
          .title-horizontal {
            opacity: 0;
            max-height: 0;
            overflow: hidden;
            font-size: 11px;
            text-align: center;
          }
          .box:not(.minimized) .title-horizontal {
            display: none;
          }
          .box:not(.minimized) .title-vertical {
            opacity: 1;
            max-height: 20px;
          }
          .box.minimized .title-vertical {
            writing-mode: vertical-rl;
            transform: rotate(180deg);
            font-size: 10px;
            text-align: center;
          }
          .box.minimized.peek .title-vertical {
            opacity: 0;
            max-height: 0;
          }
          .box.minimized.peek .title-horizontal {
            opacity: 1;
            max-height: 20px;
          }
          .head-actions {
            display: flex;
            gap: 6px;
          }
          .box.minimized .head-actions {
            flex-direction: column;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s ease;
          }
          .box.minimized.peek .head-actions {
            opacity: 1;
            pointer-events: auto;
            flex-direction: row;
          }
          .box:not(.minimized) #toggle-max {
            display: none;
          }
          .box.minimized #toggle-min {
            display: none;
          }
          button {
            border: 1px solid #3a506b;
            background: #14213d;
            color: #f1f5f9;
            font-size: 11px;
            border-radius: 8px;
            padding: 3px 8px;
            cursor: pointer;
          }
          .time {
            font-size: 24px;
            font-weight: 700;
            line-height: 1.1;
            margin-bottom: 8px;
            user-select: none;
          }
          .row {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin: 4px 0;
            font-size: 11px;
            user-select: none;
          }
          .value.idle {
            color: #f87171;
            font-weight: 700;
          }
          .label {
            color: #9fb3c8;
            user-select: none;
          }
          .value {
            text-align: right;
            color: #e2e8f0;
            user-select: none;
          }
          .apps {
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px solid #23314f;
          }
          .apps-header {
            font-size: 11px;
            color: #9fb3c8;
            margin-bottom: 4px;
          }
          .app-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            margin: 4px 0;
            font-size: 11px;
          }
          .app-name {
            flex: 1;
          }
          .app-time {
            font-variant-numeric: tabular-nums;
            color: #9fb3c8;
          }
          .music {
            margin-top: 8px;
            padding-top: 6px;
            border-top: 1px solid #23314f;
          }
          .music-frame {
            width: 100%;
            height: 160px;
            border: 0;
            border-radius: 10px;
            background: #0b132b;
          }
          .music-empty {
            font-size: 11px;
            color: #9fb3c8;
          }
          .switch {
            position: relative;
            display: inline-block;
            width: 30px;
            height: 16px;
          }
          .switch input {
            opacity: 0;
            width: 0;
            height: 0;
          }
          .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #334155;
            transition: 0.2s;
            border-radius: 999px;
          }
          .slider:before {
            position: absolute;
            content: "";
            height: 12px;
            width: 12px;
            left: 2px;
            top: 2px;
            background-color: #f8fafc;
            transition: 0.2s;
            border-radius: 50%;
          }
          .switch input:checked + .slider {
            background-color: #2a9d8f;
          }
          .switch input:checked + .slider:before {
            transform: translateX(14px);
          }
          .switch input:disabled + .slider {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .bar {
            margin-top: 8px;
            height: 6px;
            border-radius: 8px;
            overflow: hidden;
            background: #334155;
          }
          .bar > span {
            display: block;
            height: 100%;
            background: linear-gradient(90deg, #22d3ee, #2a9d8f);
            width: 0%;
            transition: width 0.25s ease;
          }
          .box.minimized .content {
            display: none;
          }
          .content {
            overflow: auto;
            flex: 1;
            min-height: 0;
          }
          .state-running {
            color: #86efac;
          }
          .state-paused {
            color: #fcd34d;
          }
          .state-wait {
            color: #fca5a5;
          }
          .music-actions {
            margin-top: 6px;
          }
          .music-open {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 4px 8px;
            border-radius: 999px;
            border: 1px solid #1d3557;
            background: #0b132b;
            color: #f1f5f9;
            font-size: 0.72rem;
            text-decoration: none;
          }
          .music-open:hover {
            border-color: #22d3ee;
            color: #22d3ee;
          }
          .music-note {
            margin: 4px 0 0;
            font-size: 0.7rem;
            color: #94a3b8;
          }
          .music-claim {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 4px 8px;
            border-radius: 999px;
            border: 1px solid #1d3557;
            background: #0b132b;
            color: #f1f5f9;
            font-size: 0.72rem;
            cursor: pointer;
          }
          .music-claim:hover {
            border-color: #22d3ee;
            color: #22d3ee;
          }
        </style>
        <section class="box" id="box">
          <div class="head">
            <span class="title title-vertical">Focus Lock | Visor</span>
            <span class="title title-horizontal">Focus locker | visor</span>
            <div class="head-actions">
              <button id="toggle-min">Minimizar</button>
              <button id="toggle-max">Maximizar</button>
              <button id="close-visor">Fechar</button>
            </div>
          </div>
          <div class="content">
            <div class="time" id="remaining">00:00:00</div>
            <div class="row"><span class="label">Estado</span><span class="value" id="status">-</span></div>
            <div class="row"><span class="label">Punição</span><span class="value" id="penalty">00:00:00</span></div>
            <div class="row"><span class="label">Pausa manual</span><span class="value" id="pause">00:00:00</span></div>
            <div class="row"><span class="label">Inatividade</span><span class="value idle" id="idle">00:00:00</span></div>
            <div class="apps">
              <div class="apps-header">Apps externos</div>
              <div id="external-app-list"></div>
            </div>
            <div class="music" id="music-section">
              <div class="apps-header">Música</div>
              <div id="music-container"></div>
              <div class="music-actions">
                <a id="music-open" class="music-open" target="_blank" rel="noopener noreferrer">
                  Abrir no YouTube
                </a>
                <button id="music-claim" class="music-claim" type="button">
                  Assumir player
                </button>
              </div>
              <div class="music-note" id="music-status">Se o player falhar, use o link acima.</div>
            </div>
            <div class="row"><span class="label">Modo</span><span class="value">Visor flutuante</span></div>
            <div class="bar"><span id="progress"></span></div>
          </div>
        </section>
      `;

      const toggleBtn = monitorShadow.getElementById("toggle-min");
      const toggleMaxBtn = monitorShadow.getElementById("toggle-max");
      const closeBtn = monitorShadow.getElementById("close-visor");
      const box = monitorShadow.getElementById("box");
      const head = monitorShadow.querySelector(".head");
      const externalAppList = monitorShadow.getElementById("external-app-list");
      let clampTimer = null;

      function applySize(width, height) {
        if (width) {
          box.style.width = `${Math.round(width)}px`;
        } else {
          box.style.removeProperty("width");
        }
        if (height) {
          box.style.height = `${Math.round(height)}px`;
        } else {
          box.style.removeProperty("height");
        }
      }

      function clampOverlayToViewport() {
        if (!monitorHost) {
          return;
        }
        const boxRect = box.getBoundingClientRect();
        const rect = monitorHost.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - boxRect.width - 8);
        const maxTop = Math.max(8, window.innerHeight - boxRect.height - 8);
        monitorHost.style.left = `${clamp(rect.left, 8, maxLeft)}px`;
        monitorHost.style.top = `${clamp(rect.top, 8, maxTop)}px`;
        monitorHost.style.right = "auto";
      }

      function scheduleClampOverlay() {
        clampOverlayToViewport();
        requestAnimationFrame(clampOverlayToViewport);
        if (clampTimer) {
          clearTimeout(clampTimer);
        }
        clampTimer = setTimeout(() => {
          clampOverlayToViewport();
          clampTimer = null;
        }, 180);
      }

      function setMinimized(minimized) {
        if (minimized) {
          const rect = box.getBoundingClientRect();
          scheduleOverlayPrefsSave({
            minimized: true,
            restoreWidth: rect.width,
            restoreHeight: rect.height
          });
          box.classList.add("minimized");
          box.classList.remove("peek");
          box.classList.remove("maximized");
          box.style.removeProperty("width");
          box.style.removeProperty("height");
          return;
        }

        box.classList.remove("minimized");
        box.classList.remove("peek");
        box.classList.add("maximized");
        toggleBtn.textContent = "Minimizar";
        scheduleOverlayPrefsSave({ minimized: false });
        const width =
          overlayPrefs.restoreWidth ?? overlayPrefs.width ?? DEFAULT_OVERLAY_PREFS.width;
        const height =
          overlayPrefs.restoreHeight ?? overlayPrefs.height ?? DEFAULT_OVERLAY_PREFS.height;
        applySize(width, height);
        scheduleClampOverlay();
      }

      toggleBtn.addEventListener("click", () => {
        setMinimized(true);
      });

      toggleMaxBtn.addEventListener("click", () => {
        setMinimized(false);
      });

      closeBtn.addEventListener("click", () => {
        hideMonitor();
        void sendMessageRuntime({ type: "SET_DISPLAY_MODE", displayMode: "popup" }).catch(() => undefined);
      });

      if (externalAppList) {
        externalAppList.addEventListener("change", (event) => {
          const target = event.target;
          if (!target || target.tagName !== "INPUT") {
            return;
          }
          const name = target.dataset?.name;
          if (!name) {
            return;
          }
          void sendMessageRuntime({
            type: "TOGGLE_EXTERNAL_APP",
            name,
            enabled: target.checked
          }).catch(() => undefined);
        });
      }

      const dragState = {
        active: false,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        moved: false
      };

      head.addEventListener("pointerdown", (event) => {
        if (event.target?.tagName === "BUTTON") {
          return;
        }
        if (!monitorHost) {
          return;
        }
        const rect = monitorHost.getBoundingClientRect();
        dragState.active = true;
        dragState.startX = event.clientX;
        dragState.startY = event.clientY;
        dragState.startLeft = rect.left;
        dragState.startTop = rect.top;
        dragState.moved = false;
        monitorHost.style.right = "auto";
        head.setPointerCapture(event.pointerId);
      });

      head.addEventListener("pointermove", (event) => {
        if (!dragState.active || !monitorHost) {
          return;
        }
        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
          dragState.moved = true;
        }
        const nextLeft = dragState.startLeft + deltaX;
        const nextTop = dragState.startTop + deltaY;
        const boxRect = box.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - boxRect.width - 8);
        const maxTop = Math.max(8, window.innerHeight - boxRect.height - 8);
        monitorHost.style.left = `${clamp(nextLeft, 8, maxLeft)}px`;
        monitorHost.style.top = `${clamp(nextTop, 8, maxTop)}px`;
      });

      head.addEventListener("pointerup", (event) => {
        if (!dragState.active || !monitorHost) {
          return;
        }
        dragState.active = false;
        head.releasePointerCapture(event.pointerId);
        const rect = monitorHost.getBoundingClientRect();
        scheduleOverlayPrefsSave({ left: rect.left, top: rect.top });

        if (!dragState.moved && box.classList.contains("minimized")) {
          box.classList.toggle("peek");
          scheduleClampOverlay();
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        if (box.classList.contains("minimized") || !box.classList.contains("maximized")) {
          return;
        }
        const rect = box.getBoundingClientRect();
        scheduleOverlayPrefsSave({
          width: rect.width,
          height: rect.height,
          restoreWidth: rect.width,
          restoreHeight: rect.height
        });
      });
      resizeObserver.observe(box);
    }

    if (!monitorMounted) {
      const root = document.documentElement || document.body;
      if (!root) {
        return false;
      }
      root.appendChild(monitorHost);
      monitorMounted = true;

      const box = monitorShadow.getElementById("box");
      const width = overlayPrefs.width ?? DEFAULT_OVERLAY_PREFS.width;
      const height = overlayPrefs.height ?? DEFAULT_OVERLAY_PREFS.height;
      if (width) {
        box.style.width = `${width}px`;
      }
      if (height) {
        box.style.height = `${height}px`;
      }

      const boxRect = box.getBoundingClientRect();
      const initialLeft =
        typeof overlayPrefs.left === "number"
          ? overlayPrefs.left
          : Math.max(8, window.innerWidth - boxRect.width - 14);
      const initialTop = typeof overlayPrefs.top === "number" ? overlayPrefs.top : 14;
      monitorHost.style.left = `${clamp(initialLeft, 8, window.innerWidth - boxRect.width - 8)}px`;
      monitorHost.style.top = `${clamp(initialTop, 8, window.innerHeight - boxRect.height - 8)}px`;
      monitorHost.style.right = "auto";

      if (overlayPrefs.minimized) {
        box.classList.add("minimized");
        box.classList.remove("peek");
        box.classList.remove("maximized");
        const toggleBtn = monitorShadow.getElementById("toggle-min");
      } else {
        box.classList.add("maximized");
      }
    }

    return true;
  }

  function hideMonitor() {
    if (monitorHost && monitorMounted) {
      monitorHost.style.display = "none";
    }
  }

  function showMonitor() {
    if (monitorHost && monitorMounted) {
      monitorHost.style.display = "block";
    }
  }

  function renderExternalApps(session) {
    if (!monitorShadow) {
      return;
    }
    const listEl = monitorShadow.getElementById("external-app-list");
    if (!listEl) {
      return;
    }

    listEl.innerHTML = "";
    const apps = Array.isArray(session.externalApps) ? session.externalApps : [];
    if (!apps.length) {
      const empty = document.createElement("div");
      empty.textContent = "Nenhum app externo";
      empty.style.color = "#9fb3c8";
      empty.style.fontSize = "11px";
      listEl.appendChild(empty);
      return;
    }

    const canToggle =
      session.status === SESSION_STATUS.RUNNING ||
      session.status === SESSION_STATUS.PAUSED_MANUAL ||
      session.status === SESSION_STATUS.PAUSED_IDLE;

    apps.forEach((app) => {
      const row = document.createElement("div");
      row.className = "app-row";

      const name = document.createElement("div");
      name.className = "app-name";
      name.textContent = app.name;

      const time = document.createElement("div");
      time.className = "app-time";
      time.textContent = formatDurationMs(app.activeMs ?? 0);

      const switchLabel = document.createElement("label");
      switchLabel.className = "switch";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(app.enabled);
      checkbox.disabled = !canToggle;
      checkbox.dataset.name = app.name;
      const slider = document.createElement("span");
      slider.className = "slider";
      switchLabel.appendChild(checkbox);
      switchLabel.appendChild(slider);

      row.appendChild(name);
      row.appendChild(time);
      row.appendChild(switchLabel);
      listEl.appendChild(row);
    });
  }

  function renderMusic(state) {
    if (!monitorShadow) {
      return;
    }
    const section = monitorShadow.getElementById("music-section");
    const container = monitorShadow.getElementById("music-container");
    const openLink = monitorShadow.getElementById("music-open");
    const claimBtn = monitorShadow.getElementById("music-claim");
    const statusEl = monitorShadow.getElementById("music-status");
    if (!section || !container) {
      return;
    }
    const config = state?.config ?? {};
    const session = state?.session ?? {};
    const embedUrl = buildYoutubeEmbedUrl(config?.musicUrl ?? "");
    if (!embedUrl) {
      section.style.display = "none";
      currentMusicEmbedUrl = "";
      container.innerHTML = "";
      if (openLink) {
        openLink.removeAttribute("href");
      }
      if (claimBtn) {
        claimBtn.style.display = "none";
      }
      if (statusEl) {
        statusEl.textContent = "";
      }
      return;
    }
    section.style.display = "block";
    if (openLink && config?.musicUrl) {
      openLink.href = config.musicUrl;
    }
    const isOwner = Boolean(state?.context?.isMusicOwner);
    if (!session.musicOwnerTabId && !musicClaimPending) {
      musicClaimPending = true;
      void sendMessageRuntime({ type: "CLAIM_MUSIC_OWNER" })
        .catch(() => undefined)
        .finally(() => {
          musicClaimPending = false;
        });
    }
    if (!isOwner) {
      currentMusicEmbedUrl = "";
      container.innerHTML = "";
      if (claimBtn) {
        claimBtn.style.display = "inline-flex";
        claimBtn.onclick = () => {
          void sendMessageRuntime({ type: "CLAIM_MUSIC_OWNER" })
            .then(() => refreshMonitor())
            .catch(() => undefined);
        };
      }
      if (statusEl) {
        statusEl.textContent = "Player ativo em outra aba. Clique para assumir.";
      }
      return;
    }
    if (claimBtn) {
      claimBtn.style.display = "none";
    }
    if (statusEl) {
      statusEl.textContent = "";
    }
    if (embedUrl === currentMusicEmbedUrl) {
      return;
    }
    currentMusicEmbedUrl = embedUrl;
    container.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "music-frame";
    iframe.src = embedUrl;
    iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    iframe.referrerPolicy = "origin";
    container.appendChild(iframe);
  }

  function updateMonitor(state) {
    const session = state.session ?? state;
    const ready = ensureMonitor();
    if (!ready) {
      return;
    }
    showMonitor();

    const remainingText = formatDurationMs(session.effectiveRemainingMs ?? session.remainingMs ?? 0);
    const penaltyText = formatDurationMs(session.penaltyAddedMs ?? 0);
    const pauseText = formatDurationMs(session.manualPauseRemainingMs ?? 0);
    const idleMs =
      session.status === SESSION_STATUS.PAUSED_IDLE && session.idlePauseStartedAtMs
        ? Math.max(0, Date.now() - session.idlePauseStartedAtMs)
        : 0;
    const idleText = formatDurationMs(idleMs);
    const statusText = statusLabel(session);

    monitorShadow.getElementById("remaining").textContent = remainingText;
    const statusEl = monitorShadow.getElementById("status");
    statusEl.textContent = statusText;

    statusEl.classList.remove("state-running", "state-paused", "state-wait");
    if (session.status === SESSION_STATUS.RUNNING) {
      statusEl.classList.add("state-running");
    } else if (
      session.status === SESSION_STATUS.PAUSED_MANUAL ||
      session.status === SESSION_STATUS.PAUSED_IDLE
    ) {
      statusEl.classList.add("state-paused");
    } else {
      statusEl.classList.add("state-wait");
    }

    monitorShadow.getElementById("penalty").textContent = penaltyText;
    monitorShadow.getElementById("pause").textContent = pauseText;
    monitorShadow.getElementById("idle").textContent = idleText;

    const configured = Math.max(1, session.configuredDurationMs ?? 1);
    const remaining = Math.max(0, session.remainingMs ?? 0);
    const baseProgress = Math.max(0, Math.min(1, 1 - remaining / configured));
    monitorShadow.getElementById("progress").style.width = `${Math.round(baseProgress * 100)}%`;
    renderExternalApps(session);
    renderMusic(state);
  }

  async function refreshMonitor() {
    if (document.visibilityState !== "visible") {
      hideMonitor();
      return;
    }

    try {
      const response = await sendMessageRuntime({ type: "GET_STATE" });
      if (!response?.ok) {
        hideMonitor();
        return;
      }

      const session = response.data?.session;
      if (!shouldShowMonitor(session)) {
        hideMonitor();
        return;
      }

      updateMonitor(response.data);
    } catch {
      hideMonitor();
    }
  }

  ["keydown", "mousedown", "mousemove", "scroll", "touchstart", "click"].forEach(
    (eventName) => {
      window.addEventListener(eventName, () => onUserActivity(eventName), {
        passive: true,
        capture: true
      });
    }
  );

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      sendHeartbeat("visibilitychange", true);
      void refreshMonitor();
    } else {
      hideMonitor();
    }
  });

  window.addEventListener("focus", () => sendHeartbeat("window_focus", true));
  window.addEventListener("pageshow", () => sendHeartbeat("pageshow", true));

  setInterval(() => {
    if (document.visibilityState === "visible") {
      sendHeartbeat("periodic", true);
    }
  }, PERIODIC_HEARTBEAT_MS);

  setInterval(() => {
    void refreshMonitor();
  }, MONITOR_REFRESH_MS);

  sendHeartbeat("initial_load", true);
  void loadOverlayPrefs().then(() => refreshMonitor());
})();
