/// <reference lib="webworker" />
/**
 * Audio worker: owns streaming sources and the mixer. During playback it keeps the shared
 * ring buffer ~0.75 s ahead of the AudioWorklet's read position; it also computes waveform
 * peaks and renders mix chunks for export, all without decoding whole files.
 */
import type { AudioSegment } from '../../engine';
import { getMediaFile } from '../opfs';
import { proxyKey } from '../manifest';
import { attachRing, CTRL, RING_FRAMES, type Ring } from './ring';
import { Mixer, streamPeaks } from './mixer';
import { AudioSource, openAudioSource, type Pcm } from './source';

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Fully decoded audio handed over by the main thread for formats AudioDecoder can't stream. */
class MemorySource extends AudioSource {
  constructor(private pcm: Pcm) {
    super();
  }
  get sampleRate() {
    return this.pcm.sampleRate;
  }
  get duration() {
    return this.pcm.channels[0].length / this.pcm.sampleRate;
  }
  async read(from: number, to: number): Promise<Pcm | null> {
    const a = Math.max(0, Math.floor(from * this.sampleRate));
    const b = Math.min(this.pcm.channels[0].length, Math.ceil(to * this.sampleRate));
    if (b <= a) return null;
    return { t0: a / this.sampleRate, sampleRate: this.sampleRate, channels: this.pcm.channels.map((c) => c.subarray(a, b)) };
  }
}

const sources = new Map<string, Promise<AudioSource | null>>();
const fallbacks = new Map<string, (p: Pcm | null) => void>();

function sourceFor(hash: string): Promise<AudioSource | null> {
  let p = sources.get(hash);
  if (!p) {
    p = (async () => {
      const blob = (await getMediaFile(hash)) ?? (await getMediaFile(proxyKey(hash)));
      if (!blob) return null;
      const s = await openAudioSource(blob);
      if (s) return s;
      // Not streamable here (e.g. MP3): ask the main thread to decode it once.
      const pcm = await new Promise<Pcm | null>((resolve) => {
        fallbacks.set(hash, resolve);
        scope.postMessage({ t: 'need-pcm', hash });
      });
      return pcm ? new MemorySource(pcm) : null;
    })();
    p.then((s) => s || sources.delete(hash));
    sources.set(hash, p);
  }
  return p;
}

// ---- playback producer ------------------------------------------------------------

const BLOCK = 2048;
let session = 0;

async function play(s: number, segments: AudioSegment[], fps: number, from: number, sampleRate: number, ring: Ring) {
  const mixer = new Mixer(segments, fps, sampleRate, sourceFor);
  const lead = Math.round(sampleRate * 0.75);
  let written = 0;
  Atomics.store(ring.ctrl, CTRL.WRITE, 0);
  while (session === s) {
    const read = Atomics.load(ring.ctrl, CTRL.READ);
    if (written < read) written = read; // fell behind: skip ahead, never delay
    if (written - read < lead && written - read < RING_FRAMES - BLOCK) {
      const [L, R] = await mixer.render(from + written / sampleRate, BLOCK);
      if (session !== s) return;
      for (let i = 0; i < BLOCK; i++) {
        const k = ((written + i) % RING_FRAMES) * 2;
        ring.data[k] = L[i];
        ring.data[k + 1] = R[i];
      }
      written += BLOCK;
      Atomics.store(ring.ctrl, CTRL.WRITE, written);
    } else {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.t === 'play') {
    session = m.session;
    void play(m.session, m.segments, m.fps, m.from, m.sampleRate, attachRing(m.buffers));
  } else if (m.t === 'stop') {
    session = -1;
  } else if (m.t === 'invalidate') {
    sources.get(m.hash)?.then((s) => s?.close());
    sources.delete(m.hash);
  } else if (m.t === 'pcm') {
    fallbacks.get(m.hash)?.(m.pcm);
    fallbacks.delete(m.hash);
  } else if (m.t === 'peaks') {
    const src = await sourceFor(m.hash);
    const peaks = src ? await streamPeaks(src) : null;
    scope.postMessage({ t: 'peaks', id: m.id, peaks }, peaks ? [peaks.buffer] : []);
  } else if (m.t === 'render') {
    const mixer = (renderers.get(m.job) ?? renderers.set(m.job, new Mixer(m.segments, m.fps, m.sampleRate, sourceFor)).get(m.job))!;
    const [L, R] = await mixer.render(m.from, m.frames);
    scope.postMessage({ t: 'render', id: m.id, L, R }, [L.buffer, R.buffer]);
  } else if (m.t === 'render-done') {
    renderers.delete(m.job);
  }
};

const renderers = new Map<number, Mixer>();
