export const DEFAULT_LONG_PAUSE_MS = 2500;
export const DEFAULT_REVIEW_MOMENTS = 8;

const validWordIndex = (value) => Number.isInteger(value) && value >= 0;
const elapsed = (from, to) => Math.max(0, to - from);

export class SessionAnalytics {
  constructor({
    longPauseMs = DEFAULT_LONG_PAUSE_MS,
    maxReviewMoments = DEFAULT_REVIEW_MOMENTS,
  } = {}) {
    this.longPauseMs = longPauseMs;
    this.maxReviewMoments = maxReviewMoments;
    this.reset();
  }

  reset() {
    this.running = false;
    this.startedAt = 0;
    this.activeSince = null;
    this.activeDurationMs = 0;
    this.startWordIndex = 0;
    this.currentWordIndex = 0;
    this.wordsTracked = 0;
    this.hasTrackedSpeech = false;
    this.speechSeenInActiveSpan = false;
    this.pauseStartedAt = null;
    this.pauseWordIndex = null;
    this.events = [];
  }

  start({ at, wordIndex = 0 }) {
    this.reset();
    this.running = true;
    this.startedAt = at;
    this.startWordIndex = validWordIndex(wordIndex) ? wordIndex : 0;
    this.currentWordIndex = this.startWordIndex;
  }

  resume({ at, wordIndex = this.currentWordIndex }) {
    if (!this.running || this.activeSince != null) return;
    if (validWordIndex(wordIndex)) {
      this.currentWordIndex = wordIndex;
      if (!this.hasTrackedSpeech) this.startWordIndex = wordIndex;
    }
    this.activeSince = at;
    this.speechSeenInActiveSpan = false;
    this.pauseStartedAt = null;
    this.pauseWordIndex = null;
  }

  suspend({ at }) {
    if (!this.running || this.activeSince == null) return;
    this.activeDurationMs += elapsed(this.activeSince, at);
    this.activeSince = null;
    this.speechSeenInActiveSpan = false;
    this.pauseStartedAt = null;
    this.pauseWordIndex = null;
  }

  observeGate({ open, at, wordIndex = this.currentWordIndex }) {
    if (!this.running || this.activeSince == null) return;
    if (validWordIndex(wordIndex)) this.currentWordIndex = wordIndex;

    if (open) {
      if (this.pauseStartedAt != null) {
        const durationMs = elapsed(this.pauseStartedAt, at);
        if (durationMs >= this.longPauseMs) {
          this.events.push({
            type: 'pause',
            wordIndex: this.pauseWordIndex,
            elapsedMs: elapsed(this.startedAt, this.pauseStartedAt),
            durationMs,
            severity: durationMs,
          });
        }
      }
      this.pauseStartedAt = null;
      this.pauseWordIndex = null;
      this.speechSeenInActiveSpan = true;
      return;
    }

    if (this.speechSeenInActiveSpan && this.pauseStartedAt == null) {
      this.pauseStartedAt = at;
      this.pauseWordIndex = this.currentWordIndex;
    }
  }

  observePosition({ from, to, at, source = 'speech' }) {
    if (!this.running || this.activeSince == null || !validWordIndex(to)) return;
    const previous = validWordIndex(from) ? from : this.currentWordIndex;
    this.currentWordIndex = to;

    if (source === 'manual') {
      if (!this.hasTrackedSpeech) this.startWordIndex = to;
      if (to !== previous) {
        this.events.push({
          type: 'manual',
          wordIndex: to,
          elapsedMs: elapsed(this.startedAt, at),
          from: previous,
          to,
          severity: 2500 + Math.abs(to - previous) * 100,
        });
      }
      return;
    }

    if (source !== 'speech') return;
    if (!this.hasTrackedSpeech) {
      this.wordsTracked += Math.max(1, to - this.startWordIndex + 1);
      this.hasTrackedSpeech = true;
      return;
    }

    if (to > previous) {
      this.wordsTracked += to - previous;
    } else if (to < previous) {
      this.events.push({
        type: 'reread',
        wordIndex: to,
        elapsedMs: elapsed(this.startedAt, at),
        from: previous,
        to,
        severity: 3000 + (previous - to) * 250,
      });
    }
  }

  stop({ at }) {
    if (!this.running) return null;
    this.suspend({ at });
    this.running = false;

    const reviewMoments = [...this.events]
      .sort((a, b) => b.severity - a.severity)
      .slice(0, this.maxReviewMoments)
      .sort((a, b) => a.elapsedMs - b.elapsedMs)
      .map(({ severity: _severity, ...event }) => event);
    const averageWpm =
      this.wordsTracked && this.activeDurationMs
        ? Math.round(this.wordsTracked / (this.activeDurationMs / 60000))
        : null;

    return {
      durationMs: elapsed(this.startedAt, at),
      activeDurationMs: this.activeDurationMs,
      wordsTracked: this.wordsTracked,
      averageWpm,
      reviewMoments,
      totalReviewMoments: this.events.length,
    };
  }
}
