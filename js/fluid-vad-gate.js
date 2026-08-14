import { createVad } from '@fluidinference/fluidvad';

// FluidVad is streaming, while Moonshine runs on a slower request/result loop.
// Latch speech between those loops so a short utterance is not lost merely
// because it ended before Moonshine became available for its next window.
export async function createFluidVadGate() {
  const vad = await createVad();
  let speechPending = false;

  return {
    push(samples) {
      const events = vad.push(samples);
      try {
        const speechStarted = events.some((event) => event.isStart);
        if (vad.isSpeaking || speechStarted) speechPending = true;
        return speechStarted;
      } finally {
        events.forEach((event) => event.free());
      }
    },

    hasSpeech() {
      return speechPending;
    },

    consume() {
      speechPending = false;
    },

    reset() {
      speechPending = false;
      vad.reset();
    },

    free() {
      speechPending = false;
      vad.free();
    },
  };
}
