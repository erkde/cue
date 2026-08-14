import { MIN_AUDIO_SECONDS, RMS_GATE, RMS_WINDOW_SECONDS, SAMPLE_RATE } from './constants.js';

// Cue's current speech gate is deliberately simple: consider the most recent
// quarter-second to contain sound when its RMS reaches the configured level.
// Keeping the decision pure makes the existing behaviour reproducible in tests
// and gives future VAD implementations a common baseline to compare against.
export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

export function rmsGateOpen(samples) {
  const requiredSamples = RMS_WINDOW_SECONDS * SAMPLE_RATE;
  return samples.length >= requiredSamples && rms(samples) >= RMS_GATE;
}

export function enoughAudioForAsr(sampleCount) {
  return sampleCount >= MIN_AUDIO_SECONDS * SAMPLE_RATE;
}
