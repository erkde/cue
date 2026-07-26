// Batches mic samples into ~128ms chunks before posting to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      if (this.len + ch.length > this.buf.length) {
        this.port.postMessage(this.buf.slice(0, this.len));
        this.len = 0;
      }
      this.buf.set(ch, this.len);
      this.len += ch.length;
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
