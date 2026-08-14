import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_AUDIO_SECONDS, RMS_GATE, RMS_WINDOW_SECONDS, SAMPLE_RATE } from '../js/constants.js';
import { enoughAudioForAsr, rmsGateOpen } from '../js/speech-gate.js';

const signal = (seconds, amplitude) =>
  new Float32Array(Math.floor(seconds * SAMPLE_RATE)).fill(amplitude);

test('silence and quiet background sound do not open the current gate', () => {
  assert.equal(rmsGateOpen(signal(RMS_WINDOW_SECONDS, 0)), false);
  assert.equal(rmsGateOpen(signal(RMS_WINDOW_SECONDS, RMS_GATE / 2)), false);
});

test('sound above the RMS threshold opens the current gate', () => {
  assert.equal(rmsGateOpen(signal(RMS_WINDOW_SECONDS, RMS_GATE * 2)), true);
});

test('a loud partial observation window does not open the current gate', () => {
  const partial = new Float32Array(RMS_WINDOW_SECONDS * SAMPLE_RATE - 1).fill(1);
  assert.equal(rmsGateOpen(partial), false);
});

test('Moonshine waits for its minimum amount of buffered audio', () => {
  const minimumSamples = MIN_AUDIO_SECONDS * SAMPLE_RATE;
  assert.equal(enoughAudioForAsr(minimumSamples - 1), false);
  assert.equal(enoughAudioForAsr(minimumSamples), true);
});
