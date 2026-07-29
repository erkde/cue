import AsrWorker from './asr-worker.js?worker';
import demoScriptUrl from '../demo-script.md?url&no-inline';
import { registerSW } from 'virtual:pwa-register';
import { mdToHtml } from './md.js';
import { Matcher } from './matcher.js';
import { Prompter } from './prompter.js';
import { MicCapture } from './audio.js';
import { Perf } from './perf.js';

const $ = (sel) => document.querySelector(sel);

const stage = $('#stage');
const article = $('#script');
const statusEl = $('#status');
const transcriptEl = $('#transcript');
const startBtn = $('#btn-logo');
const startMenuBtn = $('#btn-start-menu');
const recLightBtn = $('#btn-rec-light');
const menuToggle = $('#btn-menu');
const menu = $('#menu');
const menuScrim = $('#menu-scrim');

const asrWindowS = 3; // seconds of audio per inference
const MIN_AUDIO_S = 1.5;
const RMS_GATE = 0.01; // skip inference on near-silence
const LOOP_IDLE_MS = 180; // idle/silence poll + post-result gap. 120 over-inferred the overlapping 3s window (movedPct fell to ~75, jitter, extra memory churn); 180 keeps cycle ~360ms while recovering the useful-move rate

const END_OF_SCRIPT_WORDS = 3; // release the wake lock this close to the end

const prompter = new Prompter(stage, article);
let matcher = null;
let mic = null;
let loopTimer = null;
let micSyncing = false; // guards the async acquire/release in syncMic
let micSyncPending = false; // a state change arrived mid-sync — re-check after
let worker = null;
let workerBooted = false;
let modelLoadRequested = false;
let listening = false;
let modelReady = false;
let lastText = '';
let positionVersion = 0;

// Vite injects a commit/deployment/timestamp build id so summaries in Workers
// Logs remain attributable without a manually synchronized cache version.
// beacon() is defined lower down; the wrapper defers lookup until flush time.
const BUILD = __CUE_BUILD__;
const IS_IOS = /iP(?:hone|ad|od)/.test(navigator.userAgent);
const perf = new Perf((d) => beacon(d), { build: BUILD, flushEvery: IS_IOS ? 5 : 20 });
let pendingAudioS = 0; // audio window length, captured before the buffer transfer detaches it
let lastMatchMs = 0;
let lastMoved = false;
// model-load timing, filled as the load messages arrive
let modelMb = 0;
let dlStartTs = 0;
let warmupStartTs = 0;
let sawProgress = false;
let loadLogged = false;

const loaderEl = $('#loader');
const loaderMain = $('#loader-main');
const loaderSub = $('#loader-sub');
const loaderHint = $('#loader-hint');

function showLoader(show) {
  loaderEl.hidden = !show;
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `pill ${cls}`;
  statusEl.removeAttribute('title');
}

function loadScript(text) {
  positionVersion += 1;
  const tokens = prompter.setContent(mdToHtml(text));
  matcher = new Matcher(tokens);
  lastText = '';
  transcriptEl.textContent = '';
  setStatus(`${tokens.length} words`);
}

function setReadingPosition(idx, { jump = false } = {}) {
  if (!matcher) return;
  const cursor = matcher.seek(idx);
  if (cursor == null) return;
  positionVersion += 1; // discard any inference started at the previous position
  lastText = '';
  transcriptEl.textContent = '';
  prompter.setTarget(cursor);
  if (jump) prompter.jumpToTarget();
  if (listening && cursor < matcher.tokens.length - END_OF_SCRIPT_WORDS) acquireWakeLock();
}

// ---- ASR loop ----------------------------------------------------------

// ?threads=N — experimental override for the wasm thread count (diagnostic;
// no effect unless present). Handy for probing a new device/browser.
const THREADS_OVERRIDE = Number(new URLSearchParams(location.search).get('threads')) || undefined;

// ?raw=1 — diagnostic: open the mic with the browser's echo cancellation /
// noise suppression OFF. On Android the default (on) routes capture through the
// VoIP audio path, which can degrade Moonshine's transcription. No effect on the
// default load; tagged into the perf-load beacon so retests are attributable.
const RAW_MIC = new URLSearchParams(location.search).has('raw');

function ensureWorker() {
  if (worker) return;
  worker = new AsrWorker();
  // A module-worker script/import failure (e.g. transformers.min.js blocked
  // under COEP) fires here, not on window.onerror — without this it's silent:
  // no pill, no beacon, dead app. This is where a Linux/desktop load death that
  // never emits perf-load would otherwise vanish.
  worker.onerror = (e) => {
    console.error('asr worker:', e);
    setStatus('speech engine failed to load', 'err');
    beacon({
      event: 'worker-error',
      message: String(e?.message || 'worker load/runtime error').slice(0, 200),
      filename: e?.filename,
    });
  };
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'booted') {
      workerBooted = true;
      if (modelLoadRequested) {
        worker.postMessage({ type: 'load', threads: THREADS_OVERRIDE });
      }
    } else if (msg.type === 'progress') {
      setStage('download');
      if (!dlStartTs) dlStartTs = performance.now();
      sawProgress = true;
      modelMb = msg.mb;
      const mb = msg.mb.toFixed(1);
      setStatus(`downloading model — ${mb} MB`);
      // files download in parallel; per-file names/percentages thrash, so
      // show only the cumulative counter — the one number that behaves
      loaderMain.textContent = 'Downloading speech model…';
      loaderSub.textContent = `${mb} MB downloaded`;
      loaderHint.hidden = false; // reveal the one-time-download note only on an actual download
    } else if (msg.type === 'status' && msg.stage === 'warmup') {
      setStage('warmup');
      warmupStartTs = performance.now();
      setStatus('warming up model…');
      loaderMain.textContent = 'Warming up model…';
      loaderSub.textContent = '';
    } else if (msg.type === 'ready') {
      modelReady = true;
      showLoader(false);
      setStage(listening ? 'listening' : 'ready');
      perf.setDevice(msg.device);
      if (!loadLogged) {
        loadLogged = true;
        const now = performance.now();
        perf.load({
          cached: !sawProgress, // no progress events => weights came from cache
          mb: modelMb,
          downloadMs: dlStartTs && warmupStartTs ? Math.round(warmupStartTs - dlStartTs) : 0,
          warmupMs: warmupStartTs ? Math.round(now - warmupStartTs) : null,
          runtime: msg.wasm?.runtime,
          graphOptimizationLevel: msg.wasm?.graphOptimizationLevel,
          // wasm backend reality — is the encoder single-threaded (headroom)?
          threads: msg.wasm?.threads,
          cores: msg.wasm?.cores,
          isolated: msg.wasm?.isolated,
          simd: msg.wasm?.simd,
          raw: RAW_MIC, // which mic path this session used (?raw=1 diagnostic)
        });
      }
      if (listening) {
        setStatus(`listening (${msg.device})`, 'live');
        syncMic(); // model's ready now — bring the mic up if the tab is focused
      } else {
        setStatus(`model ready (${msg.device})`);
      }
    } else if (msg.type === 'result') {
      // reset first: onTranscript early-returns on a duplicate transcript, so
      // a repeated inference correctly records as matchMs 0 / moved false
      lastMatchMs = 0;
      lastMoved = false;
      if (msg.positionVersion === positionVersion) onTranscript(msg.text);
      perf.record({ infer: msg.ms, audioS: pendingAudioS, matchMs: lastMatchMs, moved: lastMoved });
      sessionInferenceCount += 1;
      lastInferenceMs = msg.ms;
      setStage(listening ? 'listening' : 'ready');
      if (listening) scheduleInference(LOOP_IDLE_MS);
    } else if (msg.type === 'error') {
      console.error('asr:', msg.message);
      showLoader(false);
      setStatus('asr error — see console', 'err');
      beacon({ event: 'asr-error', message: String(msg.message).slice(0, 200) });
      if (listening) scheduleInference(2000);
    }
  };
}

function requestModelLoad() {
  ensureWorker();
  modelLoadRequested = true;
  if (workerBooted) worker.postMessage({ type: 'load', threads: THREADS_OVERRIDE });
}

// Single-timer loop: every (re)schedule cancels the pending tick, so re-kicking
// the loop — e.g. when the mic comes back after a tab switch — can't spawn a
// second concurrent loop.
function scheduleInference(delay = LOOP_IDLE_MS) {
  clearTimeout(loopTimer);
  loopTimer = setTimeout(runInference, delay);
}

function runInference() {
  if (!listening || !mic) return;
  const level = mic.latest(0.25);
  if (level.length < 0.25 * 16000 || MicCapture.rms(level) < RMS_GATE) {
    scheduleInference();
    return;
  }
  const audio = mic.latest(asrWindowS);
  if (audio.length < MIN_AUDIO_S * 16000) {
    scheduleInference();
    return;
  }
  pendingAudioS = audio.length / 16000; // read before the transfer detaches the buffer
  worker.postMessage({ type: 'transcribe', audio, positionVersion }, [audio.buffer]);
}

function onTranscript(text) {
  if (!text || text === lastText) return;
  lastText = text;
  transcriptEl.textContent = text;
  const t0 = performance.now();
  const idx = matcher?.feed(text);
  lastMatchMs = performance.now() - t0;
  lastMoved = idx != null;
  if (idx != null) {
    prompter.setTarget(idx);
    if (idx >= matcher.tokens.length - END_OF_SCRIPT_WORDS) releaseWakeLock();
  }
}

// ---- screen wake lock --------------------------------------------------

let wakeLock = null;
const wakeChk = $('#chk-wake');

async function acquireWakeLock() {
  if (!wakeChk.checked || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    console.warn('wake lock:', err);
  }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}

// the lock is dropped automatically when the tab is hidden; take it back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listening) acquireWakeLock();
  syncMic(); // drop the mic when backgrounded, take it back on return
});

wakeChk.addEventListener('change', () => {
  if (!listening) return;
  wakeChk.checked ? acquireWakeLock() : releaseWakeLock();
});

// ---- microphone lifecycle ----------------------------------------------

// Hold the mic only while we're actually listening, the model is ready to
// consume audio, AND the tab is focused — so the OS "mic in use" indicator
// never lingers through the model download/warmup or while we're backgrounded.
// Serialized via micSyncing so overlapping triggers can't double-acquire.
async function syncMic() {
  if (micSyncing) {
    micSyncPending = true; // a state change landed mid-await — re-check below
    return;
  }
  micSyncing = true;
  try {
    do {
      micSyncPending = false;
      const wanted = listening && modelReady && document.visibilityState === 'visible';
      if (wanted && !mic) {
        try {
          mic = new MicCapture(12, { raw: RAW_MIC });
          await mic.start();
        } catch (err) {
          mic = null;
          setStatus(`microphone error — ${err?.name || 'unknown'}`, 'err');
          statusEl.title = String(err?.message ?? err);
          console.error(err);
          // mic/audio is a common post-Start dead end (getUserMedia denial,
          // AudioContext sample-rate rejection, worklet load) and until now was
          // swallowed — beacon err.name so the failures are distinguishable in
          // Workers Logs
          beacon({
            event: 'mic-error',
            name: err?.name,
            message: String(err?.message ?? err).slice(0, 200),
          });
          return;
        }
        document.body.classList.add('capturing'); // rec light: preparing -> recording
        scheduleInference(0);
      } else if (!wanted && mic) {
        const m = mic;
        mic = null; // clear first so the loop's mic guard trips immediately
        document.body.classList.remove('capturing');
        await m.stop();
      }
    } while (micSyncPending);
  } finally {
    micSyncing = false;
  }
}

// ---- start / stop ------------------------------------------------------

async function start() {
  if (!matcher || !matcher.tokens.length) {
    setStatus('load a script first', 'err');
    return;
  }
  // Must run in the synchronous click/tap call stack for Mobile Safari.
  MicCapture.prime().catch((err) => console.warn('audio unlock:', err));
  listening = true;
  setStage('listening');
  perf.reset(); // cycleMs measures within a session, never across a stop
  acquireWakeLock();
  document.body.classList.add('prompting');
  startBtn.setAttribute('aria-label', 'Stop listening');
  startBtn.setAttribute('aria-pressed', 'true');
  startBtn.title = 'Stop';
  startMenuBtn.textContent = 'Stop';
  startMenuBtn.setAttribute('aria-pressed', 'true');
  recLightBtn.setAttribute('aria-label', 'Stop listening');
  recLightBtn.setAttribute('aria-pressed', 'true');
  recLightBtn.title = 'Stop';
  prompter.start();
  requestModelLoad();
  if (!modelReady) showLoader(true); // Start beat the preload
  syncMic(); // acquire the mic now if the model is already warm; otherwise on 'ready'
}

async function stop() {
  listening = false;
  perf.flush(); // don't lose the tail batch of samples on stop
  perf.reset();
  releaseWakeLock();
  showLoader(false);
  document.body.classList.remove('prompting', 'peek', 'capturing');
  startBtn.setAttribute('aria-label', 'Start listening');
  startBtn.setAttribute('aria-pressed', 'false');
  startBtn.title = 'Start';
  startMenuBtn.textContent = 'Start';
  startMenuBtn.setAttribute('aria-pressed', 'false');
  recLightBtn.setAttribute('aria-label', 'Start listening');
  recLightBtn.setAttribute('aria-pressed', 'false');
  recLightBtn.title = 'Start';
  prompter.stop();
  clearTimeout(loopTimer);
  await syncMic(); // listening is false now, so this releases the mic
  await MicCapture.releasePrime(); // model may not have consumed the primed context
  setStatus('idle');
  setStage('ready');
  applyPendingUpdate();
}

// ---- UI wiring ---------------------------------------------------------

startBtn.addEventListener('click', () => {
  closeMenu();
  listening ? stop() : start();
});
recLightBtn.addEventListener('click', () => {
  closeMenu();
  listening ? stop() : start();
});
startMenuBtn.addEventListener('click', () => {
  closeMenu();
  listening ? stop() : start();
});

// ---- slide-out menu -----------------------------------------------------

function openMenu() {
  document.body.classList.add('menu-open');
  menu.setAttribute('aria-hidden', 'false');
  menuToggle.setAttribute('aria-expanded', 'true');
  menuToggle.setAttribute('aria-label', 'Close menu');
}

function closeMenu() {
  document.body.classList.remove('menu-open');
  menu.setAttribute('aria-hidden', 'true');
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open menu');
}

menuToggle.addEventListener('click', () => {
  document.body.classList.contains('menu-open') ? closeMenu() : openMenu();
});
menuScrim.addEventListener('click', closeMenu);

$('#btn-open').addEventListener('click', () => {
  closeMenu();
  $('#file-input').click();
});
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) loadScript(await file.text());
});

$('#btn-demo').addEventListener('click', async () => {
  closeMenu();
  const res = await fetch(demoScriptUrl);
  loadScript(await res.text());
});

$('#btn-restart').addEventListener('click', () => {
  closeMenu();
  setReadingPosition(0, { jump: true });
});

$('#font-size').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--font-size', `${e.target.value}px`);
});

$('#chk-mirror').addEventListener('change', (e) => {
  document.body.classList.toggle('mirror', e.target.checked);
});

// tap the stage to peek at the toolbar while prompting
stage.addEventListener('click', () => {
  if (document.body.classList.contains('prompting')) {
    document.body.classList.toggle('peek');
  }
});

// mouse near the top edge reveals the toolbar (the hidden bar is
// off-screen with pointer-events: none, so :hover can't do this)
document.addEventListener('mousemove', (e) => {
  if (!document.body.classList.contains('prompting')) return;
  if (e.clientY < 64) document.body.classList.add('peek');
  else if (e.clientY > 160) document.body.classList.remove('peek');
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (document.body.classList.contains('menu-open')) {
      closeMenu();
      return;
    }
    if (listening) stop();
  }
  // manual nudge, also re-anchors the matcher
  if ((e.code === 'ArrowDown' || e.code === 'ArrowUp') && matcher) {
    e.preventDefault();
    const delta = e.code === 'ArrowDown' ? 5 : -5;
    setReadingPosition(matcher.cursor + delta);
  }
});

// drag & drop a .md file anywhere
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (file) loadScript(await file.text());
});

// ---- crash breadcrumbs -------------------------------------------------
// A page killed by the browser (OOM, GPU crash) can't report anything, so
// record how far this session got; if the next load finds a session that
// never exited cleanly, report where it died to the Worker's /log endpoint
// (visible in Cloudflare's Workers Logs).

const beacon = (data) => {
  try {
    navigator.sendBeacon('log', JSON.stringify({ ...data, ua: navigator.userAgent.slice(0, 90) }));
  } catch {
    /* logging must never break the app */
  }
};
const SESSION_KEY = 'cue-session';
const sessionStartedAt = Date.now();
let sessionInferenceCount = 0;
let lastInferenceMs = null;
let currentStage = 'boot';

const persistSession = () => {
  try {
    localStorage.setItem('cue-stage', currentStage);
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        stage: currentStage,
        startedAt: sessionStartedAt,
        lastAliveAt: Date.now(),
        inferences: sessionInferenceCount,
        lastInferMs: lastInferenceMs,
      }),
    );
  } catch {}
};
const setStage = (s) => {
  currentStage = s;
  persistSession();
};

try {
  const previousSession = JSON.parse(localStorage.getItem(SESSION_KEY));
  const previousStage = previousSession?.stage || localStorage.getItem('cue-stage');
  if (previousStage && previousStage !== 'exit') {
    beacon({
      event: 'page-died',
      at: previousStage,
      aliveMs:
        previousSession?.lastAliveAt && previousSession?.startedAt
          ? previousSession.lastAliveAt - previousSession.startedAt
          : null,
      detectedAfterMs: previousSession?.lastAliveAt
        ? Date.now() - previousSession.lastAliveAt
        : null,
      inferences: previousSession?.inferences ?? null,
      lastInferMs: previousSession?.lastInferMs ?? null,
    });
  }
} catch {}
setStage('boot');
beacon({ event: 'page-load', build: BUILD });
setInterval(persistSession, 1000);
window.addEventListener('pagehide', () => setStage('exit'));

// surface uncaught errors in the status pill — mobile browsers have no
// reachable console
window.addEventListener('error', (e) => {
  setStatus(e.message || 'script error', 'err');
  beacon({ event: 'js-error', message: String(e.message).slice(0, 200) });
});
window.addEventListener('unhandledrejection', (e) => {
  setStatus(e.reason?.message || 'async error', 'err');
  beacon({ event: 'js-error', message: String(e.reason?.message ?? e.reason).slice(0, 200) });
});

// ---- boot --------------------------------------------------------------

if (!('wakeLock' in navigator)) {
  wakeChk.checked = false;
  wakeChk.disabled = true;
  wakeChk.parentElement.title = 'Wake Lock API not supported in this browser';
}

let updateSW = null;
let updatePending = false;

function applyPendingUpdate() {
  if (!updatePending || listening) return;
  updatePending = false;
  updateSW?.(true);
}

if (location.protocol === 'https:') {
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updatePending = true;
      if (listening) setStatus('update ready — stop to reload');
      else applyPendingUpdate();
    },
    onRegisteredSW(_url, registration) {
      registration?.update().catch(() => {});
    },
  });
}

fetch(demoScriptUrl)
  .then((r) => (r.ok ? r.text() : Promise.reject()))
  .then(loadScript)
  .catch(() => {});

// preload + warm the model immediately so Start is instant, not the moment
// the camera starts rolling
requestModelLoad();
