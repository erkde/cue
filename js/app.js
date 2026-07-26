import { mdToHtml } from './md.js';
import { Matcher } from './matcher.js';
import { Prompter } from './prompter.js';
import { MicCapture } from './audio.js';

const $ = (sel) => document.querySelector(sel);

const stage = $('#stage');
const article = $('#script');
const statusEl = $('#status');
const transcriptEl = $('#transcript');
const startBtn = $('#btn-start');

const ASR_WINDOW_S = 7;      // seconds of audio per inference
const MIN_AUDIO_S = 1.5;
const RMS_GATE = 0.01;       // skip inference on near-silence
const LOOP_IDLE_MS = 300;

const END_OF_SCRIPT_WORDS = 3;   // release the wake lock this close to the end

const prompter = new Prompter(stage, article);
let matcher = null;
let mic = null;
let worker = null;
let listening = false;
let modelReady = false;
let lastText = '';

const loaderEl = $('#loader');
const loaderMain = $('#loader-main');
const loaderSub = $('#loader-sub');

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

function ensureWorker() {
  if (worker) return;
  worker = new Worker('js/asr-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      setStatus(`downloading model — ${msg.mb} MB`);
      loaderMain.textContent = 'Downloading speech model…';
      loaderSub.textContent =
        `${msg.file}${msg.pct != null ? ` ${msg.pct}%` : ''} · ${msg.mb} MB total`;
    } else if (msg.type === 'status' && msg.stage === 'warmup') {
      setStatus('warming up model…');
      loaderMain.textContent = 'Warming up model…';
      loaderSub.textContent = '';
    } else if (msg.type === 'ready') {
      modelReady = true;
      showLoader(false);
      if (listening) {
        setStatus(`listening (${msg.device})`, 'live');
        scheduleInference();
      } else {
        setStatus(`model ready (${msg.device})`);
      }
    } else if (msg.type === 'result') {
      onTranscript(msg.text);
      if (listening) setTimeout(scheduleInference, LOOP_IDLE_MS);
    } else if (msg.type === 'error') {
      console.error('asr:', msg.message);
      setStatus('asr error — see console', 'err');
      if (listening) setTimeout(scheduleInference, 2000);
    }
  };
}

function scheduleInference() {
  if (!listening || !mic) return;
  const audio = mic.latest(ASR_WINDOW_S);
  if (audio.length < MIN_AUDIO_S * 16000 || MicCapture.rms(audio) < RMS_GATE) {
    setTimeout(scheduleInference, LOOP_IDLE_MS);
    return;
  }
  worker.postMessage({ type: 'transcribe', audio }, [audio.buffer]);
}

function onTranscript(text) {
  if (!text || text === lastText) return;
  lastText = text;
  transcriptEl.textContent = text;
  const idx = matcher?.feed(text);
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
    wakeLock.addEventListener('release', () => { wakeLock = null; });
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
});

wakeChk.addEventListener('change', () => {
  if (!listening) return;
  wakeChk.checked ? acquireWakeLock() : releaseWakeLock();
});

// ---- start / stop ------------------------------------------------------

async function start() {
  if (!matcher || !matcher.tokens.length) {
    setStatus('load a script first', 'err');
    return;
  }
  try {
    mic = new MicCapture();
    await mic.start();
  } catch (err) {
    setStatus('microphone blocked', 'err');
    console.error(err);
    return;
  }
  listening = true;
  acquireWakeLock();
  document.body.classList.add('prompting');
  startBtn.textContent = '■ Stop';
  startBtn.classList.add('live');
  prompter.start();
  ensureWorker();
  if (!modelReady) showLoader(true);        // Start beat the preload
  worker.postMessage({ type: 'load' });     // idempotent; re-triggers 'ready'
}

async function stop() {
  listening = false;
  releaseWakeLock();
  showLoader(false);
  document.body.classList.remove('prompting', 'peek');
  startBtn.textContent = '▶ Start';
  startBtn.classList.remove('live');
  prompter.stop();
  await mic?.stop();
  mic = null;
  setStatus('idle');
}

// ---- UI wiring ---------------------------------------------------------

startBtn.addEventListener('click', () => (listening ? stop() : start()));

$('#btn-open').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) loadScript(await file.text());
});

$('#btn-demo').addEventListener('click', async () => {
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
  if (e.code === 'Escape' && listening) stop();
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

// surface uncaught errors in the status pill — mobile browsers have no
// reachable console
window.addEventListener('error', (e) => setStatus(e.message || 'script error', 'err'));
window.addEventListener('unhandledrejection', (e) =>
  setStatus(e.reason?.message || 'async error', 'err'));

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
worker.postMessage({ type: 'load' });
