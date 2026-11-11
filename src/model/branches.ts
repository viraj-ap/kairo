import { canonicalJson } from '../lib/hash';
import { slugifyBranch } from '../lib/ids';
import { openRoom, settle } from '../sync/room';
import type * as Y from 'yjs';
import { merge, type Selection } from '../engine';
import { applyTimeline, maps, markBranch, readMeta, readTimeline, registerBranch, setMeta } from './doc';
import type { Timeline } from './schema';
import type { EditorSession } from './session';

/**
 * Snapshot main into a new room `kairo:{code}:{branch}` and remember the snapshot as
 * the merge base. The branch is then a fully live room of its own.
 */
export async function createBranch(session: EditorSession, name: string): Promise<string> {
  const slug = slugifyBranch(name);
  if (slug === 'main' || maps(session.doc).branches.has(slug)) throw new Error(`A branch called "${slug}" already exists`);
  const base = readTimeline(session.doc);
  const meta = readMeta(session.doc);
  const conn = openRoom(session.code, slug, session.projectKey);
  try {
    await conn.ready;
    if (!maps(conn.doc).meta.has('createdAt')) {
      setMeta(conn.doc, {
        ...meta,
        branch: slug,
        parent: session.branch,
        baseSnapshot: canonicalJson(base),
        createdAt: Date.now(),
      });
      applyTimeline(conn.doc, base);
    }
    registerBranch(session.doc, slug, { name: name.trim() || slug, createdAt: Date.now(), createdBy: session.identity.name });
    await settle(600);
  } finally {
    conn.close();
  }
  return slug;
}

export function baseOf(branchMetaSnapshot: string | undefined): Timeline | null {
  if (!branchMetaSnapshot) return null;
  try {
    return JSON.parse(branchMetaSnapshot) as Timeline;
  } catch {
    return null;
  }
}

/**
 * Apply a reviewed merge of `slug` into main as one transaction, then move the branch's
 * merge base forward so merging the same branch again shows only what's new.
 *
 * The new base is "what main has absorbed from this branch": the old base plus every change
 * that was selected (conflicts count as decided, whichever side won). It is deliberately
 * not the merge result: that would contain main-only edits the branch never had, and they
 * would then look like the branch deleting or reverting them. Unselected changes stay
 * at their old base value, so they are offered again next time.
 */
export function applyMerge(base: Timeline, mainDoc: Y.Doc, branchDoc: Y.Doc, slug: string, sel: Selection) {
  const branch = readTimeline(branchDoc);
  // Re-merge against the live docs so edits made on main during review aren't reverted.
  const fresh = merge(base, readTimeline(mainDoc), branch, sel);
  applyTimeline(mainDoc, fresh.result);
  markBranch(mainDoc, slug, { mergedAt: Date.now() });
  const absorbed = merge(base, base, branch, { changes: sel.changes, resolutions: {} }).result;
  setMeta(branchDoc, { baseSnapshot: canonicalJson(absorbed) });
  return fresh;
}
