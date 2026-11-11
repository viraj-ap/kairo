/**
 * Measurement suites. Used by the /bench page, by scripts/bench.mjs (3 runs, medians)
 * and by the Playwright visual-regression test, via window.kairoBench.
 */
import { loadEngine, TimelineEngine } from '../engine';
import { sha256 } from '../lib/hash';
import { clearDecoderCache, decoderStats, getFrame, releaseDecoder } from '../media/decoderClient';
import { fetchAsFile } from '../media/import';
import { hasMedia, putMedia } from '../media/opfs';
import type { Timeline } from '../model/schema';
import { createCompositor } from '../render';
import { exportMp4 } from '../render/export';
import { liveFrameCount } from '../render/frame';
import { Player } from '../render/player';

const FPS = 30;
const FRAMES = 600; // every frames*.mp4 is 20 s at 30 fps

export const MEDIA = {
  frames540: { url: '/demo/frames.mp4', kind: 'video', w: 960, h: 540 },
  g60: { url: '/demo/frames_1080_g60.mp4', kind: 'video', w: 1920, h: 1080 },
  g250: { url: '/demo/frames_1080_g250.mp4', kind: 'video', w: 1920, h: 1080 },
  aurora: { url: '/demo/aurora.mp4', kind: 'video', w: 1280, h: 720 },
  logo: { url: '/logo.png', kind: 'image', w: 500, h: 500 },
} as const;
export type MediaKey = keyof typeof MEDIA;
export type Hashes = Record<MediaKey, string>;

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n: s.length, p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(s[s.length - 1] ?? 0), mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)) };
}

/** Put every benchmark file in OPFS (content-addressed, like an import). */
export async function prepare(): Promise<Hashes> {
  await loadEngine();
  await document.fonts.ready;
  const out = {} as Hashes;
  for (const [k, m] of Object.entries(MEDIA) as [MediaKey, (typeof MEDIA)[MediaKey]][]) {
    const file = await fetchAsFile(m.url, m.url.split('/').pop()!);
    const hash = await sha256(await file.arrayBuffer());
    if (!(await hasMedia(hash))) await putMedia(hash, file);
    out[k] = hash;
  }
  return out;
}

let probe: OffscreenCanvasRenderingContext2D | null = null;

/** frames*.mp4 encode each frame's number as 16 binary blocks along the top-left edge. */
export function readFrameNumber(frame: VideoFrame): number {
  probe ??= new OffscreenCanvas(256, 16).getContext('2d', { willReadFrequently: true })!;
  probe.drawImage(frame, 0, 0, 256, 16, 0, 0, 256, 16);
  const px = probe.getImageData(0, 0, 256, 16).data;
  let n = 0;
  for (let b = 0; b < 16; b++) if (px[(8 * 256 + b * 16 + 8) * 4] > 128) n |= 1 << b;
  return n;
}

/**
 * Random seeks with exactness check. `cold` clears every decoded frame and decoder before
 * each seek; `far` forces each target at least a third of the file away from the previous one.
 */
export async function seekSuite(hash: string, opts: { n: number; cold: boolean; far: boolean }) {
  const lat: number[] = [];
  let exact = 0;
  const misses: { want: number; got: number }[] = [];
  let prev = 0;
  const slot = `bench-seek-${Math.random()}`;
  clearDecoderCache();
  for (let i = 0; i < opts.n; i++) {
    let want = Math.floor(Math.random() * FRAMES);
    if (opts.far) while (Math.abs(want - prev) < FRAMES / 3) want = Math.floor(Math.random() * FRAMES);
    prev = want;
    if (opts.cold) clearDecoderCache();
    const t0 = performance.now();
    const f = await getFrame(hash, slot, want / FPS);
    lat.push(performance.now() - t0);
    const got = f ? readFrameNumber(f) : -1;
    f?.close();
    if (got === want) exact++;
    else if (misses.length < 10) misses.push({ want, got });
  }
  releaseDecoder(slot);
  return { n: opts.n, exact, accuracy: exact / opts.n, latencyMs: stats(lat), misses };
}

export async function sequentialSuite(hash: string, n = 300) {
  const slot = `bench-seq-${Math.random()}`;
  clearDecoderCache();
  let exact = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const f = await getFrame(hash, slot, i / FPS);
    if (f && readFrameNumber(f) === i) exact++;
    f?.close();
  }
  const ms = performance.now() - t0;
  releaseDecoder(slot);
  return { frames: n, exact, decodeFps: Math.round((n / ms) * 1000 * 10) / 10 };
}

/**
 * 3 video tracks of 1080p H.264, all on screen at once (full frame + two picture-in-picture
 * layers with opacity), plus a text layer, for `seconds`.
 */
export function threeTrackTimeline(h: Hashes, seconds: number): Timeline {
  const total = seconds * FPS;
  const media = {
    [h.g60]: { kind: 'video' as const, name: 'g60', durationFrames: FRAMES, width: 1920, height: 1080, fps: FPS, hasAudio: false },
    [h.g250]: { kind: 'video' as const, name: 'g250', durationFrames: FRAMES, width: 1920, height: 1080, fps: FPS, hasAudio: false },
  };
  const clips: Timeline['clips'] = {
    title: { trackId: 'tx', text: 'Kairo 3-track bench', start: 0, in: 0, out: total, fontSize: 64, y: -0.4 },
  };
  const lane = (track: string, hash: string, offset: number, extra: object) => {
    for (let s = 0, i = 0; s < total; s += FRAMES - offset, i++) {
      clips[`${track}${i}`] = { trackId: track, mediaHash: hash, start: s, in: offset, out: Math.min(FRAMES, offset + total - s), ...extra };
    }
  };
  lane('v1', h.g60, 0, {});
  lane('v2', h.g250, 30, { scale: 0.4, x: 0.25, y: 0.2, opacity: 0.9 });
  lane('v3', h.g60, 90, { scale: 0.35, x: -0.28, y: 0.22, effect: 'duotone' });
  return {
    fps: FPS,
    media,
    tracks: {
      tx: { kind: 'video', name: 'Text', order: 0 },
      v3: { kind: 'video', name: 'PIP B', order: 1 },
      v2: { kind: 'video', name: 'PIP A', order: 2 },
      v1: { kind: 'video', name: 'Main', order: 3 },
    },
    clips,
  };
}

function benchCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:180px;z-index:99;pointer-events:none';
  document.body.appendChild(c);
  return c;
}

/** Real-time playback through the editor's Player (AudioContext clock, drop-not-delay). */
export async function playbackSuite(h: Hashes, seconds: number) {
  const engine = new TimelineEngine();
  engine.load(threeTrackTimeline(h, seconds));
  const canvas = benchCanvas(1920, 1080);
  const comp = await createCompositor(canvas);
  clearDecoderCache();
  const presentedSet = new Set<number>();
  const player = new Player(engine, comp, FPS, () => {}, () => {}, (f) => presentedSet.add(f));
  player.timelineChanged();
  await player.play();
  while (player.playing) await new Promise((r) => setTimeout(r, 250));
  const s = player.stats;
  player.destroy();
  comp.destroy();
  canvas.remove();
  const expected = seconds * FPS;
  return {
    seconds,
    resolution: '1920x1080',
    compositor: comp.kind,
    expectedFrames: expected,
    presented: presentedSet.size,
    dropped: expected - presentedSet.size,
    dropRate: Math.round(((expected - presentedSet.size) / expected) * 10000) / 10000,
    frameRenderMs: stats(s.renderMs),
    /** Frames not presented, bucketed by second of the timeline. */
    dropsBySecond: Object.fromEntries(
      Object.entries(
        Array.from({ length: seconds * FPS }, (_, f) => f)
          .filter((f) => !presentedSet.has(f))
          .reduce<Record<number, number>>((m, f) => ((m[Math.floor(f / FPS)] = (m[Math.floor(f / FPS)] ?? 0) + 1), m), {}),
      ),
    ),
  };
}

export async function exportSuite(h: Hashes, opts: { width: number; height: number; seconds: number }) {
  const t0 = performance.now();
  const blob = await exportMp4(threeTrackTimeline(h, opts.seconds), { width: opts.width, height: opts.height });
  const wall = (performance.now() - t0) / 1000;
  return { ...opts, source: '3-track 1080p timeline', wallSeconds: Math.round(wall * 100) / 100, xRealtime: Math.round((opts.seconds / wall) * 100) / 100, bytes: blob.size };
}

/** Resolve to `fallback` if `p` hasn't settled within `ms` (a soak must never hang on one sample). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/** measureUserAgentSpecificMemory waits for a GC, which can take indefinitely in an idle headless browser. */
async function uaMemory(): Promise<number | null> {
  const p = performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> };
  if (!crossOriginIsolated || !p.measureUserAgentSpecificMemory) return null;
  try {
    return await within(p.measureUserAgentSpecificMemory().then((m) => m.bytes), 20_000, null);
  } catch {
    return null;
  }
}

/**
 * Long-running stability: loop 3-track playback with a random seek every 5 s, sampling
 * memory and open VideoFrames every `sampleEvery` seconds.
 */
export async function soakSuite(h: Hashes, minutes: number, sampleEvery = 30, onSample?: (s: unknown) => void) {
  const engine = new TimelineEngine();
  engine.load(threeTrackTimeline(h, 60));
  const canvas = benchCanvas(1920, 1080);
  const comp = await createCompositor(canvas);
  let presentedTotal = 0;
  let playStarts = 0;
  const player = new Player(engine, comp, FPS, () => {}, () => {}, () => presentedTotal++);
  player.timelineChanged();
  const samples: { t: number; uaBytes: number | null; jsHeap: number | null; workerCachedFrames: number; decoders: number; mainLiveFrames: number; presentedSoFar: number }[] = [];
  const end = performance.now() + minutes * 60_000;
  let nextSeek = 0;
  let nextSample = 0;
  const t0 = performance.now();
  while (performance.now() < end) {
    const now = performance.now();
    if (!player.playing) {
      playStarts++;
      await within(player.play(), 5000, undefined);
    }
    if (now >= nextSeek) {
      player.seek(Math.floor(Math.random() * 1700));
      nextSeek = now + 5000;
    }
    if (now >= nextSample) {
      const ws = await within(decoderStats(), 5000, { cached: -1, decoders: -1 });
      const sample = {
        t: Math.round((now - t0) / 1000),
        uaBytes: await uaMemory(),
        jsHeap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
        workerCachedFrames: ws.cached,
        decoders: ws.decoders,
        mainLiveFrames: liveFrameCount(),
        presentedSoFar: presentedTotal,
      };
      samples.push(sample);
      onSample?.(sample);
      nextSample = now + sampleEvery * 1000;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  player.destroy();
  comp.destroy();
  canvas.remove();
  const ua = samples.map((s) => s.uaBytes).filter((x): x is number => x !== null);
  return {
    minutes,
    crossOriginIsolated,
    samples,
    uaBytes: ua.length ? { first: ua[0], last: ua[ua.length - 1], max: Math.max(...ua) } : null,
    maxWorkerCachedFrames: Math.max(...samples.map((s) => s.workerCachedFrames)),
    maxMainLiveFrames: Math.max(...samples.map((s) => s.mainLiveFrames)),
    /** Frames actually put on screen over the whole soak (wall-clock playback ≈ minutes × 60 × 30, minus seeks). */
    presentedTotal,
    playStarts,
    uaSamplesTimedOut: samples.filter((s) => s.uaBytes === null).length,
  };
}

/** Fixed 3-track project for visual regression: video, image overlay, text with a fade. */
export function goldenTimeline(h: Hashes): Timeline {
  return {
    fps: FPS,
    media: {
      [h.aurora]: { kind: 'video', name: 'aurora', durationFrames: 240, width: 1280, height: 720, fps: FPS, hasAudio: true },
      [h.logo]: { kind: 'image', name: 'logo', durationFrames: 150, width: 500, height: 500, fps: FPS, hasAudio: false },
    },
    tracks: {
      t: { kind: 'video', name: 'Text', order: 0 },
      i: { kind: 'video', name: 'Logo', order: 1 },
      v: { kind: 'video', name: 'Video', order: 2 },
    },
    clips: {
      text: { trackId: 't', text: 'Kairo · SSIM', start: 0, in: 0, out: 90, fontSize: 110, y: 0.3, transitionIn: { kind: 'fade', duration: 15 } },
      logo: { trackId: 'i', mediaHash: h.logo, start: 0, in: 0, out: 90, scale: 0.35, x: 0.3, y: -0.2, opacity: 0.9 },
      video: { trackId: 'v', mediaHash: h.aurora, start: 0, in: 30, out: 120, brightness: 0.05, transitionIn: { kind: 'wipe', duration: 20 } },
    },
  };
}

/** Render frames of the golden project to PNG data URLs with the real compositor. */
export async function renderGoldenFrames(h: Hashes, frames = [0, 45, 89], width = 960, height = 540) {
  const { gather } = await import('../render/frame');
  const engine = new TimelineEngine();
  engine.load(goldenTimeline(h));
  const canvas = new OffscreenCanvas(width, height);
  const comp = await createCompositor(canvas);
  const pngs: string[] = [];
  clearDecoderCache();
  for (const f of frames) {
    const g = await gather(engine.renderPlan(f, 0), height, 'golden:');
    await comp.draw(g.items);
    await comp.flush();
    g.release();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    pngs.push(await new Promise<string>((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result as string);
      fr.readAsDataURL(blob);
    }));
  }
  comp.destroy();
  return { compositor: comp.kind, frames, pngs };
}



// ---- C1: streaming audio ---------------------------------------------------------------

/** Put an extra benchmark file (served from /bench-media by the runner) into OPFS. */
export async function loadExtra(url: string): Promise<string> {
  await loadEngine();
  const file = await fetchAsFile(url, url.split('/').pop()!);
  const { hashBlob } = await import('../media/manifest');
  const hash = await hashBlob(file);
  if (!(await hasMedia(hash))) await putMedia(hash, file);
  return hash;
}

async function sampleMemory(): Promise<number | null> {
  return uaMemory();
}

/**
 * Peak memory while playing and drawing the waveform of a 60-minute audio file, with the
 * streaming path, then (separately) with the old whole-file decodeAudioData path.
 */
export async function audioMemorySuite(hash: string, seconds = 20) {
  const minutes = 60;
  const fps = FPS;
  const t: Timeline = {
    fps,
    media: { [hash]: { kind: 'audio', name: '60min', durationFrames: minutes * 60 * fps, width: 0, height: 0, fps, hasAudio: true } },
    tracks: { a: { kind: 'audio', name: 'A', order: 0 } },
    clips: { c: { trackId: 'a', mediaHash: hash, start: 0, in: 30 * 60 * fps, out: minutes * 60 * fps } },
  };
  const engine = new TimelineEngine();
  engine.load(t);
  const canvas = benchCanvas(320, 180);
  const comp = await createCompositor(canvas);
  const player = new Player(engine, comp, fps, () => {}, () => {});
  player.timelineChanged();
  const baseline = await sampleMemory();
  const samples: (number | null)[] = [];
  await player.play();
  const { getPeaks } = await import('../media/audio');
  const peaksAt = performance.now();
  const peaks = getPeaks(hash);
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    samples.push(await sampleMemory());
    await new Promise((r) => setTimeout(r, 1000));
  }
  const peakArray = await peaks;
  const peaksMs = performance.now() - peaksAt;
  const underruns = player.audioOut?.underruns() ?? null;
  const streaming = !!player.audioOut;
  player.destroy();
  comp.destroy();
  canvas.remove();
  const valid = samples.filter((x): x is number => x !== null);

  return {
    file: '60 min AAC 128 kbit/s, 48 kHz stereo (59 MB)',
    streaming,
    playedSeconds: seconds,
    underruns,
    peaksSeconds: Math.round(peaksMs) / 1000,
    peaksBuckets: peakArray?.length ?? 0,
    memory: {
      baselineMB: baseline && Math.round(baseline / 1e5) / 10,
      streamingPeakMB: valid.length ? Math.round(Math.max(...valid) / 1e5) / 10 : null,
    },
  };
}

/**
 * A/V drift: play a clip with one white frame and a 1 kHz beep at every whole second; for
 * each second compare when the flash frame was put on screen with when the beep's first
 * sample was rendered, both on the AudioContext clock.
 */
export async function avDriftSuite(hash: string, seconds = 300) {
  const fps = FPS;
  const t: Timeline = {
    fps,
    media: { [hash]: { kind: 'video', name: 'sync', durationFrames: seconds * fps, width: 640, height: 360, fps, hasAudio: true } },
    tracks: { v: { kind: 'video', name: 'V', order: 0 } },
    clips: { c: { trackId: 'v', mediaHash: hash, start: 0, in: 0, out: seconds * fps } },
  };
  const engine = new TimelineEngine();
  engine.load(t);
  const canvas = benchCanvas(640, 360);
  const comp = await createCompositor(canvas);
  const { audioContext } = await import('../media/audio');
  const ac = audioContext();
  const flashes = new Map<number, number>(); // second → ctx time presented
  const onsets: number[] = [];
  const toCtx = (perf: number) => {
    const ts = ac.getOutputTimestamp();
    return (ts.contextTime ?? 0) + (perf - (ts.performanceTime ?? perf)) / 1000;
  };
  const player = new Player(engine, comp, fps, () => {}, () => {}, (f) => {
    if (f % fps === 0) flashes.set(f / fps, toCtx(performance.now()));
  });
  player.timelineChanged();
  await player.play();
  player.audioOut?.setMeasure(true);
  if (player.audioOut) player.audioOut.onOnset = (time) => onsets.push(time);
  while (player.playing) await new Promise((r) => setTimeout(r, 500));
  const startTime = (player as unknown as { startTime: number }).startTime;
  player.destroy();
  comp.destroy();
  canvas.remove();
  const drift: number[] = [];
  for (const on of onsets) {
    const s = Math.round(on - startTime);
    const v = flashes.get(s);
    if (v !== undefined) drift.push((v - on) * 1000);
  }
  const abs = drift.map(Math.abs);
  return {
    seconds,
    streaming: onsets.length > 0,
    flashesPresented: flashes.size,
    beepsHeard: onsets.length,
    pairs: drift.length,
    driftMs: { ...stats(abs), avg: Math.round((abs.reduce((a, b) => a + b, 0) / (abs.length || 1)) * 100) / 100, meanSigned: Math.round((drift.reduce((a, b) => a + b, 0) / (drift.length || 1)) * 100) / 100 },
    oneFrameMs: Math.round(100000 / fps) / 100,
    outputLatencyMs: Math.round((ac.outputLatency ?? 0) * 1000 * 100) / 100,
    baseLatencyMs: Math.round(ac.baseLatency * 1000 * 100) / 100,
  };
}



/** The old path, for the memory comparison: decode the whole file and hold it for `holdSeconds`. */
export async function legacyAudioDecode(hash: string, holdSeconds = 10) {
  const { getMediaFile } = await import('../media/opfs');
  const ac = new OfflineAudioContext(2, 1, 48000);
  const buf = await ac.decodeAudioData(await (await getMediaFile(hash))!.arrayBuffer());
  await new Promise((r) => setTimeout(r, holdSeconds * 1000));
  return { decodedPcmMB: Math.round((buf.length * buf.numberOfChannels * 4) / 1e5) / 10, seconds: buf.duration };
}

export const kairoBench = { prepare, seekSuite, sequentialSuite, playbackSuite, exportSuite, soakSuite, renderGoldenFrames, stats, loadExtra, audioMemorySuite, avDriftSuite, legacyAudioDecode };
