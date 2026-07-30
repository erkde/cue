export const SETTINGS_KEY = 'cue:settings';
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 38,
  mirror: false,
  keepAwake: false,
});

const validFontSize = (value) =>
  Number.isInteger(value) && value >= 22 && value <= 72 ? value : DEFAULT_SETTINGS.fontSize;

export function normalizeSettings(value) {
  const settings = value && typeof value === 'object' ? value : {};
  return {
    fontSize: validFontSize(settings.fontSize),
    mirror: typeof settings.mirror === 'boolean' ? settings.mirror : DEFAULT_SETTINGS.mirror,
    keepAwake:
      typeof settings.keepAwake === 'boolean' ? settings.keepAwake : DEFAULT_SETTINGS.keepAwake,
  };
}

export function loadSettings(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const raw = target.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const stored = JSON.parse(raw);
    if (stored?.version !== SETTINGS_VERSION) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(stored);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(value, storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const settings = normalizeSettings(value);
    target.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, ...settings }));
    return true;
  } catch {
    return false;
  }
}
