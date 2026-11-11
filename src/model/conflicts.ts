/**
 * Merge conflicts in editors' words: "You moved 'Intro' to 0:45 · Sam moved it to 1:00".
 * Pure functions, so they're unit-tested without a browser.
 */
import type { Conflict } from '../engine';

export interface ConflictWords {
  /** Clip display name ("Intro", the text of a title, or the file name). */
  name: string;
  fps: number;
  trackName(id: string): string;
  /** Who made each side's change ("You", "Sam", or a fallback like "Someone on main"). */
  mainAuthor: string;
  branchAuthor: string;
}

/** 45 → "0:01.5", 1800 → "1:00": minutes:seconds, tenths only when needed. */
export function shortTime(frames: number, fps: number): string {
  const total = frames / fps;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const whole = Math.abs(s - Math.round(s)) < 1e-6;
  const sec = whole ? String(Math.round(s)).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

const pct = (v: unknown) => `${Math.round(Number(v) * 100)}%`;

/** What setting `field` to `value` did, as a verb phrase. `it` replaces the clip name on the second mention. */
export function phrase(field: string, value: unknown, w: ConflictWords, it: boolean): string {
  const n = it ? 'it' : `'${w.name}'`;
  const gone = value === null || value === undefined;
  switch (field) {
    case 'start':
      return `moved ${n} to ${shortTime(Number(value), w.fps)}`;
    case 'trackId':
      return `moved ${n} to track ${w.trackName(String(value))}`;
    case 'in':
      return `trimmed the head of ${n} to ${shortTime(Number(value), w.fps)} into the source`;
    case 'out':
      return `trimmed the tail of ${n} to end ${shortTime(Number(value), w.fps)} into the source`;
    case 'opacity':
      return `set ${n} to ${pct(gone ? 1 : value)} opacity`;
    case 'scale':
      return `scaled ${n} to ${pct(gone ? 1 : value)}`;
    case 'x':
    case 'y':
      return `repositioned ${n}`;
    case 'volume':
      return `set ${n} to ${pct(gone ? 1 : value)} volume`;
    case 'muted':
      return `${value ? 'muted' : 'unmuted'} ${n}`;
    case 'text':
      return `changed the text of ${n} to “${String(value)}”`;
    case 'fontSize':
      return `set the text size of ${n} to ${value}px`;
    case 'color':
      return `changed the color of ${n} to ${value}`;
    case 'effect':
      return gone ? `removed the effect from ${n}` : `applied the ${value} effect to ${n}`;
    case 'transitionIn':
      return gone ? `removed the transition from ${n}` : `gave ${n} a ${(value as { kind: string }).kind} transition`;
    case 'brightness':
    case 'contrast':
    case 'saturation':
      return gone ? `reset the ${field} of ${n}` : `set the ${field} of ${n} to ${Number(value).toFixed(2)}`;
    default:
      return gone ? `removed ${field} from ${n}` : `changed ${field} of ${n}`;
  }
}

export interface DescribedConflict {
  /** What happened on main and on the branch, each as a full sentence. */
  main: string;
  branch: string;
  /** One line for the merge list: branch side first, then main. */
  line: string;
}

export function describeConflict(c: Pick<Conflict, 'field' | 'main' | 'branch'>, w: ConflictWords): DescribedConflict {
  if (c.field === '*') {
    // Delete vs edit: one side removed the clip, the other changed it.
    const main = c.main === null ? `${w.mainAuthor} deleted '${w.name}'` : `${w.mainAuthor} edited '${w.name}'`;
    const branch = c.branch === null ? `${w.branchAuthor} deleted '${w.name}'` : `${w.branchAuthor} edited '${w.name}'`;
    const second = c.main === null ? `${w.mainAuthor} deleted it` : `${w.mainAuthor} edited it`;
    return { main, branch, line: `${branch} · ${second}` };
  }
  const main = `${w.mainAuthor} ${phrase(c.field, c.main, w, false)}`;
  const branch = `${w.branchAuthor} ${phrase(c.field, c.branch, w, false)}`;
  return { main, branch, line: `${branch} · ${w.mainAuthor} ${phrase(c.field, c.main, w, true)}` };
}

/** "Shifted 12 clips +2.0 s on V1" */
export function describeShift(count: number, deltaFrames: number, fps: number, tracks: string[]): string {
  const s = deltaFrames / fps;
  const sign = s >= 0 ? '+' : '−';
  return `Shifted ${count} clips ${sign}${Math.abs(s).toFixed(1)} s on ${tracks.join(', ')}`;
}
