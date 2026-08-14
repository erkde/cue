// Minimal test-fixture decoder for PCM WAV files. Production audio already
// arrives as Float32 samples through Web Audio, so this belongs in tests only.
export function decodePcm16MonoWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));

  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') {
    throw new Error('fixture is not a RIFF/WAVE file');
  }

  let format = null;
  let dataOffset = null;
  let dataSize = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const id = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const contents = offset + 8;
    if (id === 'fmt ') {
      format = {
        encoding: view.getUint16(contents, true),
        channels: view.getUint16(contents + 2, true),
        sampleRate: view.getUint32(contents + 4, true),
        bitsPerSample: view.getUint16(contents + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = contents;
      dataSize = size;
    }
    offset = contents + size + (size % 2);
  }

  if (!format || dataOffset == null || dataSize == null) {
    throw new Error('fixture is missing WAV format or audio data');
  }
  if (format.encoding !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error('fixture must be 16-bit mono PCM');
  }

  const samples = new Float32Array(Math.floor(dataSize / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return { samples, sampleRate: format.sampleRate };
}
