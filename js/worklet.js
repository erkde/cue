// Batches mic samples into ~128ms chunks before posting to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.inputRate = sampleRate;
    this.outputRate = options?.processorOptions?.outputRate ?? sampleRate;
    this.step = this.inputRate / this.outputRate;
    this.pending = [];
    this.next = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'configure' && Number.isFinite(e.data.inputRate)) {
        this.inputRate = e.data.inputRate;
        if (Number.isFinite(e.data.outputRate)) this.outputRate = e.data.outputRate;
        this.step = this.inputRate / this.outputRate;
      }
    };
    this.buf = new Float32Array(2048);
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) this.pending.push(ch[i]);
      while (this.next + 1 < this.pending.length) {
        const i = Math.floor(this.next);
        const frac = this.next - i;
        this.buf[this.len++] = this.pending[i] * (1 - frac) + this.pending[i + 1] * frac;
        this.next += this.step;
        if (this.len === this.buf.length) {
          const chunk = this.buf;
          this.port.postMessage({ samples: chunk }, [chunk.buffer]);
          this.buf = new Float32Array(2048);
          this.len = 0;
        }
      }
      const consumed = Math.floor(this.next);
      if (consumed) {
        this.pending.splice(0, consumed);
        this.next -= consumed;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
