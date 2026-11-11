import { describe, expect, it } from 'vitest';
import { Mixer } from '../src/media/audio/mixer';
import { AudioSource, type Pcm } from '../src/media/audio/source';

/** A source whose sample i is i / sampleRate (a ramp), so positions are easy to check. */
class Ramp extends AudioSource {
  reads: [number, number][] = [];
  constructor(
    readonly sampleRate: number,
    readonly duration: number,
  ) {
    super();
  }
  async read(from: number, to: number): Promise<Pcm | null> {
    this.reads.push([from, to]);
    const a = Math.max(0, Math.floor(from * this.sampleRate));
    const b = Math.min(Math.round(this.duration * this.sampleRate), Math.ceil(to * this.sampleRate));
    const ch = new Float32Array(b - a);
    for (let i = 0; i < ch.length; i++) ch[i] = (a + i) / this.sampleRate;
    return { t0: a / this.sampleRate, sampleRate: this.sampleRate, channels: [ch] };
  }
}

describe('streaming mixer', () => {
  it('places a clip at its timeline position and reads from its in-point, with gain', async () => {
    const src = new Ramp(48000, 60);
    // clip starts at timeline 1 s, in-point 10 s, gain 0.5
    const m = new Mixer([{ clipId: 'c', mediaHash: 'h', start: 30, in: 300, out: 600, gain: 0.5 }], 30, 48000, async () => src);
    const [L, R] = await m.render(0, 96000); // 0–2 s
    expect(L[47999]).toBe(0); // before the clip
    expect(L[48000]).toBeCloseTo(10 * 0.5, 3); // first sample = source 10 s
    expect(L[72000]).toBeCloseTo(10.5 * 0.5, 3); // 0.5 s later
    expect(R[72000]).toBeCloseTo(L[72000], 6); // mono → both channels
  });

  it('resamples 44.1 kHz sources to the 48 kHz output', async () => {
    const src = new Ramp(44100, 10);
    const m = new Mixer([{ clipId: 'c', mediaHash: 'h', start: 0, in: 0, out: 300, gain: 1 }], 30, 48000, async () => src);
    const [L] = await m.render(1, 48000);
    for (const i of [0, 12345, 47999]) expect(L[i]).toBeCloseTo(1 + i / 48000, 4);
  });

  it('decodes only around the playhead (about a second ahead), never the whole file', async () => {
    const src = new Ramp(48000, 3600);
    const m = new Mixer([{ clipId: 'c', mediaHash: 'h', start: 0, in: 0, out: 3600 * 30, gain: 1 }], 30, 48000, async () => src);
    for (let t = 1800; t < 1803; t += 2048 / 48000) await m.render(t, 2048);
    for (const [a, b] of src.reads) expect(b - a).toBeLessThan(1.1);
    expect(src.reads[0][0]).toBeGreaterThan(1799.9);
  });

  it('sums overlapping clips and stops at clip ends', async () => {
    const src = new Ramp(48000, 60);
    const m = new Mixer(
      [
        { clipId: 'a', mediaHash: 'h', start: 0, in: 0, out: 30, gain: 1 },
        { clipId: 'b', mediaHash: 'h', start: 0, in: 30, out: 60, gain: 1 },
      ],
      30,
      48000,
      async () => src,
    );
    const [L] = await m.render(0, 96000);
    expect(L[24000]).toBeCloseTo(0.5 + 1.5, 3);
    expect(L[50000]).toBe(0); // both clips are 1 s long
  });
});
