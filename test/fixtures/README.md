# Audio fixtures

`speech-with-silence.wav` is the 16 kHz `test01_20s.wav` fixture from
[`voxserv/audio_quality_testing_samples`](https://github.com/voxserv/audio_quality_testing_samples).
It contains excerpts of Creative Commons speech recordings from Freesound,
edited by Stanislav Sinyagin. The source repository lists and links the original
recordings and their authors.

The fixture is used only to compare speech-gate behaviour. It contains two
seconds of silence, twenty seconds of speech, then two seconds of silence.

`typing-sample.m4a` is a locally recorded 19-second sample of keyboard typing
with no speech. `typing-sample.wav` is the test copy, converted to Cue's 16 kHz
mono 16-bit PCM format with:

```sh
ffmpeg -i typing-sample.m4a -ar 16000 -ac 1 -c:a pcm_s16le typing-sample.wav
```
