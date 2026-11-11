/** Main-thread handle to the decoder worker. */

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (f: VideoFrame | null) => void>();
const statsPending = new Map<number, (s: { cached: number; decoders: number }) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ t: 'frame'; id: number; frame: VideoFrame | null } | { t: 'stats'; id: number; cached: number; decoders: number }>) => {
      if (e.data.t === 'stats') {
        statsPending.get(e.data.id)?.({ cached: e.data.cached, decoders: e.data.decoders });
        statsPending.delete(e.data.id);
        return;
      }
      const resolve = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (resolve) resolve(e.data.frame);
      else e.data.frame?.close();
    };
  }
  return worker;
}

/**
 * Decoded frame of `hash` at `time` seconds, for the decoder slot `key` (one per clip).
 * The caller owns the frame and must close() it.
 */
export function getFrame(hash: string, key: string, time: number): Promise<VideoFrame | null> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ t: 'frame', id, hash, key, time });
  });
}

/** Warm up the decoder for a clip that starts soon (no frame is returned). */
export function prerollFrame(hash: string, key: string, time: number) {
  getWorker().postMessage({ t: 'preroll', hash, key, time });
}

export function releaseDecoder(key: string) {
  worker?.postMessage({ t: 'release', key });
}

/** Shrink or grow the decoded-frame cache (frames are GPU memory). */
export function setFrameCacheCap(frames: number) {
  getWorker().postMessage({ t: 'cap', frames });
}

/** Close every decoded frame and decoder in the worker (cold-seek measurements). */
export function clearDecoderCache() {
  getWorker().postMessage({ t: 'clear' });
}

/** Decoded frames held by the worker cache, and live decoders. */
export function decoderStats(): Promise<{ cached: number; decoders: number }> {
  const id = nextId++;
  return new Promise((resolve) => {
    statsPending.set(id, resolve);
    getWorker().postMessage({ t: 'stats', id });
  });
}

/** The stored file for `hash` changed (proxy chunks arrived, original completed): reload it. */
export function invalidateMedia(hash: string) {
  worker?.postMessage({ t: 'invalidate', hash });
}

// Test/benchmark hook: decode frames directly (window.__kairoDecoder.getFrame).
(globalThis as unknown as { __kairoDecoder?: unknown }).__kairoDecoder = { getFrame, clearDecoderCache };
