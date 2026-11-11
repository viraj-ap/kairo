/**
 * Streaming access to one file's audio: demux the AAC samples (MP4/M4A/MOV) and decode
 * only the stretch that's needed, in ~1 s batches, with WebCodecs AudioDecoder. WAV is
 * read as PCM directly. Nothing ever holds a whole file's decoded audio.
 */
import { audioDescription, demux, samples as trackSamples } from '../mp4';

export interface Pcm {
  /** Source time (seconds) of the first frame. */
  t0: number;
  sampleRate: number;
  channels: Float32Array[];
}

interface AacSample {
  t: number; // seconds
  dur: number;
  offset: number;
  size: number;
}

export abstract class AudioSource {
  abstract readonly sampleRate: number;
  abstract readonly duration: number;
  /** Decode [from, to) seconds of source audio. */
  abstract read(from: number, to: number): Promise<Pcm | null>;
  close() {}
}

class AacSource extends AudioSource {
  private decoder: AudioDecoder | null = null;
  private out: AudioData[] = [];
  constructor(
    private blob: Blob,
    private samples: AacSample[],
    private config: AudioDecoderConfig,
    readonly sampleRate: number,
    readonly duration: number,
  ) {
    super();
  }

  private ensure() {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder;
    this.decoder?.state !== 'closed' && this.decoder?.close();
    this.decoder = new AudioDecoder({ output: (d) => this.out.push(d), error: () => undefined });
    this.decoder.configure(this.config);
    return this.decoder;
  }

  private find(t: number): number {
    let lo = 0;
    let hi = this.samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.samples[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  async read(from: number, to: number): Promise<Pcm | null> {
    if (!this.samples.length || from >= this.duration) return null;
    // AAC frames overlap (MDCT): start one frame early and discard its output.
    const a = Math.max(0, this.find(from) - 1);
    const b = Math.min(this.samples.length - 1, this.find(to) + 1);
    const start = this.samples[a].offset;
    let end = start;
    for (let i = a; i <= b; i++) end = Math.max(end, this.samples[i].offset + this.samples[i].size);
    const buf = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
    const dec = this.ensure();
    this.out = [];
    for (let i = a; i <= b; i++) {
      const s = this.samples[i];
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.t * 1e6), duration: Math.round(s.dur * 1e6), data: buf.subarray(s.offset - start, s.offset - start + s.size) }));
    }
    await dec.flush();
    const datas = this.out;
    this.out = [];
    if (!datas.length) return null;
    const first = datas.findIndex((d) => d.timestamp / 1e6 + d.duration / 1e6 > from);
    const use = datas.slice(Math.max(0, first === -1 ? datas.length : first));
    const nch = Math.min(2, use[0]?.numberOfChannels ?? 1);
    const frames = use.reduce((n, d) => n + d.numberOfFrames, 0);
    const channels = Array.from({ length: nch }, () => new Float32Array(frames));
    let at = 0;
    for (const d of use) {
      for (let c = 0; c < nch; c++) d.copyTo(channels[c].subarray(at, at + d.numberOfFrames), { planeIndex: c, format: 'f32-planar' });
      at += d.numberOfFrames;
    }
    const t0 = use.length ? use[0].timestamp / 1e6 : from;
    datas.forEach((d) => d.close());
    return { t0, sampleRate: this.sampleRate, channels };
  }

  close() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
  }
}

class WavSource extends AudioSource {
  constructor(
    private blob: Blob,
    private dataOffset: number,
    private dataBytes: number,
    private channels: number,
    private bits: number,
    private isFloat: boolean,
    readonly sampleRate: number,
  ) {
    super();
  }
  get duration() {
    return this.dataBytes / (this.channels * (this.bits / 8)) / this.sampleRate;
  }
  async read(from: number, to: number): Promise<Pcm | null> {
    const bpf = this.channels * (this.bits / 8);
    const f0 = Math.max(0, Math.floor(from * this.sampleRate));
    const f1 = Math.min(this.dataBytes / bpf, Math.ceil(to * this.sampleRate));
    if (f1 <= f0) return null;
    const view = new DataView(await this.blob.slice(this.dataOffset + f0 * bpf, this.dataOffset + f1 * bpf).arrayBuffer());
    const n = f1 - f0;
    const nch = Math.min(2, this.channels);
    const out = Array.from({ length: nch }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const p = i * bpf + c * (this.bits / 8);
        out[c][i] = this.isFloat ? view.getFloat32(p, true) : this.bits === 16 ? view.getInt16(p, true) / 32768 : this.bits === 24 ? ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 8388608) : view.getInt32(p, true) / 2147483648;
      }
    }
    return { t0: f0 / this.sampleRate, sampleRate: this.sampleRate, channels: out };
  }
}

async function openWav(blob: Blob): Promise<AudioSource | null> {
  const head = new DataView(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
  const tag = (o: number) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3));
  if (head.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12;
  let fmt: { ch: number; rate: number; bits: number; float: boolean } | null = null;
  while (p + 8 <= head.byteLength) {
    const id = tag(p);
    const len = head.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { ch: head.getUint16(p + 10, true), rate: head.getUint32(p + 12, true), bits: head.getUint16(p + 22, true), float: head.getUint16(p + 8, true) === 3 };
    if (id === 'data' && fmt) return new WavSource(blob, p + 8, Math.min(len, blob.size - p - 8), fmt.ch, fmt.bits, fmt.float, fmt.rate);
    p += 8 + len + (len & 1);
  }
  return null;
}

/** A streaming source for this file, or null if its audio needs the full-decode fallback. */
export async function openAudioSource(blob: Blob): Promise<AudioSource | null> {
  const wav = await openWav(blob);
  if (wav) return wav;
  try {
    const d = await demux(blob);
    const t = d.info.audioTracks[0];
    if (!t || !t.codec.startsWith('mp4a')) return null;
    const config: AudioDecoderConfig = { codec: t.codec, sampleRate: t.audio!.sample_rate, numberOfChannels: t.audio!.channel_count, description: audioDescription(d, t.id) };
    if (!(await AudioDecoder.isConfigSupported(config)).supported) return null;
    const samples = trackSamples(d, t.id).map((s) => ({ t: s.cts / s.timescale, dur: s.duration / s.timescale, offset: s.offset, size: s.size }));
    const duration = samples.length ? samples[samples.length - 1].t + samples[samples.length - 1].dur : 0;
    return new AacSource(blob, samples, config, t.audio!.sample_rate, duration);
  } catch {
    return null;
  }
}
