// Whisper-tiny in a module worker via transformers.js.
// Tries WebGPU first, falls back to WASM.

import { pipeline, env } from '/lib/transformers.min.js';

env.allowLocalModels = false;

// In production, fetch model files through the same-origin /hf/ proxy in
// worker.js — HF's CDN intermittently drops CORS headers. Locally (plain
// python http.server, no proxy) talk to huggingface.co directly.
if (!['localhost', '127.0.0.1'].includes(self.location.hostname)) {
  env.remoteHost = `${self.location.origin}/hf/`;
  env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/lib/`;
}

// Let ORT choose its own wasm thread count (default ~2). Forcing it to
// hardwareConcurrency (cue-v19) gave no inference speedup, and threaded wasm
// reserves a larger *shared* memory arena — suspected in the iOS tab reloads
// under Moonshine. Back to auto to test whether that relieves the memory
// pressure. (cue-v22)

// Two ASR engines, chosen per backend. Moonshine on wasm: its compute scales
// with actual audio length instead of Whisper's fixed 30s frame, measured ~5x
// faster inference on CPU (1116ms -> 212ms on an iPhone) with no loss in match
// rate. Whisper stays on webgpu, where q4 kernels already make the fixed frame
// cheap and its accuracy edge is free.
const WHISPER = 'onnx-community/whisper-tiny.en';
const MOONSHINE = 'onnx-community/moonshine-tiny-ONNX';
let asr = null;
let device = null;
let busy = false;
let loading = false;

const post = (msg) => self.postMessage(msg);

// What the wasm backend actually settled on — reported to the app so the
// perf-load beacon can show whether the encoder is running single-threaded
// (headroom) or already parallel (dead end). Read after warmup, when ORT has
// initialized these.
const wasmInfo = () => ({
  threads: env.backends.onnx.wasm.numThreads,
  simd: env.backends.onnx.wasm.simd,
  isolated: self.crossOriginIsolated,
  cores: self.navigator.hardwareConcurrency,
});

// progress is reported per file; accumulate bytes so the UI can show a
// number that never goes backwards
const loadedBytes = {};
const progress_callback = (p) => {
  if (p.status === 'progress' && p.loaded) {
    loadedBytes[p.file] = p.loaded;
    const mb = Object.values(loadedBytes).reduce((a, b) => a + b, 0) / 1048576;
    post({
      type: 'progress',
      file: p.file.split('/').pop(),
      // WebKit sometimes hides content-length on cross-origin fetches, so
      // a percentage isn't always computable — the MB counter still is
      pct: p.total ? Math.round((p.loaded / p.total) * 100) : null,
      mb: Math.round(mb * 10) / 10,
    });
  }
};

const DEVICE_OPTS = {
  webgpu: {
    model: WHISPER,
    device: 'webgpu',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  },
  wasm: { model: MOONSHINE, device: 'wasm', dtype: 'q8' },
};

// Builds the pipeline AND runs the warmup inference: some platforms (Linux
// in particular) hand out a WebGPU session that only fails at first
// inference, so warmup must be part of the attempt for fallback to work.
async function tryDevice(dev) {
  const { model, ...opts } = DEVICE_OPTS[dev];
  const p = await pipeline('automatic-speech-recognition', model, {
    ...opts,
    progress_callback,
  });
  post({ type: 'status', stage: 'warmup' });
  await p(new Float32Array(16000));
  return p;
}

// navigator.gpu existing doesn't mean an adapter is actually available
// (commonly blocklisted on Linux) — probe before committing to webgpu
async function webgpuUsable() {
  try {
    return !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(preferWasm = false) {
  if (asr) {
    post({ type: 'ready', device, wasm: wasmInfo() });
    return;
  }
  if (loading) return;
  loading = true;
  try {
    if (!preferWasm && (await webgpuUsable())) {
      try {
        asr = await tryDevice('webgpu');
        device = 'webgpu';
      } catch (e) {
        console.warn('webgpu failed, falling back to wasm:', e);
      }
    }
    if (!asr) {
      asr = await tryDevice('wasm');
      device = 'wasm';
    }
    post({ type: 'ready', device, wasm: wasmInfo() });
  } finally {
    loading = false;
  }
}

self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === 'load') {
    try {
      await load(e.data.preferWasm);
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
