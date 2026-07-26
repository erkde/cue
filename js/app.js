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

const prompter = new Prompter(stage, article);
let matcher = null;
let mic = null;
let worker = null;
let listening = false;
let lastText = '';

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
      setStatus(`loading model ${msg.pct}%`);
    } else if (msg.type === 'ready') {
      setStatus(`listening (${msg.device})`, 'live');
      scheduleInference();
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
  if (idx != null) prompter.setTarget(idx);
}

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
  document.body.classList.add('prompting');
  startBtn.textContent = '■ Stop';
  startBtn.classList.add('live');
  prompter.start();
  setStatus('loading model…');
  ensureWorker();
  worker.postMessage({ type: 'load' });
}

async function stop() {
  listening = false;
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

// ---- boot --------------------------------------------------------------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

fetch('demo-script.md')
  .then((r) => (r.ok ? r.text() : Promise.reject()))
  .then(loadScript)
  .catch(() => {});
