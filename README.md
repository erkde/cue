# Cue

A proof-of-concept PWA teleprompter that **listens to the narrator** and
scrolls to wherever they are in the script, instead of forcing a fixed pace.

- Markdown script rendering (open a `.md` file, drag & drop, or the demo)
- [Moonshine](https://github.com/moonshine-ai/moonshine) (`moonshine-tiny`)
  running fully in-browser on WASM via
  [transformers.js](https://github.com/huggingface/transformers.js) — no audio
  leaves the device. Its compute scales with the audio length instead of
  Whisper's fixed 30 s frame, so it's fast (~94–200 ms/inference) and reliable
  on every browser and phone tested.
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
js/worklet.js     AudioWorklet that resamples and batches mic samples
js/asr-worker.js  Web Worker running Moonshine (WASM) via transformers.js
js/perf.js        rolling ASR perf sampler (beacons summaries to the Worker's /log)
worker.js         Cloudflare Worker: serves assets, proxies model files, collects logs
vite.config.js    hashed production assets + generated Workbox app-shell cache
```

The ASR loop snapshots the last ~3 s of audio whenever the worker is idle
(gated on RMS so silence isn't transcribed), transcribes it, and feeds the tail
of the transcript to the matcher. The matcher aligns it against a window around
the current cursor and moves the cursor only on a confident, forward-biased
match; the prompter then servo-scrolls that word to the reading line.

### Threads & data flow

Four threads, each with a different deadline. Data flows one way, and every
stage **discards or overwrites rather than queues** — so memory is bounded,
nothing locks, and a slow device degrades to _lag_, not _collapse_.

```mermaid
flowchart TB
    mic([🎤 mic 48kHz])

    subgraph audio["Audio-render thread · hard real-time"]
        wl["worklet.js<br/>128-sample quanta · resampled to 16 kHz"]
        batch["coalesce to ~128 ms chunks (2048 samples)"]
        wl --> batch
    end

    subgraph main["Main thread · UI + orchestration"]
        ring["ring buffer 12 s<br/>overwrite-oldest · no lock"]
        latest["latest(3 s)<br/>freshest slice · copied"]
        loop["schedule loop<br/>result-driven pacing"]
        result["result handler"]
        scroll["matcher → prompter<br/>servo-scroll"]
        ring --> latest --> loop
        result --> scroll
        result --> loop
    end

    subgraph worker["ASR Web Worker · no deadline"]
        busy["busy flag: single-flight<br/>overlap dropped · latest-wins"]
    end

    subgraph ort["ORT WASM · 1 thread default"]
        compute["Moonshine matmuls<br/>~94–200 ms"]
    end

    mic --> wl
    batch -->|"postMessage · transfer · ~8/s"| ring
    loop -->|"postMessage(audio) · transfer"| busy
    busy <-->|"WASM calls"| compute
    busy -->|"postMessage(result)"| result
```

## Run locally

```
npm install
npm run dev
```

Open the local URL printed by Vite. Mic access requires `localhost` or HTTPS.

## Tests

Unit tests for the pure logic — transcript/script alignment (`matcher.js`) and
markdown rendering incl. the link-scheme allowlist (`md.js`) — on Node's
built-in runner, no build step or framework:

```
npm test
```

## Deploy

Vite emits content-hashed client assets and a Workbox service worker. The
Cloudflare Worker (`worker.js`) serves those assets, proxies model files, and
collects client logs. Configure the Git integration to run `npm run build` and
deploy using `dist/cue/wrangler.json`. To deploy manually:

```
npx wrangler login   # once
npm run deploy
```

Cue checks for releases on launch, when returning to the foreground, and while
left open. When it discovers a waiting service worker, Cue stops capture,
disposes and terminates the ASR worker, activates the new release, and reloads.
If WebKit does not complete the controller change, the status pill asks the user
to close and reopen Cue. The model cache is retained unless its model revision
changes.

## Keys

- **Esc** — stop listening
- **↑ / ↓** — nudge the cursor / re-anchor the matcher
- Mouse wheel / touch — manual override (auto-scroll resumes after ~2.5 s)

## Known PoC limitations

- English only (`moonshine-tiny`); swap the model id for other languages.
- First load downloads the model weights (~30 MB), cached by the browser
  afterwards.
- The markdown renderer covers a sane subset — exotic Pandoc constructs
  (tables, definition lists, math) degrade to plain paragraphs.
