// Whisper-tiny in a module worker via transformers.js.
// Tries WebGPU first, falls back to WASM.

// This module is served by the Cloudflare Worker rather than the Vite asset
// graph. The ignore annotation keeps the same runtime URL in dev and builds.
const transformersUrl = '/lib/transformers.min.js';
const { pipeline, env } = await import(/* @vite-ignore */ transformersUrl);

env.allowLocalModels = false;

// In production, fetch model files through the same-origin /hf/ proxy in
// worker.js — HF's CDN intermittently drops CORS headers. Locally (plain
// python http.server, no proxy) talk to huggingface.co directly.
if (!['localhost', '127.0.0.1'].includes(self.location.hostname)) {
  env.remoteHost = `${self.location.origin}/hf/`;
  env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/lib/`;
}

// Moonshine on the wasm/CPU backend, everywhere. Its compute scales with actual
// audio length instead of Whisper's fixed 30s frame — ~94-200ms/inference and
// reliable on every browser + phone tested. (Git history has the Whisper/WebGPU
// path we benchmarked against and dropped: slower and unstable on desktop.)
const MODEL = 'onnx-community/moonshine-tiny-ONNX';
const DTYPE = 'q8';
let asr = null;
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

// Builds the pipeline and runs a warmup inference, so Start is instant and the
// perf-load beacon's warmupMs is populated.
async function load(threadsOverride) {
  if (asr) {
    post({ type: 'ready', device: 'wasm', wasm: wasmInfo() });
    return;
  }
  if (loading) return;
  loading = true;
  try {
    // Cap wasm threads to avoid the pthread-worker storm that hangs high-core
    // desktops (ORT's default spawns one worker + wasm fetch per core). The
    // iPhone already runs 2, so mobile is unchanged. ?threads=N overrides.
    const n = threadsOverride ?? Math.min(2, self.navigator.hardwareConcurrency || 2);
    if (n && self.crossOriginIsolated) {
      env.backends.onnx.wasm.numThreads = n;
    }
    asr = await pipeline('automatic-speech-recognition', MODEL, {
      dtype: DTYPE,
      progress_callback,
    });
    post({ type: 'status', stage: 'warmup' });
    await asr(new Float32Array(16000));
    post({ type: 'ready', device: 'wasm', wasm: wasmInfo() });
  } finally {
    loading = false;
  }
}

self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === 'load') {
    try {
      await load(e.data.threads);
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

// The runtime Transformers import above can delay module evaluation in dev.
// Tell the page when this handler exists so the initial preload message cannot
// be lost during that gap.
post({ type: 'booted' });
