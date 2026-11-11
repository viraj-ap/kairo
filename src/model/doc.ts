import * as Y from 'yjs';
import { newId } from '../lib/ids';
import { canonicalJson, sha256 } from '../lib/hash';
import type { BranchInfo, Clip, MediaInfo, Meta, Timeline, Track, TrackKind } from './schema';
import type { Manifest } from '../media/manifest';
import type { VersionInfo } from './versions';
import { clipLength } from './schema';

/** Transaction origin for edits made by this client; the undo manager only tracks these. */
export const LOCAL = 'kairo-local';

export function maps(doc: Y.Doc) {
  return {
    meta: doc.getMap<unknown>('meta'),
    media: doc.getMap<MediaInfo>('media'),
    tracks: doc.getMap<Y.Map<unknown>>('tracks'),
    clips: doc.getMap<Y.Map<unknown>>('clips'),
    branches: doc.getMap<BranchInfo>('branches'),
    /** Transfer manifests (chunk hashes) per stored file key; see src/media/manifest.ts. */
    manifests: doc.getMap<Manifest>('manifests'),
    /** Who each Yjs client id belongs to, for "Sam moved 'Intro'…" in merge conflicts. */
    authors: doc.getMap<{ name: string; color: string }>('authors'),
    /** Named saved versions of the timeline (see src/model/versions.ts). */
    versions: doc.getMap<VersionInfo>('versions'),
  };
}

const plain = <T>(m: Y.Map<unknown>) => m.toJSON() as T;

export function readMeta(doc: Y.Doc): Meta {
  const m = maps(doc).meta.toJSON() as Partial<Meta>;
  return { projectId: '', name: 'Untitled project', branch: 'main', createdAt: 0, fps: 30, width: 1920, height: 1080, ...m };
}

export function readTimeline(doc: Y.Doc): Timeline {
  const { media, tracks, clips } = maps(doc);
  const t: Timeline = { fps: readMeta(doc).fps, media: {}, tracks: {}, clips: {} };
  media.forEach((v, k) => (t.media[k] = v));
  tracks.forEach((v, k) => (t.tracks[k] = plain<Track>(v)));
  clips.forEach((v, k) => (t.clips[k] = plain<Clip>(v)));
  return t;
}

export function readBranches(doc: Y.Doc): Record<string, BranchInfo> {
  return maps(doc).branches.toJSON() as Record<string, BranchInfo>;
}

/** SHA-256 of the canonical timeline JSON — equal on every converged client. */
export const timelineHash = (t: Timeline) => sha256(canonicalJson(t));

function toYMap(obj: object): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) m.set(k, v);
  return m;
}

/** Apply a patch field by field, so concurrent edits to other fields survive (per-field LWW). */
function patchYMap(m: Y.Map<unknown>, patch: object) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      if (m.has(k)) m.delete(k);
    } else if (canonicalJson(m.get(k)) !== canonicalJson(v)) {
      m.set(k, v);
    }
  }
}

export const DEFAULT_TRACKS: Record<string, Track> = {
  'trk-titles': { kind: 'video', name: 'Titles', order: 0 },
  'trk-video': { kind: 'video', name: 'Video', order: 1 },
  'trk-audio': { kind: 'audio', name: 'Audio', order: 2 },
};

/** Fill an empty room. Default ids are fixed so two clients initializing at once converge. */
export function initDoc(doc: Y.Doc, meta: Partial<Meta>) {
  const { meta: m, tracks } = maps(doc);
  doc.transact(() => {
    if (!m.has('createdAt')) {
      const full: Meta = { projectId: '', name: 'Untitled project', branch: 'main', createdAt: Date.now(), fps: 30, width: 1920, height: 1080, ...meta };
      for (const [k, v] of Object.entries(full)) if (v !== undefined && !m.has(k)) m.set(k, v);
    }
    if (tracks.size === 0) for (const [id, t] of Object.entries(DEFAULT_TRACKS)) tracks.set(id, toYMap(t));
  });
}

export function setMeta(doc: Y.Doc, patch: Partial<Meta>) {
  doc.transact(() => patchYMap(maps(doc).meta as Y.Map<unknown>, patch), LOCAL);
}

export function addMedia(doc: Y.Doc, hash: string, info: MediaInfo) {
  const { media } = maps(doc);
  if (!media.has(hash)) doc.transact(() => media.set(hash, info), LOCAL);
}

export function addClip(doc: Y.Doc, clip: Clip, id = newId('c')): string {
  doc.transact(() => maps(doc).clips.set(id, toYMap(clip)), LOCAL);
  return id;
}

export function updateClips(doc: Y.Doc, patches: Record<string, Partial<Clip>>) {
  const { clips } = maps(doc);
  doc.transact(() => {
    for (const [id, patch] of Object.entries(patches)) {
      const m = clips.get(id);
      if (m) patchYMap(m, patch);
    }
  }, LOCAL);
}

export const updateClip = (doc: Y.Doc, id: string, patch: Partial<Clip>) => updateClips(doc, { [id]: patch });

export function deleteClips(doc: Y.Doc, ids: string[]) {
  const { clips } = maps(doc);
  doc.transact(() => ids.forEach((id) => clips.delete(id)), LOCAL);
}

/** Split at a timeline frame; returns the id of the right half. */
export function splitClip(doc: Y.Doc, id: string, frame: number): string | null {
  const m = maps(doc).clips.get(id);
  if (!m) return null;
  const c = plain<Clip>(m);
  const cut = frame - c.start;
  if (cut <= 0 || cut >= clipLength(c)) return null;
  const rightId = newId('c');
  doc.transact(() => {
    m.set('out', c.in + cut);
    const right: Clip = { ...c, start: frame, in: c.in + cut, transitionIn: undefined };
    maps(doc).clips.set(rightId, toYMap(right));
  }, LOCAL);
  return rightId;
}

export function addTrack(doc: Y.Doc, kind: TrackKind): string {
  const { tracks } = maps(doc);
  const all = [...tracks.values()].map((t) => plain<Track>(t));
  const id = newId('t');
  const count = all.filter((t) => t.kind === kind).length + 1;
  // Video tracks go above existing ones, audio tracks below.
  const order = kind === 'video' ? Math.min(0, ...all.map((t) => t.order)) - 1 : Math.max(0, ...all.map((t) => t.order)) + 1;
  doc.transact(() => tracks.set(id, toYMap({ kind, name: kind === 'video' ? `Video ${count}` : `Audio ${count}`, order })), LOCAL);
  return id;
}

export function updateTrack(doc: Y.Doc, id: string, patch: Partial<Track>) {
  const m = maps(doc).tracks.get(id);
  if (m) doc.transact(() => patchYMap(m, patch), LOCAL);
}

export function deleteTrack(doc: Y.Doc, id: string) {
  const { tracks, clips } = maps(doc);
  doc.transact(() => {
    tracks.delete(id);
    clips.forEach((c, cid) => c.get('trackId') === id && clips.delete(cid));
  }, LOCAL);
}

export function registerBranch(doc: Y.Doc, slug: string, info: BranchInfo) {
  doc.transact(() => maps(doc).branches.set(slug, info), LOCAL);
}

export function markBranch(doc: Y.Doc, slug: string, patch: Partial<BranchInfo>) {
  const { branches } = maps(doc);
  const cur = branches.get(slug);
  if (cur) doc.transact(() => branches.set(slug, { ...cur, ...patch }), LOCAL);
}

/** Make the doc's timeline equal `target` with the fewest field writes, as one transaction. */
export function applyTimeline(doc: Y.Doc, target: Timeline, origin: unknown = LOCAL) {
  const { media, tracks, clips } = maps(doc);
  doc.transact(() => {
    for (const [h, info] of Object.entries(target.media)) if (!media.has(h)) media.set(h, info);
    for (const [map, want] of [
      [tracks, target.tracks],
      [clips, target.clips],
    ] as [Y.Map<Y.Map<unknown>>, Record<string, object>][]) {
      for (const k of [...map.keys()]) if (!(k in want)) map.delete(k);
      for (const [k, v] of Object.entries(want)) {
        const cur = map.get(k);
        if (!cur) {
          map.set(k, toYMap(v));
          continue;
        }
        for (const f of [...cur.keys()]) if (!(f in v)) cur.delete(f);
        patchYMap(cur, v);
      }
    }
  }, origin);
}

export function readManifests(doc: Y.Doc): Record<string, Manifest> {
  return maps(doc).manifests.toJSON() as Record<string, Manifest>;
}

/** Publish a manifest unless an identical one is already there (first publisher wins). */
export function publishManifest(doc: Y.Doc, m: Manifest) {
  const { manifests } = maps(doc);
  if (manifests.has(m.key)) return;
  doc.transact(() => manifests.set(m.key, m));
}

/** Record which person this client id is, so edits can be attributed later. */
export function registerAuthor(doc: Y.Doc, name: string, color: string) {
  const { authors } = maps(doc);
  const cur = authors.get(String(doc.clientID));
  if (cur?.name !== name || cur?.color !== color) doc.transact(() => authors.set(String(doc.clientID), { name, color }));
}

/**
 * Who last wrote `field` of a clip: the Yjs item holding the current value records the
 * client id that wrote it, and the authors map turns that into a name.
 */
export function fieldAuthor(doc: Y.Doc, clipId: string, field: string): string | null {
  const clip = maps(doc).clips.get(clipId) as unknown as { _map?: Map<string, { id: { client: number } }> } | undefined;
  const client = clip?._map?.get(field)?.id.client;
  if (client === undefined) return null;
  return maps(doc).authors.get(String(client))?.name ?? null;
}
