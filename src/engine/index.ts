import init, { Engine, diff as wasmDiff, diffGrouped as wasmDiffGrouped, merge as wasmMerge } from './pkg/kairo_core';
import wasmUrl from './pkg/kairo_core_bg.wasm?url';
import type { Timeline } from '../model/schema';
import { canonicalJson } from '../lib/hash';

export interface Layer {
  clipId: string;
  kind: 'video' | 'image' | 'text';
  mediaHash: string | null;
  sourceFrame: number;
  sourceTime: number;
  opacity: number;
  x: number;
  y: number;
  scale: number;
  reveal: number;
  /** Clockwise display rotation of the source media (0/90/180/270). */
  rotation: number;
  props: {
    text?: string;
    fontSize?: number;
    fontWeight?: number;
    color?: string;
    background?: string;
    effect?: string;
    brightness?: number;
    contrast?: number;
    saturation?: number;
  };
}

export interface RenderPlan {
  frame: number;
  layers: Layer[];
  preroll: { clipId: string; mediaHash: string; sourceTime: number }[];
}

export interface AudioSegment {
  clipId: string;
  mediaHash: string;
  start: number;
  in: number;
  out: number;
  gain: number;
}

export interface Change {
  id: string;
  entity: 'clip' | 'track';
  key: string;
  kind: 'added' | 'removed' | 'moved' | 'trimmed' | 'props';
  fields: string[];
  conflict: boolean;
}

/** Several changes that are one edit (a ripple or multi-select move). */
export interface ChangeGroup {
  id: string;
  kind: 'shift';
  delta: number;
  members: string[];
  tracks: string[];
}

export interface Conflict {
  id: string;
  changeId: string;
  field: string;
  base: unknown;
  main: unknown;
  branch: unknown;
  resolution: 'main' | 'branch' | null;
}

export interface Selection {
  changes: string[];
  resolutions: Record<string, 'main' | 'branch'>;
}

let ready: Promise<void> | null = null;

/** Load kairo_core_bg.wasm once. */
export function loadEngine(): Promise<void> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => undefined);
  return ready;
}

/**
 * Timeline engine bound to one timeline snapshot. Call `load` after every change.
 * The WASM instance is created on first load, so construct freely before `loadEngine` resolves.
 */
export class TimelineEngine {
  private e: Engine | null = null;
  private json = '';

  load(t: Timeline) {
    const json = canonicalJson(t);
    if (json === this.json && this.e) return;
    this.e ??= new Engine();
    this.json = json;
    this.e.setTimeline(json);
  }

  duration(): number {
    return this.e ? Number(this.e.duration()) : 0;
  }

  renderPlan(frame: number, lookahead = 0): RenderPlan {
    if (!this.e) return { frame, layers: [], preroll: [] };
    return JSON.parse(this.e.renderPlan(BigInt(frame), BigInt(lookahead)));
  }

  audioPlan(): AudioSegment[] {
    return this.e ? JSON.parse(this.e.audioPlan()) : [];
  }
}

export function diff(base: Timeline, main: Timeline, branch: Timeline): Change[] {
  return JSON.parse(wasmDiff(canonicalJson(base), canonicalJson(main), canonicalJson(branch)));
}

export function diffGrouped(base: Timeline, main: Timeline, branch: Timeline): { changes: Change[]; groups: ChangeGroup[] } {
  return JSON.parse(wasmDiffGrouped(canonicalJson(base), canonicalJson(main), canonicalJson(branch)));
}

export function merge(base: Timeline, main: Timeline, branch: Timeline, sel: Selection): { result: Timeline; conflicts: Conflict[] } {
  return JSON.parse(wasmMerge(canonicalJson(base), canonicalJson(main), canonicalJson(branch), JSON.stringify(sel)));
}
