/**
 * Main-thread side of streaming audio: the AudioWorklet node, the shared ring buffer and the
 * audio worker. Playback, waveform peaks and export all go through here; the old
 * whole-file decode (decodeAudioData) is only a fallback for formats AudioDecoder can't
 * stream and for pages that aren't cross-origin isolated (no SharedArrayBuffer).
 */
import workletUrl from './mixer.worklet.ts?worker&url';
import type { AudioSegment } from '../../engine';
import { getAudioBuffer } from '../audio';
import { createRing, CTRL, type Ring } from './ring';

const MEASURE = 6;

export function streamingSupported(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && 'AudioDecoder' in globalThis;
}

/** A worker with the main-thread fallback wired: it asks us to decode formats it can't stream. */
export function spawnAudioWorker(): Worker {
  const w = new Worker(new URL('./audio.worker.ts', import.meta.url), { type: 'module' });
  w.addEventListener('message', async (e) => {
    if (e.data?.t !== 'need-pcm') return;
    const buf = await getAudioBuffer(e.data.hash);
    const pcm = buf && {
      t0: 0,
      sampleRate: buf.sampleRate,
      channels: Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice()),
    };
    w.postMessage({ t: 'pcm', hash: e.data.hash, pcm });
  });
  return w;
}

let shared: Worker | null = null;
export const audioWorker = () => (shared ??= spawnAudioWorker());

let nextId = 1;
function call<T>(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise((resolve) => {
    const on = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', on);
      resolve(e.data as T);
    };
    w.addEventListener('message', on);
    w.postMessage({ ...msg, id }, transfer);
  });
}

/** Waveform peaks (max |sample| per 10 ms), decoded a batch at a time in the worker. */
export async function streamedPeaks(hash: string): Promise<Float32Array | null> {
  return (await call<{ peaks: Float32Array | null }>(audioWorker(), { t: 'peaks', hash })).peaks;
}

/** Media bytes changed (proxy → original): reopen the source. */
export function invalidateAudio(hash: string) {
  shared?.postMessage({ t: 'invalidate', hash });
}

export class AudioOut {
  private ring: Ring | null = null;
  private buffers: { ctrl: SharedArrayBuffer; data: SharedArrayBuffer } | null = null;
  private ready: Promise<void> | null = null;
  private session = 0;
  /** Beep onsets heard (A/V drift measurement): AudioContext time of each. */
  onOnset: ((ctxTime: number) => void) | null = null;

  constructor(
    private ac: AudioContext,
    private dest: AudioNode,
  ) {}

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.ac.audioWorklet.addModule(workletUrl);
      const { ring, buffers } = createRing();
      this.ring = ring;
      this.buffers = buffers;
      const node = new AudioWorkletNode(this.ac, 'kairo-mixer', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { buffers } });
      node.port.onmessage = (e) => this.onOnset?.(e.data.onset);
      node.connect(this.dest);
    })();
    return this.ready;
  }

  /** Play `segments` from timeline frame `from`, the first sample sounding at context time `at`. */
  async start(segments: AudioSegment[], fps: number, from: number, at: number) {
    await this.init();
    const c = this.ring!.ctrl;
    Atomics.store(c, CTRL.SESSION, 0);
    Atomics.store(c, CTRL.WRITE, 0);
    Atomics.store(c, CTRL.READ, 0);
    Atomics.store(c, CTRL.UNDERRUNS, 0);
    Atomics.store(c, CTRL.START_FRAME_LO, Math.round(at * this.ac.sampleRate));
    const s = ++this.session;
    Atomics.store(c, CTRL.SESSION, s);
    audioWorker().postMessage({ t: 'play', session: s, segments, fps, from: from / fps, sampleRate: this.ac.sampleRate, buffers: this.buffers });
  }

  stop() {
    if (this.ring) Atomics.store(this.ring.ctrl, CTRL.SESSION, 0);
    shared?.postMessage({ t: 'stop' });
  }

  /** Render quanta that hit an empty buffer since start (should stay 0). */
  underruns(): number {
    return this.ring ? Atomics.load(this.ring.ctrl, CTRL.UNDERRUNS) : 0;
  }

  setMeasure(on: boolean) {
    void this.init().then(() => Atomics.store(this.ring!.ctrl, MEASURE, on ? 1 : 0));
  }
}

/** Stream the timeline's mix for export, `chunk` frames at a time, without decoding whole files. */
export async function renderMix(segments: AudioSegment[], fps: number, sampleRate: number, totalFrames: number, onChunk: (L: Float32Array, R: Float32Array, at: number) => void, chunk = 48000) {
  const w = spawnAudioWorker();
  const job = nextId++;
  try {
    for (let at = 0; at < totalFrames; at += chunk) {
      const n = Math.min(chunk, totalFrames - at);
      const r = await call<{ L: Float32Array; R: Float32Array }>(w, { t: 'render', job, segments, fps, sampleRate, from: at / sampleRate, frames: n });
      onChunk(r.L, r.R, at);
    }
  } finally {
    w.terminate();
  }
}
