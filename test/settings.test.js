import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from '../js/settings.js';

function memoryStorage(initial) {
  const values = new Map(initial ? [[SETTINGS_KEY, initial]] : []);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('normalizes each setting independently', () => {
  assert.deepEqual(
    normalizeSettings({ fontSize: 54, mirror: true, keepAwake: true, showMarkers: true }),
    {
      fontSize: 54,
      mirror: true,
      keepAwake: true,
    },
  );
  assert.deepEqual(normalizeSettings({ fontSize: 100, mirror: 'yes' }), DEFAULT_SETTINGS);
});

test('loads a valid versioned settings record', () => {
  const storage = memoryStorage(
    JSON.stringify({ version: 1, fontSize: 46, mirror: true, keepAwake: false, showMarkers: true }),
  );
  assert.deepEqual(loadSettings(storage), {
    fontSize: 46,
    mirror: true,
    keepAwake: false,
  });
});

test('falls back for missing, malformed, or unknown-version settings', () => {
  assert.deepEqual(loadSettings(memoryStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(memoryStorage('{bad json')), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(memoryStorage(JSON.stringify({ version: 999 }))), DEFAULT_SETTINGS);
});

test('saves a normalized, versioned record', () => {
  const storage = memoryStorage();
  assert.equal(
    saveSettings({ fontSize: 64, mirror: true, keepAwake: true, showMarkers: true }, storage),
    true,
  );
  assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY)), {
    version: 1,
    fontSize: 64,
    mirror: true,
    keepAwake: true,
  });
});

test('storage failures never break the app', () => {
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(loadSettings(broken), DEFAULT_SETTINGS);
  assert.equal(saveSettings(DEFAULT_SETTINGS, broken), false);
});
