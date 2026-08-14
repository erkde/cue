import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVad } from '@fluidinference/fluidvad';
import { SAMPLE_RATE } from '../js/constants.js';
import { createFluidVadGate } from '../js/fluid-vad-gate.js';
import { decodePcm16MonoWav } from '../test-support/wav.js';

const readFixture = (name) => {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const decoded = decodePcm16MonoWav(bytes);
  assert.equal(decoded.sampleRate, SAMPLE_RATE);
  return decoded.samples;
};

const detectSpeech = async (samples) => {
  const vad = await createVad();
  try {
    const detected = vad.segment(samples);
    return detected.map((segment) => {
      const times = { start: segment.startTime, end: segment.endTime };
      segment.free();
      return times;
    });
  } finally {
    vad.free();
  }
};

const mixAt = (foreground, background, offset, gain = 0.75) => {
  const mixed = Float32Array.from(foreground, (sample) => sample * gain);
  const available = Math.min(background.length, mixed.length - offset);
  for (let index = 0; index < available; index++) {
    const combined = mixed[offset + index] + background[index] * gain;
    mixed[offset + index] = Math.max(-1, Math.min(1, combined));
  }
  return mixed;
};

test('FluidVad retains the speech in the speech fixture', async () => {
  const segments = await detectSpeech(readFixture('speech-with-silence.wav'));
  const detectedSeconds = segments.reduce(
    (total, segment) => total + segment.end - segment.start,
    0,
  );

  assert.ok(segments.length > 0);
  assert.ok(segments[0].start >= 1.5 && segments[0].start <= 2.5);
  assert.ok(segments.at(-1).end >= 21.5 && segments.at(-1).end <= 22.5);
  assert.ok(detectedSeconds >= 18);
});

test('FluidVad rejects the typing fixture as non-speech', async () => {
  const segments = await detectSpeech(readFixture('typing-sample.wav'));

  assert.deepEqual(segments, []);
});

test('FluidVad retains speech while typing plays concurrently', async () => {
  const speech = readFixture('speech-with-silence.wav');
  const typing = readFixture('typing-sample.wav');
  const mixed = mixAt(speech, typing, 2 * SAMPLE_RATE);
  const segments = await detectSpeech(mixed);
  const detectedSeconds = segments.reduce(
    (total, segment) => total + segment.end - segment.start,
    0,
  );

  assert.ok(segments.length > 0);
  assert.ok(detectedSeconds >= 18);
});

test('the streaming FluidVad gate latches speech until Moonshine consumes it', async () => {
  const samples = readFixture('speech-with-silence.wav');
  const gate = await createFluidVadGate();
  try {
    let starts = 0;
    for (let offset = 0; offset < samples.length && !gate.hasSpeech(); offset += 2048) {
      if (gate.push(samples.subarray(offset, offset + 2048))) starts += 1;
    }

    assert.equal(starts, 1);
    assert.equal(gate.hasSpeech(), true);
    gate.consume();
    assert.equal(gate.hasSpeech(), false);
    gate.reset();
    assert.equal(gate.hasSpeech(), false);
  } finally {
    gate.free();
  }
});
