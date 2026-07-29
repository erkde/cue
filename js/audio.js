import workletUrl from './worklet.js?url&no-inline';

// Microphone capture: 16 kHz mono PCM into a ring buffer the ASR loop can
// snapshot from at any time.

const SAMPLE_RATE = 16000;

export class MicCapture {
  constructor(seconds = 12, { raw = false } = {}) {
    this.buf = new Float32Array(SAMPLE_RATE * seconds);
    this.writeIdx = 0;
    this.total = 0;
    this.ctx = null;
    this.stream = null;
    this.src = null;
    this.node = null;
    this.sink = null;
    this.raw = raw; // ?raw=1: bypass platform audio processing (see start)
  }

  async start() {
    // Default keeps the browser's echo cancellation + noise suppression on.
    // On Android those flags route capture through the VOICE_COMMUNICATION
    // (VoIP) path, whose AGC/gating can hand Moonshine over-processed audio that
    // transcribes poorly (movedPct 0). ?raw=1 turns all of it off to feed the
    // model the unprocessed signal — a single-speaker teleprompter has no
    // far-end audio to echo-cancel anyway.
    const audio = { channelCount: 1 };
    if (this.raw) {
      audio.echoCancellation = false;
      audio.noiseSuppression = false;
      audio.autoGainControl = false;
    } else {
      audio.echoCancellation = true;
      audio.noiseSuppression = true;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    // The requested rate is only a hint. Chrome on Linux/Android commonly
    // keeps the context at the hardware rate (usually 48 kHz), so the
    // worklet must resample explicitly before filling the 16 kHz ring buffer.
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => this.push(e.data.samples);
    this.node.port.postMessage({ type: 'configure', inputRate: this.ctx.sampleRate });
    this.src.connect(this.node);
    // Keep the graph rendering without sending microphone audio to the
    // speakers. A disconnected worklet may not be pulled by every browser.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.writeIdx] = chunk[i];
      this.writeIdx = (this.writeIdx + 1) % this.buf.length;
    }
    this.total += chunk.length;
  }

  // copy of the most recent `seconds` of audio, oldest first
  latest(seconds) {
    const n = Math.min(Math.floor(seconds * SAMPLE_RATE), this.total, this.buf.length);
    const out = new Float32Array(n);
    let idx = (this.writeIdx - n + this.buf.length) % this.buf.length;
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[idx];
      idx = (idx + 1) % this.buf.length;
    }
    return out;
  }

  static rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (samples.length || 1));
  }

  async stop() {
    this.src?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.src = null;
    this.node = null;
    this.sink = null;
    this.total = 0;
    this.writeIdx = 0;
  }
}
