export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;

export function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getNextLocalMidnightMs(referenceMs = Date.now()) {
  const date = new Date(referenceMs);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

export function formatDurationMs(inputMs) {
  const ms = Math.max(0, Math.floor(inputMs));
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function safeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
}
