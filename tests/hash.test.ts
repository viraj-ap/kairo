import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../src/lib/hash';
import { timelineHash } from '../src/model/doc';

describe('canonical hash', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  });

  it('drops undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('is a SHA-256', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('equal timelines hash equally regardless of insertion order', async () => {
    const a = { fps: 30, media: {}, tracks: {}, clips: { x: { trackId: 't', start: 0, in: 0, out: 1 }, y: { trackId: 't', start: 5, in: 0, out: 1 } } };
    const b = { fps: 30, clips: { y: { out: 1, in: 0, start: 5, trackId: 't' }, x: { trackId: 't', start: 0, in: 0, out: 1 } }, tracks: {}, media: {} };
    expect(await timelineHash(a)).toBe(await timelineHash(b));
  });
});
