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

let lastSaveFailed = false;

export function writeSave(save, slot = 0) {
  save.version = SAVE_VERSION;
  save.savedAt = Date.now();
  const ok = writeJSON(`save${slot}`, save);
  lastSaveFailed = !ok;
  return ok;
}

/** True when the most recent writeSave() failed (storage blocked, full or unavailable). */
export function saveFailed() {
  return lastSaveFailed;
}

/** Can this browser persist anything at all? (probe write; private modes / blocked site data) */
export function storageAvailable() {
  try {
    const k = key('probe');
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export function hasSave(slot = 0) {
  return !!loadSave(slot);
}

export function deleteSave(slot = 0) {
  remove(`save${slot}`);
}

export const DEFAULT_SETTINGS = {
  sound: true,
  vibration: true,
  quarterMinutes: 2, // 1 | 2 | 3 (MECHANICS 5.1)
  driveDirection: 'right', // 'right' | 'left' | 'alternate' (landscape only; portrait always drives up)
  cameraZoom: 'near', // 'near' | 'far'
  wind: 'normal', // 'off' | 'low' | 'normal' | 'high'
  showTips: true, // first-play control hints
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(readJSON('settings') || {}) };
}

export function saveSettings(s) {
  writeJSON('settings', s);
}
