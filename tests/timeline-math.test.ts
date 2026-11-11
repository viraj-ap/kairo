import { describe, expect, it } from 'vitest';
import { moveStart, rulerStep, snap, trimLeft, trimRight } from '../src/lib/timelineMath';
import { formatClock, formatTimecode } from '../src/lib/time';
import type { Timeline } from '../src/model/schema';

const t: Timeline = {
  fps: 30,
  media: { v: { kind: 'video', name: 'v', durationFrames: 100, width: 1, height: 1, fps: 30, hasAudio: false } },
  tracks: {},
  clips: {},
};

describe('snap', () => {
  it('snaps within threshold to the nearest target', () => {
    expect(snap(48, [0, 50, 100], 3)).toEqual({ frame: 50, snapped: 50 });
    expect(snap(45, [0, 50, 100], 3)).toEqual({ frame: 45, snapped: null });
  });

  it('moveStart snaps whichever edge is closer and never goes below 0', () => {
    const c = { trackId: 'a', start: 10, in: 0, out: 20 };
    expect(moveStart(c, 28, [60], 3).start).toBe(40); // end 58 → snaps to 60
    expect(moveStart(c, -50, [], 3).start).toBe(0);
  });
});

describe('trim', () => {
  const clip = { trackId: 'a', mediaHash: 'v', start: 30, in: 10, out: 40 };
  it('left trim keeps the right edge and respects source start', () => {
    expect(trimLeft(t, clip, 35)).toEqual({ start: 35, in: 15 });
    expect(trimLeft(t, clip, 0)).toEqual({ start: 20, in: 0 });
    expect(trimLeft(t, clip, 999)).toEqual({ start: 59, in: 39 });
  });
  it('right trim respects the source length and a 1-frame minimum', () => {
    expect(trimRight(t, clip, 50)).toEqual({ out: 30 });
    expect(trimRight(t, clip, 500)).toEqual({ out: 100 });
    expect(trimRight(t, clip, 0)).toEqual({ out: 11 });
  });
  it('text clips can grow without a source limit', () => {
    expect(trimRight(t, { trackId: 'a', text: 'hi', start: 0, in: 0, out: 30 }, 900)).toEqual({ out: 900 });
  });
});

describe('formatting', () => {
  it('formats frames', () => {
    expect(formatClock(51 * 30, 30)).toBe('0:51');
    expect(formatTimecode(51 * 30 + 15, 30)).toBe('00:00:51.500');
  });
  it('picks a readable ruler step', () => {
    expect(rulerStep(4, 30)).toBe(1);
    expect(rulerStep(0.1, 30)).toBe(30);
  });
});
