import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildManifest, chunkCountOf, chunkHashes, hashBlob, CHUNK_SIZE } from '../src/media/manifest';
import { chunkScores, chunksForPlayback, nextChunk } from '../src/media/priority';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('manifest', () => {
  it('streams a whole-file hash and per-chunk hashes', async () => {
    const data = new Uint8Array(CHUNK_SIZE * 2 + 12345);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 255;
    const m = await buildManifest(new Blob([data]), (h) => h);
    expect(m.hash).toBe(sha(data));
    expect(m.key).toBe(m.hash);
    expect(chunkCountOf(m)).toBe(3);
    expect(chunkHashes(m)).toEqual([0, 1, 2].map((i) => sha(data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))));
    expect(await hashBlob(new Blob([data]))).toBe(sha(data));
  });

  it('handles an empty file', async () => {
    const m = await buildManifest(new Blob([]), (h) => `${h}.proxy`);
    expect(chunkCountOf(m)).toBe(0);
    expect(m.key.endsWith('.proxy')).toBe(true);
  });
});

describe('selective sync priority', () => {
  // 20 s of proxy: second s lives in chunk 1 + floor(s / 2); chunk 0 is the header.
  const timeIndex = Array.from({ length: 20 }, (_, s) => [1 + Math.floor(s / 2), 1 + Math.floor(s / 2)]).flat();
  const count = 11;

  const order = (scores: Float64Array) => [...scores.keys()].sort((a, b) => scores[a] - scores[b]);

  it('fetches the header, then the 10 s after the playhead, then before, then the rest', () => {
    const o = order(chunkScores(count, timeIndex, [12], true));
    expect(o[0]).toBe(0); // header
    expect(o.slice(1, 6)).toEqual([7, 8, 9, 10, 6]); // 12–19 s → chunks 7–10, then 11 s → chunk 6
    expect(o.indexOf(7)).toBeLessThan(o.indexOf(6));
    expect(o.indexOf(6)).toBeLessThan(o.indexOf(2));
  });

  it('re-ranks when the playhead jumps', () => {
    const a = order(chunkScores(count, timeIndex, [0], true));
    const b = order(chunkScores(count, timeIndex, [18], true));
    expect(a.slice(0, 3)).toEqual([0, 1, 2]);
    expect(b.slice(0, 2)).toEqual([0, 10]);
  });

  it('originals are background work in file order', () => {
    expect(order(chunkScores(5, undefined, [3], false))).toEqual([0, 1, 2, 3, 4]);
  });

  it('knows which chunks make the proxy playable at a position', () => {
    expect(chunksForPlayback(count, timeIndex, 4)).toEqual([0, 3, 4, 5, 6, 7]);
  });

  it('never picks stored or in-flight chunks', () => {
    const s = chunkScores(count, timeIndex, [0], true);
    expect(nextChunk(s, new Set([0]), new Set([1]))).toBe(2);
    expect(nextChunk(s, new Set(Array.from({ length: count }, (_, i) => i)), new Set())).toBe(-1);
  });
});
