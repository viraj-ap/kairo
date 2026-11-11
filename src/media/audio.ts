import type { AudioSegment } from '../engine';
import { getMediaFile } from './opfs';
import { proxyKey } from './manifest';

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  return ctx;
}

const buffers = new Map<string, Promise<AudioBuffer | null>>();

/** Decoded audio for a media file (video files included), cached by hash. */
export function getAudioBuffer(hash: string): Promise<AudioBuffer | null> {
  let p = buffers.get(hash);
  if (!p) {
    p = (async () => {
      // The proxy carries the original's audio, so it plays while the original is missing.
      const file = (await getMediaFile(hash)) ?? (await getMediaFile(proxyKey(hash)));
      if (!file) return null;
      try {
        return await audioContext().decodeAudioData(await file.arrayBuffer());
      } catch {
        return null;
      }
    })();
    buffers.set(hash, p);
    void p.then((b) => b || buffers.delete(hash));
  }
  return p;
}

/** Min/max pairs at `perSecond` resolution for timeline waveforms. */
const peaks = new Map<string, Promise<Float32Array | null>>();
export const PEAKS_PER_SECOND = 100;

export function getPeaks(hash: string): Promise<Float32Array | null> {
  let p = peaks.get(hash);
  if (!p && 'AudioDecoder' in globalThis) {
    // Streamed in the audio worker: never holds the decoded file.
    p = import('./audio/out').then((m) => m.streamedPeaks(hash));
    peaks.set(hash, p);
    void p.then((b) => b || peaks.delete(hash));
  }
  if (!p) {
    p = getAudioBuffer(hash).then((buf) => {
      if (!buf) return null;
      const data = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(buf.sampleRate / PEAKS_PER_SECOND));
      const n = Math.ceil(data.length / step);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let max = 0;
        const end = Math.min(data.length, (i + 1) * step);
        for (let j = i * step; j < end; j++) max = Math.max(max, Math.abs(data[j]));
        out[i] = max;
      }
      return out;
    });
    peaks.set(hash, p);
    void p.then((b) => b || peaks.delete(hash));
  }
  return p;
}

/**
 * Schedule the mix starting at timeline frame `from` against `ctx.currentTime + delay`.
 * Returns the nodes so the caller can stop them.
 */
export async function scheduleMix(
  ac: BaseAudioContext,
  dest: AudioNode,
  segments: AudioSegment[],
  fps: number,
  from: number,
  when: number,
): Promise<AudioScheduledSourceNode[]> {
  const nodes: AudioScheduledSourceNode[] = [];
  for (const seg of segments) {
    const len = seg.out - seg.in;
    const startRel = (seg.start - from) / fps; // seconds from playback start
    const skip = Math.max(0, -startRel);
    const dur = len / fps - skip;
    if (dur <= 0) continue;
    const buf = await getAudioBuffer(seg.mediaHash);
    if (!buf) continue;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const gain = ac.createGain();
    gain.gain.value = seg.gain;
    src.connect(gain).connect(dest);
    src.start(when + Math.max(0, startRel), seg.in / fps + skip, dur);
    nodes.push(src);
  }
  return nodes;
}
