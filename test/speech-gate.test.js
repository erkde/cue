import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIN_AUDIO_SECONDS, RMS_GATE, RMS_WINDOW_SECONDS, SAMPLE_RATE } from '../js/constants.js';
import { enoughAudioForAsr, rmsGateOpen, speechGateMode } from '../js/speech-gate.js';
import { decodePcm16MonoWav } from '../test-support/wav.js';

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

test('the vad query parameter selects an experimental speech gate', () => {
  assert.equal(speechGateMode(''), 'rms');
  assert.equal(speechGateMode('?vad=rms'), 'rms');
  assert.equal(speechGateMode('?vad=fluid'), 'fluid');
  assert.equal(speechGateMode('?vad=off'), 'off');
  assert.equal(speechGateMode('?vad=unknown'), 'rms');
});

test('the current RMS gate separates real speech from the fixture silence', () => {
  const bytes = readFileSync(new URL('./fixtures/speech-with-silence.wav', import.meta.url));
  const { samples, sampleRate } = decodePcm16MonoWav(bytes);
  assert.equal(sampleRate, SAMPLE_RATE);

  const windowSamples = RMS_WINDOW_SECONDS * SAMPLE_RATE;
  const gateResults = (startSeconds, endSeconds) => {
    const results = [];
    const start = startSeconds * SAMPLE_RATE;
    const end = Math.min(endSeconds * SAMPLE_RATE, samples.length);
    for (let offset = start; offset + windowSamples <= end; offset += windowSamples) {
      results.push(rmsGateOpen(samples.subarray(offset, offset + windowSamples)));
    }
    return results;
  };

  const openingSilence = gateResults(0, 2);
  const speech = gateResults(2, 22);
  const closingSilence = gateResults(22, 24);

  assert.equal(openingSilence.length, 8);
  assert.equal(speech.length, 80);
  assert.equal(closingSilence.length, 7); // the WAV ends one sample short of 24 seconds
  assert.ok(openingSilence.every((open) => !open));
  assert.ok(speech.every((open) => open));
  assert.ok(closingSilence.every((open) => !open));
});

test('the current RMS gate mistakes typing for speech', () => {
  const bytes = readFileSync(new URL('./fixtures/typing-sample.wav', import.meta.url));
  const { samples, sampleRate } = decodePcm16MonoWav(bytes);
  assert.equal(sampleRate, SAMPLE_RATE);

  const windowSamples = RMS_WINDOW_SECONDS * SAMPLE_RATE;
  const results = [];
  for (let offset = 0; offset + windowSamples <= samples.length; offset += windowSamples) {
    results.push(rmsGateOpen(samples.subarray(offset, offset + windowSamples)));
  }

  assert.equal(results.length, 77);
  assert.equal(results.filter(Boolean).length, 39);
});
