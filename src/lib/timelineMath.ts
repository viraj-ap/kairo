import type { Clip, Timeline } from '../model/schema';
import { clipEnd, clipKind, clipLength, maxOut } from '../model/schema';

/** Snap `frame` to the nearest target within `threshold` frames. */
export function snap(frame: number, targets: number[], threshold: number): { frame: number; snapped: number | null } {
  let best: number | null = null;
  for (const t of targets) {
    if (Math.abs(t - frame) <= threshold && (best === null || Math.abs(t - frame) < Math.abs(best - frame))) best = t;
  }
  return best === null ? { frame, snapped: null } : { frame: best, snapped: best };
}

/** Edges a dragged clip can snap to: playhead, 0, and every other clip's start/end. */
export function snapTargets(t: Timeline, exclude: Set<string>, playhead: number): number[] {
  const out = [0, playhead];
  for (const [id, c] of Object.entries(t.clips)) {
    if (exclude.has(id)) continue;
    out.push(c.start, clipEnd(c));
  }
  return out;
}

/**
 * Move a clip by `delta` frames, snapping either its start or its end, never before 0.
 * Returns the new start.
 */
export function moveStart(c: Clip, delta: number, targets: number[], threshold: number): { start: number; snapped: number | null } {
  const raw = Math.max(0, c.start + delta);
  const len = clipLength(c);
  const a = snap(raw, targets, threshold);
  const b = snap(raw + len, targets, threshold);
  const da = a.snapped === null ? Infinity : Math.abs(a.frame - raw);
  const db = b.snapped === null ? Infinity : Math.abs(b.frame - (raw + len));
  if (da === Infinity && db === Infinity) return { start: raw, snapped: null };
  if (da <= db) return { start: Math.max(0, a.frame), snapped: a.snapped };
  return { start: Math.max(0, b.frame - len), snapped: b.snapped };
}

/** Trim the left edge to timeline frame `at`, keeping the right edge fixed. */
export function trimLeft(t: Timeline, c: Clip, at: number): Pick<Clip, 'start' | 'in'> {
  const unbounded = clipKind(t, c) === 'text' || clipKind(t, c) === 'image';
  const minStart = unbounded ? 0 : Math.max(0, c.start - c.in);
  const start = Math.min(Math.max(at, minStart), clipEnd(c) - 1);
  const shift = start - c.start;
  return { start, in: unbounded ? c.in : c.in + shift };
}

/** Trim the right edge to timeline frame `at`, limited by the source length. */
export function trimRight(t: Timeline, c: Clip, at: number): Pick<Clip, 'out'> {
  const out = c.in + (at - c.start);
  return { out: Math.min(Math.max(out, c.in + 1), maxOut(t, c)) };
}

/** Which kind of track a clip may live on. */
export function trackKindFor(t: Timeline, c: Clip): 'video' | 'audio' {
  return clipKind(t, c) === 'audio' ? 'audio' : 'video';
}

/** Choose a ruler step (in seconds) so labels are at least `minPx` apart. */
export function rulerStep(pxPerFrame: number, fps: number, minPx = 72): number {
  const steps = [1 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * fps * pxPerFrame >= minPx) ?? 600;
}
