import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { TimelineEngine } from '../engine';
import { scheduleMix } from '../media/audio';
import { renderMix } from '../media/audio/out';
import type { Timeline } from '../model/schema';
import { gather } from './frame';
import { createCompositor } from './index';

export interface ExportOptions {
  width: number;
  height: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const SAMPLE_RATE = 48000;

async function pickVideoConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  const bitrate = Math.round(width * height * fps * 0.12);
  for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42002a']) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
  }
  throw new Error('This browser cannot encode H.264 at this size');
}

/** Render the timeline offline and mux H.264/AAC into an MP4, entirely on this device. */
export async function exportMp4(t: Timeline, opts: ExportOptions): Promise<Blob> {
  const fps = t.fps;
  const engine = new TimelineEngine();
  engine.load(t);
  const total = engine.duration();
  if (total <= 0) throw new Error('The timeline is empty');
  const segments = engine.audioPlan();
  const { width, height } = opts;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: segments.length ? { codec: 'aac', numberOfChannels: 2, sampleRate: SAMPLE_RATE } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  venc.configure(await pickVideoConfig(width, height, fps));

  const canvas = new OffscreenCanvas(width, height);
  const compositor = await createCompositor(canvas);
  try {
    for (let f = 0; f < total; f++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (failure) throw failure;
      const g = await gather(engine.renderPlan(f, Math.round(fps / 2)), height, 'ex:');
      await compositor.draw(g.items);
      await compositor.flush();
      const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      g.release();
      while (venc.encodeQueueSize > 4) await new Promise((r) => venc.addEventListener('dequeue', r, { once: true }));
      opts.onProgress?.(f + 1, total);
    }
    await venc.flush();
  } finally {
    compositor.destroy();
    if (venc.state !== 'closed') venc.close();
  }

  if (segments.length) {
    const length = Math.ceil((total / fps) * SAMPLE_RATE);
    const aenc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => (failure = e),
    });
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 160_000 });
    const encode = (L: Float32Array, R: Float32Array, at: number) => {
      const N = 1024;
      for (let i = 0; i < L.length; i += N) {
        const n = Math.min(N, L.length - i);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(i, i + n), 0);
        data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(((at + i) * 1e6) / SAMPLE_RATE), data });
        aenc.encode(ad);
        ad.close();
      }
    };
    if ('AudioDecoder' in globalThis) {
      // Streamed: the mix is rendered a second at a time, never whole files in memory.
      await renderMix(segments, fps, SAMPLE_RATE, length, encode);
    } else {
      const oac = new OfflineAudioContext(2, length, SAMPLE_RATE);
      await scheduleMix(oac, oac.destination, segments, fps, 0, 0);
      const mix = await oac.startRendering();
      encode(mix.getChannelData(0), mix.numberOfChannels > 1 ? mix.getChannelData(1) : mix.getChannelData(0), 0);
    }
    await aenc.flush();
    aenc.close();
  }
  if (failure) throw failure;
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
