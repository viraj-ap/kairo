/* tslint:disable */
/* eslint-disable */

export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    audioPlan(): string;
    duration(): bigint;
    constructor();
    renderPlan(frame: bigint, lookahead: bigint): string;
    setTimeline(json: string): void;
}

export function diff(base: string, main: string, branch: string): string;

/**
 * Diff plus groups of related changes (ripples, multi-select moves).
 */
export function diffGrouped(base: string, main: string, branch: string): string;

export function merge(base: string, main: string, branch: string, selection: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly diff: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly diffGrouped: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly engine_audioPlan: (a: number) => [number, number];
    readonly engine_duration: (a: number) => bigint;
    readonly engine_new: () => number;
    readonly engine_renderPlan: (a: number, b: bigint, c: bigint) => [number, number];
    readonly engine_setTimeline: (a: number, b: number, c: number) => [number, number];
    readonly merge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
