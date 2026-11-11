import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import init from '../src/engine/pkg/kairo_core.js';
import { diff } from '../src/engine';
import { applyMerge, baseOf } from '../src/model/branches';
import { addClip, applyTimeline, deleteClips, fieldAuthor, initDoc, readMeta, readTimeline, registerAuthor, setMeta, updateClip } from '../src/model/doc';
import { listVersions, restoreVersion, saveVersion } from '../src/model/versions';
import { canonicalJson } from '../src/lib/hash';
import { LOCAL, maps } from '../src/model/doc';

beforeAll(async () => {
  await init({ module_or_path: readFileSync('src/engine/pkg/kairo_core_bg.wasm') });
});

/** main + a branch cut from it, like createBranch does. */
function project() {
  const main = new Y.Doc();
  initDoc(main, { name: 'p' });
  const a = addClip(main, { trackId: 'trk-video', start: 0, in: 0, out: 30 }, 'a');
  const b = addClip(main, { trackId: 'trk-video', start: 30, in: 0, out: 30 }, 'b');
  const branch = new Y.Doc();
  const base = readTimeline(main);
  setMeta(branch, { baseSnapshot: canonicalJson(base), branch: 'alt' });
  applyTimeline(branch, base);
  return { main, branch, a, b };
}

const pending = (main: Y.Doc, branch: Y.Doc) => diff(baseOf(readMeta(branch).baseSnapshot)!, readTimeline(main), readTimeline(branch));
const mergeAll = (main: Y.Doc, branch: Y.Doc, resolutions: Record<string, 'main' | 'branch'> = {}) =>
  applyMerge(baseOf(readMeta(branch).baseSnapshot)!, main, branch, 'alt', { changes: pending(main, branch).map((c) => c.id), resolutions });

describe('B1: merge base moves forward after a merge', () => {
  it('merging the same branch again shows nothing when nothing changed', () => {
    const { main, branch, a } = project();
    updateClip(branch, a, { start: 90 });
    expect(pending(main, branch)).toHaveLength(1);
    mergeAll(main, branch);
    expect(readTimeline(main).clips[a].start).toBe(90);
    expect(pending(main, branch)).toEqual([]);
  });

  it('a second merge shows only changes made after the first', () => {
    const { main, branch, a, b } = project();
    updateClip(branch, a, { start: 90 });
    mergeAll(main, branch);
    updateClip(branch, b, { opacity: 0.5 });
    const p = pending(main, branch);
    expect(p.map((c) => c.id)).toEqual(['clip:b']);
    expect(p[0].fields).toEqual(['opacity']);
  });

  it("main's own edits never look like branch changes (the reason the base isn't the merge result)", () => {
    const { main, branch, a } = project();
    addClip(main, { trackId: 'trk-titles', text: 'only on main', start: 0, in: 0, out: 30 }, 'm');
    updateClip(branch, a, { start: 90 });
    mergeAll(main, branch);
    updateClip(main, a, { opacity: 0.2 });
    expect(pending(main, branch)).toEqual([]);
    expect(readTimeline(main).clips.m).toBeDefined();
  });

  it('changes left out of a merge are offered again next time', () => {
    const { main, branch, a, b } = project();
    updateClip(branch, a, { start: 90 });
    deleteClips(branch, [b]);
    applyMerge(baseOf(readMeta(branch).baseSnapshot)!, main, branch, 'alt', { changes: ['clip:a'], resolutions: {} });
    expect(readTimeline(main).clips[b]).toBeDefined();
    expect(pending(main, branch).map((c) => c.id)).toEqual(['clip:b']);
  });

  it('a conflict decided for main is not re-offered', () => {
    const { main, branch, a } = project();
    updateClip(main, a, { start: 45 });
    updateClip(branch, a, { start: 60 });
    mergeAll(main, branch, { 'clip:a.start': 'main' });
    expect(readTimeline(main).clips[a].start).toBe(45);
    expect(pending(main, branch)).toEqual([]);
  });
});

describe('B2: attributing a field to its author', () => {
  it('names whoever last wrote the field', () => {
    const doc = new Y.Doc();
    initDoc(doc, {});
    registerAuthor(doc, 'Sam', '#fff');
    const id = addClip(doc, { trackId: 'trk-video', start: 0, in: 0, out: 30 });
    updateClip(doc, id, { start: 45 });
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    registerAuthor(other, 'Priya', '#000');
    updateClip(other, id, { opacity: 0.5 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(fieldAuthor(doc, id, 'start')).toBe('Sam');
    expect(fieldAuthor(doc, id, 'opacity')).toBe('Priya');
    expect(fieldAuthor(doc, id, 'nope')).toBeNull();
  });
});

describe('B4: versions', () => {
  it('saves, restores as one undoable step, and undo brings the edit back', () => {
    const doc = new Y.Doc();
    initDoc(doc, {});
    const { tracks, clips, media } = maps(doc);
    const undo = new Y.UndoManager([tracks, clips, media], { trackedOrigins: new Set([LOCAL]) });
    const id = addClip(doc, { trackId: 'trk-video', start: 0, in: 0, out: 30 });
    const v = saveVersion(doc, 'Rough cut', 'Sam');
    const saved = canonicalJson(readTimeline(doc));
    undo.stopCapturing();
    updateClip(doc, id, { start: 120 });
    addClip(doc, { trackId: 'trk-titles', text: 'later', start: 0, in: 0, out: 10 });
    const edited = canonicalJson(readTimeline(doc));

    expect(listVersions(doc).map((x) => x.name)).toEqual(['Rough cut']);
    expect(restoreVersion(doc, undo, v)).toBe(true);
    expect(canonicalJson(readTimeline(doc))).toBe(saved);
    undo.undo();
    expect(canonicalJson(readTimeline(doc))).toBe(edited);
  });

  it('versions sync to collaborators like any edit', () => {
    const a = new Y.Doc();
    initDoc(a, {});
    saveVersion(a, 'v1', 'Sam');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(listVersions(b)[0].name).toBe('v1');
  });
});
