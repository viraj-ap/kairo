/**
 * Light version history: named snapshots of the timeline, stored in the room doc (so they're
 * end-to-end encrypted like everything else). Restoring applies the snapshot as one local
 * transaction, which the undo manager can undo.
 */
import type * as Y from 'yjs';
import { canonicalJson } from '../lib/hash';
import { newId } from '../lib/ids';
import { LOCAL, applyTimeline, maps, readTimeline } from './doc';
import type { Timeline } from './schema';

export interface VersionInfo {
  name: string;
  createdAt: number;
  createdBy: string;
  /** Canonical JSON of the timeline at save time. */
  snapshot: string;
}

export function saveVersion(doc: Y.Doc, name: string, createdBy: string): string {
  const id = newId('v');
  const v: VersionInfo = { name: name.trim() || 'Untitled version', createdAt: Date.now(), createdBy, snapshot: canonicalJson(readTimeline(doc)) };
  doc.transact(() => maps(doc).versions.set(id, v));
  return id;
}

export function listVersions(doc: Y.Doc): (VersionInfo & { id: string })[] {
  return Object.entries(maps(doc).versions.toJSON() as Record<string, VersionInfo>)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function versionTimeline(doc: Y.Doc, id: string): Timeline | null {
  const v = maps(doc).versions.get(id);
  return v ? (JSON.parse(v.snapshot) as Timeline) : null;
}

/** Make the timeline equal the saved version, as a single undoable step. */
export function restoreVersion(doc: Y.Doc, undo: Y.UndoManager | null, id: string): boolean {
  const t = versionTimeline(doc, id);
  if (!t) return false;
  undo?.stopCapturing();
  applyTimeline(doc, t, LOCAL);
  undo?.stopCapturing();
  return true;
}
