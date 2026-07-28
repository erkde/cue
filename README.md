# Cue

A proof-of-concept PWA teleprompter that **listens to the narrator** and
scrolls to wherever they are in the script, instead of forcing a fixed pace.

- Markdown script rendering (open a `.md` file, drag & drop, or the demo)
- Speech recognition runs fully in-browser via
  [transformers.js](https://github.com/huggingface/transformers.js) — no audio
  leaves the device. Default is
  [Moonshine](https://github.com/moonshine-ai/moonshine) (`moonshine-tiny`) on
  WASM, whose compute scales with audio length instead of Whisper's fixed 30 s
  frame — fast (~200 ms/inference) and reliable on every device. Whisper
  (`whisper-tiny.en`) on WebGPU is opt-in via `?engine=whisper` (it's slow on
  Firefox's WebGPU and unstable on iOS Safari, so it's not the default).
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
js/asr-worker.js  Web Worker: Whisper (WebGPU) / Moonshine (WASM) via transformers.js
js/perf.js        rolling ASR perf sampler (beacons summaries to the Worker's /log)
worker.js         Cloudflare Worker: serves assets, proxies model files, collects logs
sw.js             network-first app shell cache
```

The ASR loop snapshots the last few seconds of audio whenever the worker is
idle (7 s on WebGPU, 3 s on the WASM/Moonshine path; gated on RMS so silence
isn't transcribed), transcribes it, and feeds the tail of the transcript to
the matcher. The matcher aligns it against a window around the current cursor
and moves the cursor only on a confident, forward-biased match; the prompter
then servo-scrolls that word to the reading line.

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000
```

(Mic access requires `localhost` or HTTPS.)

## Deploy

Runs as a Cloudflare Worker (`worker.js` serves the static assets, proxies the
model files, and collects client logs), deployed via the Git integration —
pushing to `main` ships it. To deploy manually:

```
npx wrangler login   # once
npx wrangler deploy
```

No build step — the repo root is the site.

## Keys

- **Esc** — stop listening
- **↑ / ↓** — nudge the cursor / re-anchor the matcher
- Mouse wheel / touch — manual override (auto-scroll resumes after ~2.5 s)

## Known PoC limitations

- English only (`whisper-tiny.en` / `moonshine-tiny`); swap the model ids for
  other languages.
- First load downloads model weights — ~115 MB on the WebGPU path (Whisper,
  fp32 encoder), ~30 MB on the WASM path (Moonshine, q8); cached afterwards.
- The markdown renderer covers a sane subset — exotic Pandoc constructs
  (tables, definition lists, math) degrade to plain paragraphs.
