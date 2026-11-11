/**
 * AudioWorklet that plays the mix from the shared ring buffer. Its read position comes from
 * the AudioContext clock (currentFrame − start), so audio and video share one clock; if the
 * writer falls behind, it outputs silence for that quantum instead of delaying.
 * Optionally reports beep onsets (for the A/V drift benchmark).
 */
interface Buffers {
  ctrl: SharedArrayBuffer;
  data: SharedArrayBuffer;
}

declare const currentFrame: number;
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const RING_FRAMES = 48000 * 4;
const WRITE = 0;
const READ = 1;
const SESSION = 2;
const START = 3;
const UNDERRUNS = 5;
const MEASURE = 6;

class KairoMixer extends AudioWorkletProcessor {
  private ctrl: Int32Array;
  private data: Float32Array;
  private quiet = 1e9;

  constructor(options: { processorOptions: { buffers: Buffers } }) {
    super();
    this.ctrl = new Int32Array(options.processorOptions.buffers.ctrl);
    this.data = new Float32Array(options.processorOptions.buffers.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    const n = L.length;
    if (Atomics.load(this.ctrl, SESSION) <= 0) {
      L.fill(0);
      R.fill(0);
      return true;
    }
    const k = currentFrame - Atomics.load(this.ctrl, START);
    const write = Atomics.load(this.ctrl, WRITE);
    const measure = Atomics.load(this.ctrl, MEASURE) === 1;
    let under = 0;
    for (let i = 0; i < n; i++) {
      const idx = k + i;
      if (idx < 0 || idx >= write) {
        L[i] = 0;
        R[i] = 0;
        if (idx >= 0) under++;
        continue;
      }
      const p = (idx % RING_FRAMES) * 2;
      L[i] = this.data[p];
      R[i] = this.data[p + 1];
      if (measure) {
        if (Math.abs(L[i]) > 0.05) {
          if (this.quiet > sampleRate * 0.25) this.port.postMessage({ onset: (currentFrame + i) / sampleRate, timelineFrame: idx });
          this.quiet = 0;
        } else this.quiet++;
      }
    }
    if (k >= 0) Atomics.store(this.ctrl, READ, k + n);
    if (under) Atomics.add(this.ctrl, UNDERRUNS, 1);
    return true;
  }
}

registerProcessor('kairo-mixer', KairoMixer);
