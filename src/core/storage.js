// localStorage persistence. Every access is wrapped: storage may be unavailable (private mode,
// sandboxed iframes, blocked site data) and the game must still run without it.

const PREFIX = 'pocketgridiron';
export const SAVE_VERSION = 1;

function key(name) {
  return `${PREFIX}.${name}`;
}

export function readJSON(name, fallback = null) {
  try {
    const raw = localStorage.getItem(key(name));
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(name, value) {
  try {
    localStorage.setItem(key(name), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(name) {
  try {
    localStorage.removeItem(key(name));
  } catch { /* ignore */ }
}

export function loadSave(slot = 0) {
  const s = readJSON(`save${slot}`);
  if (!s || s.version !== SAVE_VERSION) return null;
  return s;
}

export function writeSave(save, slot = 0) {
  save.version = SAVE_VERSION;
  save.savedAt = Date.now();
  return writeJSON(`save${slot}`, save);
}

export function hasSave(slot = 0) {
  return !!loadSave(slot);
}

export function deleteSave(slot = 0) {
  remove(`save${slot}`);
}

export const DEFAULT_SETTINGS = {
  sound: true,
  music: true,
  vibration: true,
  quarterMinutes: 2, // simulated game-clock minutes per quarter (see docs/MECHANICS.md)
  difficulty: 1, // 0 easy, 1 normal, 2 hard
  showRoutes: true,
  leftHanded: false,
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(readJSON('settings') || {}) };
}

export function saveSettings(s) {
  writeJSON('settings', s);
}
