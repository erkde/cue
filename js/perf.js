// Rolling ASR-loop perf sampler. Buckets by backend + build so before/after
// changes compare cleanly; prints to the console AND beacons a summary to the
// Worker's /log endpoint — the only way to read numbers off phones, which have
// no reachable console. Aggregates on-device (percentiles over a batch) so we
// emit one compact line per ~flushEvery inferences instead of spamming.

export class Perf {
  constructor(sink, { build, flushEvery = 20 } = {}) {
    this.sink = sink; // reuse app.js beacon()
    this.build = build;
    this.flushEvery = flushEvery;
    this.device = 'unknown';
    this.s = [];
    this.lastTs = 0;
  }

  setDevice(d) {
    this.device = d;
  }

  // call on start/stop so cycleMs never spans a stopped session
  reset() {
    this.lastTs = 0;
  }

  record({ infer, audioS, matchMs, moved, vad }) {
    const now = performance.now();
    const cycle = this.lastTs ? now - this.lastTs : null;
    this.lastTs = now;
    this.s.push({ infer, audioS, matchMs, moved, cycle, vad });
    if (this.s.length >= this.flushEvery) this.flush();
  }

  // one-shot: model download + warmup timings
  load(info) {
    this.sink({ event: 'perf-load', build: this.build, device: this.device, ...info });
  }

  flush() {
    if (!this.s.length) return;
    const s = this.s;
    this.s = [];
    const pct = (key, p) => {
      const a = s
        .map((x) => x[key])
        .filter((v) => v != null)
        .sort((x, y) => x - y);
      return a.length ? Math.round(a[Math.floor((a.length - 1) * p)]) : null;
    };
    const summary = {
      event: 'perf',
      build: this.build,
      device: this.device,
      vad: s.at(-1)?.vad,
      n: s.length,
      inferP50: pct('infer', 0.5),
      inferP90: pct('infer', 0.9),
      cycleP50: pct('cycle', 0.5),
      cycleP90: pct('cycle', 0.9),
      audioP50: pct('audioS', 0.5),
      matchMax: Math.round(Math.max(...s.map((x) => x.matchMs || 0))),
      movedPct: Math.round((s.filter((x) => x.moved).length / s.length) * 100),
    };
    console.log('[perf]', summary);
    this.sink(summary);
  }
}
