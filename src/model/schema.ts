/** Timeline data model. All times are integer frames at the project fps. */

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaInfo {
  kind: MediaKind;
  name: string;
  durationFrames: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec?: string;
  size?: number;
  /** Clockwise display rotation from the file's matrix (phones record portrait this way). width/height are display size. */
  rotation?: 0 | 90 | 180 | 270;
  /** Frame timestamps are irregular (variable frame rate, typical of phones). */
  vfr?: boolean;
  /** Public URL the bytes can also be fetched from (demo media). */
  src?: string;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  kind: TrackKind;
  name: string;
  /** Lower order is listed first and composited on top. */
  order: number;
  muted?: boolean;
  locked?: boolean;
  hidden?: boolean;
}

export type TransitionKind = 'fade' | 'wipe' | 'slide' | 'zoom';
export type EffectKind = 'none' | 'grayscale' | 'sepia' | 'invert' | 'duotone' | 'vignette' | 'posterize' | 'scanlines';

export interface Clip {
  trackId: string;
  mediaHash?: string;
  text?: string;
  /** Timeline frame the clip starts at. */
  start: number;
  /** Source in/out points (exclusive out), in frames. Text clips use in=0. */
  in: number;
  out: number;
  opacity?: number;
  /** Offsets as a fraction of the frame size; 0,0 is centered. */
  x?: number;
  y?: number;
  scale?: number;
  volume?: number;
  muted?: boolean;
  transitionIn?: { kind: TransitionKind; duration: number };
  effect?: EffectKind;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  background?: string;
}

export interface Meta {
  projectId: string;
  name: string;
  branch: string;
  parent?: string;
  /** Canonical JSON of the parent timeline when the branch was cut. */
  baseSnapshot?: string;
  createdAt: number;
  fps: number;
  width: number;
  height: number;
}

export interface BranchInfo {
  name: string;
  createdAt: number;
  createdBy: string;
  mergedAt?: number;
}

export interface Timeline {
  fps: number;
  media: Record<string, MediaInfo>;
  tracks: Record<string, Track>;
  clips: Record<string, Clip>;
}

export const clipLength = (c: Pick<Clip, 'in' | 'out'>) => Math.max(0, c.out - c.in);
export const clipEnd = (c: Clip) => c.start + clipLength(c);

export function timelineDuration(t: Timeline): number {
  let d = 0;
  for (const c of Object.values(t.clips)) d = Math.max(d, clipEnd(c));
  return d;
}

export function sortedTracks(t: Timeline): [string, Track][] {
  return Object.entries(t.tracks).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
}

export function clipKind(t: Timeline, c: Clip): 'video' | 'audio' | 'image' | 'text' {
  if (typeof c.text === 'string') return 'text';
  return (c.mediaHash && t.media[c.mediaHash]?.kind) || 'video';
}

/** How long a clip can grow before running out of source. Text and images are unbounded. */
export function maxOut(t: Timeline, c: Clip): number {
  const kind = clipKind(t, c);
  if (kind === 'text' || kind === 'image') return Number.MAX_SAFE_INTEGER;
  return t.media[c.mediaHash!]?.durationFrames ?? c.out;
}

export const ASPECTS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
} as const;
export type Aspect = keyof typeof ASPECTS;

export function aspectOf(w: number, h: number): Aspect {
  const hit = (Object.keys(ASPECTS) as Aspect[]).find((a) => ASPECTS[a].width === w && ASPECTS[a].height === h);
  return hit ?? '16:9';
}
