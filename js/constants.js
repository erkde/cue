// Release/runtime manifest. Keep the browser worker and Cloudflare asset proxy
// on exactly the same versions so a deployment cannot mix JS and WASM files.
export const TRANSFORMERS_VERSION = '4.2.0';
export const ONNXRUNTIME_VERSION = '1.26.0-dev.20260416-b7804b056c';
export const ASR_MODEL_ID = 'onnx-community/moonshine-tiny-ONNX';
export const ASR_DTYPE = 'q8';

// ORT 1.26's extended QDQ pass rejects this older Moonshine q8 export while
// rewriting its shared decoder embedding to MatMulNBits (missing scale).
export const ASR_GRAPH_OPTIMIZATION_LEVEL = 'basic';
export const DEFAULT_WASM_THREADS = 1;

// Audio/recognition tuning.
export const SAMPLE_RATE = 16000;
export const MIC_BUFFER_SECONDS = 12;
export const ASR_WINDOW_SECONDS = 3;
export const MIN_AUDIO_SECONDS = 1.5;
export const RMS_GATE = 0.01;
// 120ms over-inferred the overlapping 3s window (movedPct fell to ~75,
// jitter, extra memory churn); 180ms keeps cycle ~360ms and useful moves high.
export const LOOP_IDLE_MS = 180;
export const END_OF_SCRIPT_WORDS = 3;

// Release discovery and bounded WebKit shutdown/reload fallbacks.
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const ASR_SHUTDOWN_TIMEOUT_MS = 5000;
export const UPDATE_ACTIVATION_TIMEOUT_MS = 8000;
