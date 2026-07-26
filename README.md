# Cue

A proof-of-concept PWA teleprompter that **listens to the narrator** and
scrolls to wherever they are in the script, instead of forcing a fixed pace.

- Markdown script rendering (open a `.md` file, drag & drop, or the demo)
- Whisper (`whisper-tiny.en`, ~40 MB) running fully in-browser via
  [transformers.js](https://github.com/huggingface/transformers.js) —
  WebGPU when available, WASM otherwise. No audio leaves the device.
- Fuzzy local alignment of the live transcript against the script, so
  misheard words, pauses, or small improvisations don't derail tracking.
- Proportional scroll controller: the further ahead you speak, the faster
  it scrolls; pause and it waits.
- PWA: installable, app shell works offline after first load.

## Architecture

```
js/app.js         orchestrator + UI wiring
js/md.js          minimal markdown -> HTML renderer
js/prompter.js    word-span wrapping, highlight, scroll controller
js/matcher.js     Smith-Waterman-ish transcript/script alignment
js/audio.js       getUserMedia -> 16 kHz PCM ring buffer
js/worklet.js     AudioWorklet that batches mic samples
js/asr-worker.js  Web Worker running whisper-tiny via transformers.js
sw.js             network-first app shell cache
```

The ASR loop snapshots the last ~7 s of audio whenever the worker is idle
(gated on RMS so silence isn't transcribed), transcribes it, and feeds the
tail of the transcript to the matcher. The matcher aligns it against a
window around the current cursor and moves the cursor only on a confident
match; the prompter then servo-scrolls that word to the reading line.

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000
```

(Mic access requires `localhost` or HTTPS.)

## Deploy to Cloudflare Pages

```
npx wrangler login          # once
npx wrangler pages deploy . --project-name cue
```

No build step — the repo root is the site.

## Keys

- **Esc** — stop listening
- **↑ / ↓** — nudge the cursor / re-anchor the matcher
- Mouse wheel / touch — manual override (auto-scroll resumes after ~2.5 s)

## Known PoC limitations

- English only (`whisper-tiny.en`); swap the model id for multilingual.
- First load downloads ~40 MB of model weights (cached afterwards).
- WASM fallback on low-end devices lags a few seconds behind speech.
- The markdown renderer covers a sane subset — exotic Pandoc constructs
  (tables, definition lists, math) degrade to plain paragraphs.
