import AsrWorker from './asr-worker.js?worker';
import demoScriptUrl from '../demo-script.md?url&no-inline';
import { registerSW } from 'virtual:pwa-register';
import { mdToHtml } from './md.js';
import { Matcher } from './matcher.js';
import { Prompter } from './prompter.js';
import { MicCapture } from './audio.js';
import { Perf } from './perf.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  ASR_SHUTDOWN_TIMEOUT_MS,
  ASR_WINDOW_SECONDS,
  END_OF_SCRIPT_WORDS,
  LOOP_IDLE_MS,
  MIC_BUFFER_SECONDS,
  POST_RELOAD_MODEL_DELAY_MS,
  RMS_WINDOW_SECONDS,
  SAMPLE_RATE,
  UPDATE_ACTIVATION_TIMEOUT_MS,
  UPDATE_CHECK_INTERVAL_MS,
} from './constants.js';
import { enoughAudioForAsr, rmsGateOpen } from './speech-gate.js';

const $ = (sel) => document.querySelector(sel);

const stage = $('#stage');
const article = $('#script');
const lens = $('#lens');
const statusEl = $('#status');
const transcriptEl = $('#transcript');
const startBtn = $('#btn-logo');
const startMenuBtn = $('#btn-start-menu');
const recLightBtn = $('#btn-rec-light');
const menuToggle = $('#btn-menu');
const menu = $('#menu');
const menuScrim = $('#menu-scrim');
const updateBtn = $('#btn-update');
const fontSizeInput = $('#font-size');
const mirrorChk = $('#chk-mirror');
const wakeChk = $('#chk-wake');

const savedSettings = loadSettings();
fontSizeInput.value = String(savedSettings.fontSize);
document.documentElement.style.setProperty('--font-size', `${savedSettings.fontSize}px`);
mirrorChk.checked = savedSettings.mirror;
document.body.classList.toggle('mirror', savedSettings.mirror);
wakeChk.checked = savedSettings.keepAwake;

function persistSettings() {
  saveSettings({
    fontSize: Number(fontSizeInput.value),
    mirror: mirrorChk.checked,
    keepAwake: wakeChk.checked,
  });
}

const prompter = new Prompter(stage, article, lens);
let matcher = null;
let mic = null;
let loopTimer = null;
let micSyncing = false; // guards the async acquire/release in syncMic
let micSyncPending = false; // a state change arrived mid-sync — re-check after
let micSyncPromise = null; // lets stop/update wait for an in-flight acquire to unwind
let worker = null;
let workerBooted = false;
let modelLoadRequested = false;
let modelLoadTimer = null;
let postReloadModelDelayMs = 0;
let listening = false;
let modelReady = false;
let lastText = '';
let positionVersion = 0;
let scriptSelectionVersion = 0;

// WebKit can retain a terminated worker's ORT WASM heap briefly across a page
// reload. Delay the replacement heap from the last clean pagehide boundary;
// fresh tabs have no marker and still preload immediately.
const PAGEHIDE_TS_KEY = 'cue:pagehide-at';
let modelLoadNotBefore = 0;
try {
  const pagehideAt = Number(sessionStorage.getItem(PAGEHIDE_TS_KEY));
  if (Number.isFinite(pagehideAt) && pagehideAt > 0) {
    modelLoadNotBefore = pagehideAt + POST_RELOAD_MODEL_DELAY_MS;
  }
} catch {
  // Storage can be unavailable in private browsing; loading still works without the cooldown.
}

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
const updateDialogEl = $('#update-dialog');
const updateReloadBtn = $('#btn-update-reload');
const updateCancelBtn = $('#btn-update-cancel');

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

// Replacing the script is a session boundary. Read/fetch the new content
// before calling this so a cancelled picker or failed load leaves the current
// reading untouched. Keep a pending app update deferred: reloading here would
// immediately discard the script the user just chose.
async function replaceScript(text) {
  scriptSelectionVersion += 1; // explicit choices always beat the boot-time demo fetch
  if (listening) await stop();
  loadScript(text);
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
          modelId: msg.model?.id,
          modelRevision: msg.model?.revision,
          modelDtype: msg.model?.dtype,
          runtime: msg.wasm?.runtime,
          wasmBinary: msg.wasm?.binary,
          postReloadModelDelayMs,
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
  const delay = modelLoadNotBefore - Date.now();
  if (delay > 0) {
    if (!modelLoadTimer) {
      postReloadModelDelayMs = Math.ceil(delay);
      modelLoadTimer = setTimeout(() => {
        modelLoadTimer = null;
        requestModelLoad();
      }, delay);
    }
    return;
  }
  ensureWorker();
  modelLoadRequested = true;
  if (workerBooted) worker.postMessage({ type: 'load', threads: THREADS_OVERRIDE });
}

// pagehide cannot wait for the pipeline's asynchronous dispose path. Terminate
// the worker synchronously so its WASM address space starts being reclaimed
// before the replacement page begins allocating another ORT heap.
function terminateAsrWorkerImmediately() {
  clearTimeout(loopTimer);
  clearTimeout(modelLoadTimer);
  modelLoadTimer = null;
  const current = worker;
  worker = null;
  workerBooted = false;
  modelLoadRequested = false;
  modelReady = false;
  current?.terminate();
}

// Give Transformers/ORT a chance to release its WASM sessions before a new
// app release takes control. Worker termination is the bounded fallback: it
// prevents a stuck runtime from blocking an update indefinitely on iOS.
async function shutdownAsrWorker(timeoutMs = ASR_SHUTDOWN_TIMEOUT_MS) {
  clearTimeout(loopTimer);
  clearTimeout(modelLoadTimer);
  modelLoadTimer = null;
  const current = worker;
  worker = null;
  workerBooted = false;
  modelLoadRequested = false;
  modelReady = false;
  if (!current) return { acknowledged: true };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (acknowledged, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      current.removeEventListener('message', onMessage);
      current.terminate();
      resolve({ acknowledged, error });
    };
    const onMessage = (event) => {
      if (event.data?.type === 'disposed') finish(true, event.data.error);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    current.addEventListener('message', onMessage);
    try {
      current.postMessage({ type: 'dispose' });
    } catch (err) {
      finish(false, String(err?.message ?? err));
    }
  });
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
  const level = mic.latest(RMS_WINDOW_SECONDS);
  if (!rmsGateOpen(level)) {
    scheduleInference();
    return;
  }
  const audio = mic.latest(ASR_WINDOW_SECONDS);
  if (!enoughAudioForAsr(audio.length)) {
    scheduleInference();
    return;
  }
  pendingAudioS = audio.length / SAMPLE_RATE; // read before the transfer detaches the buffer
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
  persistSettings();
  if (!listening) return;
  wakeChk.checked ? acquireWakeLock() : releaseWakeLock();
});

// ---- microphone lifecycle ----------------------------------------------

// Hold the mic only while we're actually listening, the model is ready to
// consume audio, AND the tab is focused — so the OS "mic in use" indicator
// never lingers through the model download/warmup or while we're backgrounded.
// Serialized via micSyncing so overlapping triggers can't double-acquire.
function syncMic() {
  if (micSyncing) {
    micSyncPending = true; // a state change landed mid-await — re-check below
    return micSyncPromise;
  }
  micSyncing = true;
  micSyncPromise = (async () => {
    try {
      do {
        micSyncPending = false;
        const wanted = listening && modelReady && document.visibilityState === 'visible';
        if (wanted && !mic) {
          try {
            mic = new MicCapture(MIC_BUFFER_SECONDS, { raw: RAW_MIC });
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
      micSyncPromise = null;
    }
  })();
  return micSyncPromise;
}

// ---- start / stop ------------------------------------------------------

async function start() {
  if (updateApplying) return;
  if (!matcher || !matcher.tokens.length) {
    setStatus('load a script first', 'err');
    return;
  }
  // Must run in the synchronous click/tap call stack for Mobile Safari.
  MicCapture.prime().catch((err) => console.warn('audio unlock:', err));
  // A newly loaded script has no committed anchor. Respect any position set by
  // matching, tapping, or Start over; otherwise begin at the first word on the
  // first line immediately below the reading line.
  if (prompter.targetIdx < 0) {
    const idx = prompter.wordIndexAtOrBelowReadingLine();
    if (idx != null) setReadingPosition(idx);
  }
  listening = true;
  syncUpdateButtonVisibility();
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
  syncUpdateButtonVisibility();
  checkForUpdate();
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
updateBtn.addEventListener('click', () => {
  closeMenu();
  if (listening) return;
  showUpdateDialog();
});
updateReloadBtn.addEventListener('click', () => {
  hideUpdateDialog();
  void applyPendingUpdate();
});
updateCancelBtn.addEventListener('click', cancelUpdateDialog);

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
  if (!file) return;
  const text = await file.text();
  await replaceScript(text);
  // Allow choosing the same file again after it has changed on disk.
  e.target.value = '';
});

$('#btn-demo').addEventListener('click', async () => {
  closeMenu();
  const res = await fetch(demoScriptUrl);
  if (!res.ok) throw new Error(`Demo script failed to load (${res.status})`);
  await replaceScript(await res.text());
});

$('#btn-restart').addEventListener('click', () => {
  closeMenu();
  setReadingPosition(0, { jump: true });
});

fontSizeInput.addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--font-size', `${e.target.value}px`);
});
fontSizeInput.addEventListener('change', persistSettings);

mirrorChk.addEventListener('change', (e) => {
  document.body.classList.toggle('mirror', e.target.checked);
  persistSettings();
});

// Tap a word to re-anchor there. Links retain their native navigation; tapping
// anywhere else on the stage peeks at the toolbar while prompting.
stage.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const word = e.target.closest('.w');
  const idx = Number(word?.dataset.wordIndex);
  if (word && Number.isInteger(idx)) {
    setReadingPosition(idx, { jump: true });
    return;
  }
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
    if (!updateDialogEl.hidden) {
      cancelUpdateDialog();
      return;
    }
    if (document.body.classList.contains('menu-open')) {
      closeMenu();
      return;
    }
    if (listening) stop();
  }
  if (!updateDialogEl.hidden) {
    if (e.code === 'Tab') {
      const from = document.activeElement;
      if (e.shiftKey && from === updateReloadBtn) {
        e.preventDefault();
        updateCancelBtn.focus();
      } else if (!e.shiftKey && from === updateCancelBtn) {
        e.preventDefault();
        updateReloadBtn.focus();
      }
    }
    return;
  }
  // manual nudge, also re-anchors the matcher
  if ((e.code === 'ArrowDown' || e.code === 'ArrowUp') && matcher) {
    e.preventDefault();
    const delta = e.code === 'ArrowDown' ? 5 : -5;
    setReadingPosition(matcher.cursor + delta, { jump: true });
  }
});

// drag & drop a .md file anywhere
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (!file) return;
  const text = await file.text();
  await replaceScript(text);
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
const SESSION_KEY = 'cue:session';
const LEGACY_SESSION_KEY = 'cue-session';
const LEGACY_STAGE_KEY = 'cue-stage';
const sessionStartedAt = Date.now();
let sessionInferenceCount = 0;
let lastInferenceMs = null;
let currentStage = 'boot';

const persistSession = () => {
  try {
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
  const currentSession = localStorage.getItem(SESSION_KEY);
  const legacySession = localStorage.getItem(LEGACY_SESSION_KEY);
  const previousSession = JSON.parse(currentSession || legacySession);
  const previousStage = previousSession?.stage || localStorage.getItem(LEGACY_STAGE_KEY);
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
  localStorage.removeItem(LEGACY_SESSION_KEY);
  localStorage.removeItem(LEGACY_STAGE_KEY);
} catch {}
setStage('boot');
beacon({ event: 'page-load', build: BUILD });
setInterval(persistSession, 1000);
window.addEventListener('pagehide', () => {
  setStage('exit');
  const pagehideAt = Date.now();
  modelLoadNotBefore = pagehideAt + POST_RELOAD_MODEL_DELAY_MS;
  try {
    sessionStorage.setItem(PAGEHIDE_TS_KEY, String(pagehideAt));
  } catch {}
  terminateAsrWorkerImmediately();
});
window.addEventListener('pageshow', (event) => {
  // A bfcache restore resumes this same JS realm after pagehide terminated its
  // worker. Recreate the model after the same reclamation cooldown.
  if (event.persisted) requestModelLoad();
});

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
let swRegistration = null;
let updatePending = false;
let updateApplying = false;
let updateFallbackTimer = null;
const UPDATE_RELOAD_KEY = `cue:update-reload:${BUILD}`;
const LEGACY_UPDATE_RELOAD_KEY = `cue-update-reload:${BUILD}`;

function checkForUpdate() {
  if (listening || updateApplying) return;
  swRegistration?.update().catch(() => {});
}

function syncUpdateButtonVisibility() {
  updateBtn.hidden = listening || updateApplying || !updatePending;
}

function showUpdateDialog() {
  updateDialogEl.hidden = false;
  updateReloadBtn.focus();
}

function hideUpdateDialog() {
  updateDialogEl.hidden = true;
}

function cancelUpdateDialog() {
  hideUpdateDialog();
  startBtn.focus();
}

function reloadForUpdate({ forced = false } = {}) {
  clearTimeout(updateFallbackTimer);
  try {
    // If the new controller somehow serves this same build again, don't get
    // trapped in an iOS reload loop. A subsequent build has a different key.
    if (
      sessionStorage.getItem(UPDATE_RELOAD_KEY) === '1' ||
      sessionStorage.getItem(LEGACY_UPDATE_RELOAD_KEY) === '1'
    ) {
      sessionStorage.setItem(UPDATE_RELOAD_KEY, '1');
      sessionStorage.removeItem(LEGACY_UPDATE_RELOAD_KEY);
      if (!forced) return;
    }
    sessionStorage.setItem(UPDATE_RELOAD_KEY, '1');
    sessionStorage.removeItem(LEGACY_UPDATE_RELOAD_KEY);
  } catch {
    // Storage can be unavailable in private browsing; the in-memory
    // updateApplying guard still prevents duplicate reloads on this page.
  }
  beacon({ event: 'app-update', phase: 'reload', build: BUILD });
  setStage('exit');
  location.reload();
}

async function applyPendingUpdate() {
  if (!updatePending || updateApplying) return;
  updateApplying = true;
  updatePending = false;
  syncUpdateButtonVisibility();
  try {
    // Selecting Update available is an atomic restart: stop capture, then tear down
    // the model worker before changing controllers.
    if (listening) await stop();
    setStatus('preparing update…');
    const shutdown = await shutdownAsrWorker();
    beacon({
      event: 'app-update',
      phase: 'activate',
      build: BUILD,
      disposed: shutdown.acknowledged,
      disposeError: shutdown.error,
    });
    setStatus('installing update…');
    if (!updateSW) throw new Error('service worker update is unavailable');
    // Normally onNeedReload fires on controllerchange. If WebKit never emits
    // it, the user's confirmation also authorises one guarded fallback reload.
    updateFallbackTimer = setTimeout(
      () => reloadForUpdate({ forced: true }),
      UPDATE_ACTIVATION_TIMEOUT_MS,
    );
    await updateSW(false);
  } catch (err) {
    console.error('app update:', err);
    beacon({
      event: 'app-update',
      phase: 'error',
      message: String(err?.message ?? err).slice(0, 200),
    });
    reloadForUpdate({ forced: true });
  }
}

if (location.protocol === 'https:') {
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      if (updateApplying) return;
      updatePending = true;
      syncUpdateButtonVisibility();
    },
    onNeedReload: reloadForUpdate,
    onRegisteredSW(_url, registration) {
      swRegistration = registration;
      checkForUpdate();
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
}

const bootScriptSelectionVersion = scriptSelectionVersion;
fetch(demoScriptUrl)
  .then((r) => (r.ok ? r.text() : Promise.reject()))
  .then((text) => {
    if (scriptSelectionVersion === bootScriptSelectionVersion) loadScript(text);
  })
  .catch(() => {});

// preload + warm the model immediately so Start is instant, not the moment
// the camera starts rolling
requestModelLoad();
