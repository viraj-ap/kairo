/**
 * Mixes the timeline's audio for any time range: for each audible segment, read just the
 * source audio it needs (streaming, ~1 s decode batches), resample to the output rate with
 * linear interpolation, apply gain, and sum. Used for live playback and for export.
 */
import type { AudioSegment } from '../../engine';
import type { AudioSource, Pcm } from './source';

export const DECODE_AHEAD_S = 1.0;

export class Mixer {
  private cache = new Map<string, Pcm>();

  constructor(
    private segments: AudioSegment[],
    private fps: number,
    readonly sampleRate: number,
    private sourceFor: (hash: string) => Promise<AudioSource | null>,
  ) {}

  /** PCM for `seg` covering source seconds [s0, s1). */
  private async pcm(seg: AudioSegment, s0: number, s1: number): Promise<Pcm | null> {
    const c = this.cache.get(seg.clipId);
    const covers = (p: Pcm) => p.t0 <= s0 + 1e-6 && p.t0 + p.channels[0].length / p.sampleRate >= Math.min(s1, (seg.out) / this.fps) - 1e-6;
    if (c && covers(c)) return c;
    const src = await this.sourceFor(seg.mediaHash);
    if (!src) return null;
    const p = await src.read(Math.max(0, s0 - 0.01), Math.max(s1, s0 + DECODE_AHEAD_S));
    if (p) this.cache.set(seg.clipId, p);
    return p;
  }

  /** Render `frames` output frames starting at timeline time `t` (seconds). */
  async render(t: number, frames: number): Promise<[Float32Array, Float32Array]> {
    const L = new Float32Array(frames);
    const R = new Float32Array(frames);
    const sr = this.sampleRate;
    const t1 = t + frames / sr;
    for (const seg of this.segments) {
      const segStart = seg.start / this.fps;
      const segEnd = (seg.start + seg.out - seg.in) / this.fps;
      const a = Math.max(t, segStart);
      const b = Math.min(t1, segEnd);
      if (b <= a) continue;
      const srcA = seg.in / this.fps + (a - segStart);
      const srcB = seg.in / this.fps + (b - segStart);
      const p = await this.pcm(seg, srcA, srcB);
      if (!p) continue;
      const i0 = Math.round((a - t) * sr);
      const i1 = Math.min(frames, Math.round((b - t) * sr));
      const ratio = p.sampleRate / sr;
      const base = (srcA - p.t0) * p.sampleRate;
      const left = p.channels[0];
      const right = p.channels[1] ?? left;
      const n = left.length;
      for (let i = i0; i < i1; i++) {
        const x = base + (i - i0) * ratio;
        const k = Math.floor(x);
        if (k < 0 || k >= n) continue;
        const f = x - k;
        const k1 = k + 1 < n ? k + 1 : k;
        L[i] += (left[k] + (left[k1] - left[k]) * f) * seg.gain;
        R[i] += (right[k] + (right[k1] - right[k]) * f) * seg.gain;
      }
    }
    return [L, R];
  }
}

export const PEAKS_PER_SECOND = 100;

/** Max |sample| per 10 ms over the whole source, decoded a batch at a time. */
export async function streamPeaks(src: AudioSource): Promise<Float32Array> {
  const out = new Float32Array(Math.ceil(src.duration * PEAKS_PER_SECOND));
  for (let t = 0; t < src.duration; t += 10) {
    const p = await src.read(t, Math.min(src.duration, t + 10));
    if (!p) break;
    const ch = p.channels[0];
    const step = p.sampleRate / PEAKS_PER_SECOND;
    for (let i = 0; i < ch.length; i++) {
      const bucket = Math.floor(p.t0 * PEAKS_PER_SECOND + i / step);
      if (bucket < 0 || bucket >= out.length) continue;
      const v = Math.abs(ch[i]);
      if (v > out[bucket]) out[bucket] = v;
    }
  }
  return out;
}
