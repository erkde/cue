// Microphone capture: 16 kHz mono PCM into a ring buffer the ASR loop can
// snapshot from at any time.

const SAMPLE_RATE = 16000;

export class MicCapture {
  constructor(seconds = 12) {
    this.buf = new Float32Array(SAMPLE_RATE * seconds);
    this.writeIdx = 0;
    this.total = 0;
    this.ctx = null;
    this.stream = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.audioWorklet.addModule('js/worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => this.push(e.data);
    src.connect(this.node);
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
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.total = 0;
    this.writeIdx = 0;
  }
}
