// Moonshine in a module worker via Transformers.js on the WASM backend.

import { createModelConfig } from 'hug-models';

import {
  ASR_DTYPE,
  ASR_GRAPH_OPTIMIZATION_LEVEL,
  DEFAULT_WASM_THREADS,
  ONNXRUNTIME_STANDARD_WASM_FILES,
  SAMPLE_RATE,
  TRANSFORMERS_VERSION,
} from './constants.js';

import manifest from '../hug-models.json' with { type: 'json' };

// This module is served by the Cloudflare Worker rather than the Vite asset
// graph. The ignore annotation keeps the same runtime URL in dev and builds.
const transformersUrl = `/lib/${TRANSFORMERS_VERSION}/transformers.min.js`;
const { pipeline, env } = await import(/* @vite-ignore */ transformersUrl);

env.allowLocalModels = false;

// Transformers.js deliberately selects ORT's standard (non-Asyncify) WASM
// build on Safari. Preserve that workaround when replacing its CDN URLs with
// Cue's same-origin proxy. iOS browser shells all use WebKit, so include them
// even when their user agent is not branded Safari.
const ua = self.navigator.userAgent;
const isIOS =
  /iP(?:hone|ad|od)/.test(ua) ||
  (self.navigator.platform === 'MacIntel' && self.navigator.maxTouchPoints > 1);
const isSafari =
  self.navigator.vendor?.includes('Apple') &&
  !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android/i.test(ua);
const useStandardWasm = isIOS || isSafari;

// In production, fetch model files through the same-origin /hf/ proxy in
// worker.js — HF's CDN intermittently drops CORS headers. Locally (plain
// python http.server, no proxy) talk to huggingface.co directly.
if (!['localhost', '127.0.0.1'].includes(self.location.hostname)) {
  env.remoteHost = `${self.location.origin}/hf/`;
  const wasmBase = `${self.location.origin}/lib/${TRANSFORMERS_VERSION}/`;
  env.backends.onnx.wasm.wasmPaths = useStandardWasm
    ? {
        mjs: `${wasmBase}${ONNXRUNTIME_STANDARD_WASM_FILES.mjs}`,
        wasm: `${wasmBase}${ONNXRUNTIME_STANDARD_WASM_FILES.wasm}`,
      }
    : wasmBase;
}

const models = createModelConfig(manifest);
const model = models.get('asr');

// Moonshine on the wasm/CPU backend, everywhere. Its compute scales with actual
// audio length instead of Whisper's fixed 30s frame — ~94-200ms/inference and
// reliable on every browser + phone tested. (Git history has the Whisper/WebGPU
// path we benchmarked against and dropped: slower and unstable on desktop.)
let asr = null;
let busy = false;
let loading = false;
let disposing = false;
let activeOperation = null;

const post = (msg) => self.postMessage(msg);

// Some ORT failures escape the pipeline promise and would otherwise leave the
// page's loader open forever with only an inaccessible mobile-console error.
self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  if (!disposing) post({ type: 'error', message: String(event.reason?.message ?? event.reason) });
});

// What the wasm backend actually settled on — reported to the app so the
// perf-load beacon can show whether the encoder is running single-threaded
// (headroom) or already parallel (dead end). Read after warmup, when ORT has
// initialized these.
const wasmInfo = () => ({
  runtime: TRANSFORMERS_VERSION,
  binary: useStandardWasm ? 'standard' : 'runtime-default',
  graphOptimizationLevel: ASR_GRAPH_OPTIMIZATION_LEVEL,
  threads: env.backends.onnx.wasm.numThreads,
  simd: env.backends.onnx.wasm.simd,
  isolated: self.crossOriginIsolated,
  cores: self.navigator.hardwareConcurrency,
});

const modelInfo = () => ({
  id: model.id,
  revision: model.revision,
  dtype: ASR_DTYPE,
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
    post({ type: 'ready', device: 'wasm', model: modelInfo(), wasm: wasmInfo() });
    return;
  }
  if (loading) return;
  loading = true;
  try {
    // ORT's two-thread JSEP backend currently crashes during initialization in
    // production Chrome. Keep the reliable single-thread path as the default;
    // ?threads=N remains available for explicitly retesting newer runtimes.
    const n = threadsOverride ?? DEFAULT_WASM_THREADS;
    env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? n : 1;
    asr = await pipeline('automatic-speech-recognition', model.id, {
      device: 'wasm',
      dtype: ASR_DTYPE,
      revision: model.revision,
      session_options: { graphOptimizationLevel: ASR_GRAPH_OPTIMIZATION_LEVEL },
      progress_callback,
    });
    post({ type: 'status', stage: 'warmup' });
    await asr(new Float32Array(SAMPLE_RATE));
    post({ type: 'ready', device: 'wasm', model: modelInfo(), wasm: wasmInfo() });
  } finally {
    loading = false;
  }
}

// Loading and inference are already single-flight in normal use. Keep a
// reference to the current operation so an app update can wait for ORT to
// leave WASM before releasing its sessions and acknowledging shutdown.
async function runOperation(fn) {
  const operation = fn();
  activeOperation = operation;
  try {
    return await operation;
  } finally {
    if (activeOperation === operation) activeOperation = null;
  }
}

async function dispose() {
  if (disposing) return;
  disposing = true;
  try {
    // A release can arrive during preload or an inference. Let that call
    // unwind before disposing its sessions; the page has a timeout and will
    // force-terminate the worker if a browser/runtime gets stuck here.
    await activeOperation?.catch(() => {});
    const pipeline = asr;
    asr = null;
    await pipeline?.dispose?.();
    post({ type: 'disposed' });
  } catch (err) {
    // Termination is still safe after a failed best-effort dispose. Report an
    // acknowledgement so the page can continue activating the new release.
    post({ type: 'disposed', error: String(err?.message ?? err) });
  } finally {
    self.close();
  }
}

self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === 'dispose') {
    await dispose();
  } else if (disposing) {
    return;
  } else if (type === 'load') {
    try {
      await runOperation(() => load(e.data.threads));
    } catch (err) {
      if (!disposing) post({ type: 'error', message: String(err?.message ?? err) });
    }
  } else if (type === 'transcribe') {
    if (!asr || busy) return;
    busy = true;
    try {
      await runOperation(async () => {
        const t0 = performance.now();
        const { text } = await asr(e.data.audio);
        if (disposing) return;
        post({
          type: 'result',
          text: text.trim(),
          ms: Math.round(performance.now() - t0),
          positionVersion: e.data.positionVersion,
        });
      });
    } catch (err) {
      if (!disposing) post({ type: 'error', message: String(err?.message ?? err) });
    } finally {
      busy = false;
    }
  }
};

// The runtime Transformers import above can delay module evaluation in dev.
// Tell the page when this handler exists so the initial preload message cannot
// be lost during that gap.
post({ type: 'booted' });
