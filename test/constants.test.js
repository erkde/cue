import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelConfig } from 'hug-models';
import {
  ASR_SHUTDOWN_TIMEOUT_MS,
  ASR_WINDOW_SECONDS,
  LOOP_IDLE_MS,
  MIC_BUFFER_SECONDS,
  MIN_AUDIO_SECONDS,
  ONNXRUNTIME_STANDARD_WASM_FILES,
  ONNXRUNTIME_VERSION,
  SAMPLE_RATE,
  TRANSFORMERS_VERSION,
  UPDATE_ACTIVATION_TIMEOUT_MS,
} from '../js/constants.js';
import manifest from '../hug-models.json' with { type: 'json' };

const asrModel = createModelConfig(manifest).get('asr');

test('audio windows fit inside the capture buffer', () => {
  assert.ok(MIN_AUDIO_SECONDS > 0);
  assert.ok(MIN_AUDIO_SECONDS <= ASR_WINDOW_SECONDS);
  assert.ok(ASR_WINDOW_SECONDS <= MIC_BUFFER_SECONDS);
  assert.ok(Number.isInteger(SAMPLE_RATE) && SAMPLE_RATE > 0);
});

test('runtime asset versions are pinned', () => {
  assert.match(TRANSFORMERS_VERSION, /^\d+\.\d+\.\d+/);
  assert.match(ONNXRUNTIME_VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(ONNXRUNTIME_STANDARD_WASM_FILES.mjs, 'ort-wasm-simd-threaded.mjs');
  assert.equal(ONNXRUNTIME_STANDARD_WASM_FILES.wasm, 'ort-wasm-simd-threaded.wasm');
  assert.match(asrModel.revision, /^[a-f\d]{40}$/);
});

test('loop and update fallbacks are positive and bounded', () => {
  assert.ok(LOOP_IDLE_MS > 0);
  assert.ok(ASR_SHUTDOWN_TIMEOUT_MS > LOOP_IDLE_MS);
  assert.ok(UPDATE_ACTIVATION_TIMEOUT_MS > ASR_SHUTDOWN_TIMEOUT_MS);
});
