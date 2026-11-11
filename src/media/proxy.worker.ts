/// <reference lib="webworker" />
/**
 * Proxy generation: decode the original with WebCodecs, scale each frame to 540p on an
 * OffscreenCanvas (GPU-backed), re-encode H.264 with a keyframe every 30 frames, and mux
 * with the original AAC audio copied over unchanged. The proxy keeps the original's
 * timestamps and orientation, so it is a drop-in substitute for playback.
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { audioDescription, codecDescription, demux, samples as trackSamples } from './mp4';
import { getMediaFile, putMedia } from './opfs';
import { proxyKey } from './manifest';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const PROXY_HEIGHT = 540;
const GOP = 30;

async function pickEncoder(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  for (const codec of ['avc1.4d001f', 'avc1.42001f', 'avc1.640028']) {
    const c: VideoEncoderConfig = { codec, width, height, bitrate: 1_500_000, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' };
    if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
  }
  throw new Error('No H.264 encoder for the proxy');
}

async function generate(hash: string, report: (p: number) => void) {
  const file = await getMediaFile(hash);
  if (!file) throw new Error('original missing');
  const d = await demux(file);
  const vt = d.info.videoTracks[0];
  if (!vt) throw new Error('no video track');
  const srcW = vt.video!.width;
  const srcH = vt.video!.height;
  const height = Math.min(PROXY_HEIGHT, srcH - (srcH % 2));
  const width = Math.round((height * srcW) / srcH / 2) * 2;
  const vSamples = trackSamples(d, vt.id);
  const seconds = vt.duration / vt.timescale || d.info.duration / d.info.timescale;
  const fps = Math.max(1, Math.round(vSamples.length / seconds));
  const t0 = Math.min(...vSamples.map((s) => s.cts)) / vt.timescale;

  const at = d.info.audioTracks[0];
  const aDesc = at && at.codec.startsWith('mp4a') ? audioDescription(d, at.id) : undefined;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: aDesc ? { codec: 'aac', sampleRate: at!.audio!.sample_rate, numberOfChannels: at!.audio!.channel_count } : undefined,
    fastStart: 'in-memory', // moov first: a partially transferred proxy is playable
    firstTimestampBehavior: 'cross-track-offset',
  });

  let failure: unknown = null;
  const encoder = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failure = e) });
  encoder.configure(await pickEncoder(width, height, fps));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  let encoded = 0;
  const decoder = new VideoDecoder({
    output: (frame) => {
      ctx.drawImage(frame, 0, 0, width, height);
      const ts = frame.timestamp;
      const dur = frame.duration ?? Math.round(1e6 / fps);
      frame.close();
      const out = new VideoFrame(canvas, { timestamp: ts, duration: dur });
      encoder.encode(out, { keyFrame: encoded % GOP === 0 });
      out.close();
      encoded++;
    },
    error: (e) => (failure = e),
  });
  decoder.configure({ codec: vt.codec, codedWidth: srcW, codedHeight: srcH, description: codecDescription(d, vt.id), hardwareAcceleration: 'prefer-hardware' });

  // Feed in batches of contiguous samples (one read each), with backpressure on both codecs.
  for (let i = 0; i < vSamples.length; ) {
    if (failure) throw failure;
    const end = Math.min(vSamples.length, i + 16);
    const start = vSamples[i].offset;
    let stop = start;
    for (let j = i; j < end; j++) stop = Math.max(stop, vSamples[j].offset + vSamples[j].size);
    const buf = new Uint8Array(await file.slice(start, stop).arrayBuffer());
    for (let j = i; j < end; j++) {
      const s = vSamples[j];
      decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts / s.timescale - t0) * 1e6),
          duration: Math.round((s.duration / s.timescale) * 1e6),
          data: buf.subarray(s.offset - start, s.offset - start + s.size),
        }),
      );
    }
    i = end;
    while (decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    report(i / vSamples.length);
  }
  await decoder.flush();
  await encoder.flush();
  decoder.close();
  encoder.close();
  if (failure) throw failure;

  if (aDesc) {
    const meta = { decoderConfig: { codec: at!.codec, sampleRate: at!.audio!.sample_rate, numberOfChannels: at!.audio!.channel_count, description: aDesc } };
    for (const s of trackSamples(d, at!.id)) {
      const data = new Uint8Array(await file.slice(s.offset, s.offset + s.size).arrayBuffer());
      muxer.addAudioChunkRaw(data, 'key', Math.round((s.cts / s.timescale) * 1e6), Math.round((s.duration / s.timescale) * 1e6), meta);
    }
  }
  muxer.finalize();
  const bytes = new Uint8Array(muxer.target.buffer);
  await putMedia(proxyKey(hash), bytes);
  return { width, height, frames: encoded, bytes: bytes.byteLength };
}

scope.onmessage = async (e: MessageEvent<{ id: number; hash: string }>) => {
  const { id, hash } = e.data;
  try {
    const t0 = performance.now();
    const r = await generate(hash, (progress) => scope.postMessage({ id, progress }));
    scope.postMessage({ id, done: { ...r, ms: performance.now() - t0 } });
  } catch (err) {
    scope.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
