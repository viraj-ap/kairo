import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addClip, deleteClips, initDoc, readTimeline, splitClip, timelineHash, updateClip, maps } from '../src/model/doc';

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function randomOp(doc: Y.Doc, r: () => number) {
  const ids = [...maps(doc).clips.keys()];
  const pick = () => ids[Math.floor(r() * ids.length)];
  const k = r();
  if (k < 0.35 || ids.length === 0) {
    addClip(doc, { trackId: r() < 0.5 ? 'trk-video' : 'trk-titles', start: Math.floor(r() * 300), in: 0, out: 1 + Math.floor(r() * 90) });
  } else if (k < 0.6) {
    updateClip(doc, pick(), { start: Math.floor(r() * 300) });
  } else if (k < 0.75) {
    updateClip(doc, pick(), { opacity: Math.round(r() * 10) / 10 });
  } else if (k < 0.85) {
    const id = pick();
    const c = maps(doc).clips.get(id)!.toJSON();
    splitClip(doc, id, c.start + 1 + Math.floor(r() * Math.max(1, c.out - c.in - 1)));
  } else {
    deleteClips(doc, [pick()]);
  }
}

/** Exchange state in a random pairwise order until everyone has everything. */
function syncRandomly(docs: Y.Doc[], r: () => number) {
  const pairs: [number, number][] = [];
  for (let i = 0; i < docs.length; i++) for (let j = 0; j < docs.length; j++) if (i !== j) pairs.push([i, j]);
  pairs.sort(() => r() - 0.5);
  for (const [a, b] of pairs) Y.applyUpdate(docs[b], Y.encodeStateAsUpdate(docs[a], Y.encodeStateVector(docs[b])));
  // One more full round guarantees transitive delivery regardless of order.
  for (const [a, b] of pairs) Y.applyUpdate(docs[b], Y.encodeStateAsUpdate(docs[a], Y.encodeStateVector(docs[b])));
}

describe('CRDT convergence fuzz', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: 2–5 docs with random concurrent ops converge`, async () => {
      const r = rng(seed);
      const n = 2 + Math.floor(r() * 4);
      const docs = Array.from({ length: n }, () => new Y.Doc());
      // Every client initializes concurrently; deterministic default ids keep them convergent.
      docs.forEach((d) => initDoc(d, { projectId: 'P', name: 'fuzz' }));
      for (let round = 0; round < 4; round++) {
        for (const d of docs) for (let i = 0; i < 1 + Math.floor(r() * 8); i++) randomOp(d, r);
        if (r() < 0.7) syncRandomly(docs, r);
      }
      syncRandomly(docs, r);
      const hashes = await Promise.all(docs.map((d) => timelineHash(readTimeline(d))));
      expect(new Set(hashes).size).toBe(1);
      const t = readTimeline(docs[0]);
      for (const c of Object.values(t.clips)) expect(c.out).toBeGreaterThan(c.in);
    });
  }

  it('concurrent edits to different fields of one clip both survive', () => {
    const [a, b] = [new Y.Doc(), new Y.Doc()];
    initDoc(a, {});
    const id = addClip(a, { trackId: 'trk-video', start: 0, in: 0, out: 30 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    updateClip(a, id, { start: 50 });
    updateClip(b, id, { opacity: 0.5 });
    syncRandomly([a, b], rng(1));
    const c = readTimeline(b).clips[id];
    expect(c.start).toBe(50);
    expect(c.opacity).toBe(0.5);
  });

  it('delete wins over a concurrent edit', () => {
    const [a, b] = [new Y.Doc(), new Y.Doc()];
    initDoc(a, {});
    const id = addClip(a, { trackId: 'trk-video', start: 0, in: 0, out: 30 });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    deleteClips(a, [id]);
    updateClip(b, id, { start: 90 });
    syncRandomly([a, b], rng(2));
    expect(readTimeline(a).clips[id]).toBeUndefined();
    expect(readTimeline(b).clips[id]).toBeUndefined();
  });
});
