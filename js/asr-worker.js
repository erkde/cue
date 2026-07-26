// Whisper-tiny in a module worker via transformers.js.
// Tries WebGPU first, falls back to WASM.

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

env.allowLocalModels = false;

const MODEL = 'onnx-community/whisper-tiny.en';
let asr = null;
let busy = false;

const post = (msg) => self.postMessage(msg);

async function load() {
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      post({ type: 'progress', file: p.file, pct: Math.round((p.loaded / p.total) * 100) });
    }
  };
  try {
    if (!('gpu' in self.navigator)) throw new Error('no webgpu');
    asr = await pipeline('automatic-speech-recognition', MODEL, {
      device: 'webgpu',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback,
    });
    post({ type: 'ready', device: 'webgpu' });
  } catch (e) {
    asr = await pipeline('automatic-speech-recognition', MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback,
    });
    post({ type: 'ready', device: 'wasm' });
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
