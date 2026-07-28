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

let asrWindowS = 7; // seconds of audio per inference (shorter on wasm)
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
let listening = false;
let modelReady = false;
let lastText = '';

// perf instrumentation — bump BUILD alongside sw.js VERSION each deploy so
// summaries in Workers Logs are comparable across releases. beacon() is
// defined lower down; the wrapper defers the lookup until flush time.
const BUILD = 'cue-v25';
const perf = new Perf((d) => beacon(d), { build: BUILD });
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
}

function loadScript(text) {
  const tokens = prompter.setContent(mdToHtml(text));
  matcher = new Matcher(tokens);
  setStatus(`${tokens.length} words`);
}

// ---- ASR loop ----------------------------------------------------------

// iOS Safari's WebGPU can crash the page on real hardware when loading the
// model; force the wasm path there. iPads in desktop mode report Macintosh,
// hence the touch-points check.
const isIOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function ensureWorker() {
  if (worker) return;
  worker = new Worker('js/asr-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
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
          // wasm backend reality — is the encoder single-threaded (headroom)?
          threads: msg.wasm?.threads,
          cores: msg.wasm?.cores,
          isolated: msg.wasm?.isolated,
          simd: msg.wasm?.simd,
        });
      }
      if (msg.device === 'wasm') asrWindowS = 3; // shorter window on CPU — trims decode + audio staleness (cue-v17 A/B)
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
      onTranscript(msg.text);
      perf.record({ infer: msg.ms, audioS: pendingAudioS, matchMs: lastMatchMs, moved: lastMoved });
      if (listening) scheduleInference(LOOP_IDLE_MS);
    } else if (msg.type === 'error') {
      console.error('asr:', msg.message);
      setStatus('asr error — see console', 'err');
      beacon({ event: 'asr-error', message: String(msg.message).slice(0, 200) });
      if (listening) scheduleInference(2000);
    }
  };
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
  worker.postMessage({ type: 'transcribe', audio }, [audio.buffer]);
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
          mic = new MicCapture();
          await mic.start();
        } catch (err) {
          mic = null;
          setStatus('microphone blocked', 'err');
          console.error(err);
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
  listening = true;
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
  ensureWorker();
  if (!modelReady) showLoader(true); // Start beat the preload
  worker.postMessage({ type: 'load', preferWasm: isIOS }); // idempotent; re-triggers 'ready'
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
  setStatus('idle');
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
  const res = await fetch('demo-script.md');
  loadScript(await res.text());
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
    matcher.cursor = Math.max(0, Math.min(matcher.tokens.length - 1, matcher.cursor + delta));
    prompter.setTarget(matcher.cursor);
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
const setStage = (s) => {
  try {
    localStorage.setItem('cue-stage', s);
  } catch {}
};

try {
  const prev = localStorage.getItem('cue-stage');
  if (prev && prev !== 'exit') beacon({ event: 'page-died', at: prev });
} catch {}
setStage('boot');
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

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

fetch('demo-script.md')
  .then((r) => (r.ok ? r.text() : Promise.reject()))
  .then(loadScript)
  .catch(() => {});

// preload + warm the model immediately so Start is instant, not the moment
// the camera starts rolling
ensureWorker();
worker.postMessage({ type: 'load', preferWasm: isIOS });
