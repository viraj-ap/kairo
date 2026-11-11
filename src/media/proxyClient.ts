/** Main-thread handle to the proxy worker. One proxy is generated at a time. */

export interface ProxyResult {
  width: number;
  height: number;
  frames: number;
  bytes: number;
  ms: number;
}

let worker: Worker | null = null;
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();

/** Videos taller than this get a 540p proxy; smaller ones are already proxy-sized. */
export const PROXY_THRESHOLD_HEIGHT = 540;

export function generateProxy(hash: string, onProgress?: (p: number) => void): Promise<ProxyResult> {
  const run = () =>
    new Promise<ProxyResult>((resolve, reject) => {
      worker ??= new Worker(new URL('./proxy.worker.ts', import.meta.url), { type: 'module' });
      const id = nextId++;
      const w = worker;
      const onMsg = (e: MessageEvent) => {
        if (e.data.id !== id) return;
        if (e.data.progress !== undefined) onProgress?.(e.data.progress);
        if (e.data.done || e.data.error) {
          w.removeEventListener('message', onMsg);
          if (e.data.done) resolve(e.data.done);
          else reject(new Error(e.data.error));
        }
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ id, hash });
    });
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
