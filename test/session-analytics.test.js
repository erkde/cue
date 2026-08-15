import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionAnalytics } from '../js/session-analytics.js';

test('summarizes active reading time, tracked words, and overall pace', () => {
  const analytics = new SessionAnalytics();
  analytics.start({ at: 1000, wordIndex: 10 });
  analytics.resume({ at: 2000, wordIndex: 10 });
  analytics.observePosition({ from: 10, to: 14, at: 3000 });
  analytics.observePosition({ from: 14, to: 24, at: 7000 });
  const summary = analytics.stop({ at: 12000 });

  assert.equal(summary.durationMs, 11000);
  assert.equal(summary.activeDurationMs, 10000);
  assert.equal(summary.wordsTracked, 15);
  assert.equal(summary.averageWpm, 90);
});

test('records only pauses between speech segments', () => {
  const analytics = new SessionAnalytics({ longPauseMs: 2500 });
  analytics.start({ at: 0, wordIndex: 0 });
  analytics.resume({ at: 0 });

  analytics.observeGate({ open: false, at: 0, wordIndex: 0 });
  analytics.observeGate({ open: true, at: 5000, wordIndex: 2 });
  analytics.observeGate({ open: false, at: 6000, wordIndex: 4 });
  analytics.observeGate({ open: true, at: 8000, wordIndex: 5 });
  analytics.observeGate({ open: false, at: 9000, wordIndex: 6 });
  analytics.observeGate({ open: true, at: 12000, wordIndex: 7 });
  analytics.observeGate({ open: false, at: 13000, wordIndex: 8 });

  const summary = analytics.stop({ at: 18000 });
  assert.deepEqual(summary.reviewMoments, [
    { type: 'pause', wordIndex: 6, elapsedMs: 9000, durationMs: 3000 },
  ]);
});

test('backgrounded time is excluded and does not become a pause', () => {
  const analytics = new SessionAnalytics({ longPauseMs: 1000 });
  analytics.start({ at: 0, wordIndex: 0 });
  analytics.resume({ at: 0 });
  analytics.observeGate({ open: true, at: 100, wordIndex: 1 });
  analytics.suspend({ at: 1000 });
  analytics.resume({ at: 11000, wordIndex: 1 });
  analytics.observeGate({ open: true, at: 12000, wordIndex: 2 });
  const summary = analytics.stop({ at: 13000 });

  assert.equal(summary.activeDurationMs, 3000);
  assert.deepEqual(summary.reviewMoments, []);
});

test('records re-reads and manual re-anchors at their destination words', () => {
  const analytics = new SessionAnalytics();
  analytics.start({ at: 0, wordIndex: 0 });
  analytics.resume({ at: 0 });
  analytics.observePosition({ from: 0, to: 20, at: 1000 });
  analytics.observePosition({ from: 20, to: 8, at: 2000 });
  analytics.observePosition({ from: 8, to: 40, at: 3000, source: 'manual' });
  const summary = analytics.stop({ at: 4000 });

  assert.deepEqual(summary.reviewMoments, [
    { type: 'reread', wordIndex: 8, elapsedMs: 2000, from: 20, to: 8 },
    { type: 'manual', wordIndex: 40, elapsedMs: 3000, from: 8, to: 40 },
  ]);
});

test('a manual anchor before the first match becomes the pace baseline', () => {
  const analytics = new SessionAnalytics();
  analytics.start({ at: 0, wordIndex: 0 });
  analytics.resume({ at: 0 });
  analytics.observePosition({ from: 0, to: 40, at: 500, source: 'manual' });
  analytics.observePosition({ from: 40, to: 44, at: 1000 });
  const summary = analytics.stop({ at: 2000 });

  assert.equal(summary.wordsTracked, 5);
});

test('limits review output to the strongest moments while retaining their chronology', () => {
  const analytics = new SessionAnalytics({ longPauseMs: 100, maxReviewMoments: 2 });
  analytics.start({ at: 0, wordIndex: 0 });
  analytics.resume({ at: 0 });

  for (const [start, duration, wordIndex] of [
    [1000, 200, 1],
    [2000, 600, 2],
    [3000, 400, 3],
  ]) {
    analytics.observeGate({ open: true, at: start - 100, wordIndex });
    analytics.observeGate({ open: false, at: start, wordIndex });
    analytics.observeGate({ open: true, at: start + duration, wordIndex });
  }

  const summary = analytics.stop({ at: 5000 });
  assert.equal(summary.totalReviewMoments, 3);
  assert.deepEqual(
    summary.reviewMoments.map((event) => event.durationMs),
    [600, 400],
  );
});
