// Whisper-tiny in a module worker via transformers.js.
// Tries WebGPU first, falls back to WASM.

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

env.allowLocalModels = false;

// In production, fetch model files through the same-origin /hf/ proxy in
// worker.js — HF's CDN intermittently drops CORS headers. Locally (plain
// python http.server, no proxy) talk to huggingface.co directly.
if (!['localhost', '127.0.0.1'].includes(self.location.hostname)) {
  env.remoteHost = `${self.location.origin}/hf/`;
}

const MODEL = 'onnx-community/whisper-tiny.en';
let asr = null;
let device = null;
let busy = false;
let loading = false;

const post = (msg) => self.postMessage(msg);

// progress is reported per file; accumulate bytes so the UI can show a
// number that never goes backwards
const loadedBytes = {};
const progress_callback = (p) => {
  if (p.status === 'progress' && p.total) {
    loadedBytes[p.file] = p.loaded;
    const mb = Object.values(loadedBytes).reduce((a, b) => a + b, 0) / 1048576;
    post({
      type: 'progress',
      file: p.file.split('/').pop(),
      pct: Math.round((p.loaded / p.total) * 100),
      mb: Math.round(mb * 10) / 10,
    });
  }
};

async function load() {
  if (asr) { post({ type: 'ready', device }); return; }
  if (loading) return;
  loading = true;
  try {
    try {
      if (!('gpu' in self.navigator)) throw new Error('no webgpu');
      asr = await pipeline('automatic-speech-recognition', MODEL, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      device = 'webgpu';
    } catch (e) {
      asr = await pipeline('automatic-speech-recognition', MODEL, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback,
      });
      device = 'wasm';
    }
    // first inference compiles shaders / JIT-warms the runtime; do it now
    // with silence so it doesn't eat into the first real take
    post({ type: 'status', stage: 'warmup' });
    await asr(new Float32Array(16000));
    post({ type: 'ready', device });
  } finally {
    loading = false;
  }
}

self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === 'load') {
    try {
      await load();
    } catch (err) {
      post({ type: 'error', message: String(err?.message ?? err) });
    }
  } else if (type === 'transcribe') {
    if (!asr || busy) return;
    busy = true;
    try {
      const t0 = performance.now();
      const { text } = await asr(e.data.audio);
      post({ type: 'result', text: text.trim(), ms: Math.round(performance.now() - t0) });
    } catch (err) {
      post({ type: 'error', message: String(err?.message ?? err) });
    } finally {
      busy = false;
    }
  }
};
