export const DISPLAY_MODE = {
  POPUP: "popup",
  OVERLAY: "overlay"
};

export function normalizeDisplayMode(value, fallback = DISPLAY_MODE.POPUP) {
  if (value === DISPLAY_MODE.POPUP || value === DISPLAY_MODE.OVERLAY) {
    return value;
  }
  return fallback;
}

export function displayModeLabel(value) {
  if (value === DISPLAY_MODE.OVERLAY) {
    return "Visor flutuante";
  }
  return "Popup da extensão";
}
