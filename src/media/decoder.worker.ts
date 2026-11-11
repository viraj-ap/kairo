/// <reference lib="webworker" />
/**
 * Video decoding worker. One VideoDecoder per active clip; a shared LRU cache of
 * decoded VideoFrames (GPU memory) with a hard cap, closing frames as they are evicted.
 *
 * Seek = find the sample at the target time, back up to its keyframe, decode forward.
 * Sequential requests (playback) keep feeding the same decoder instead of re-seeking.
 */
import { codecDescription, demux, samples as trackSamples } from './mp4';
import { getMediaFile, getPartial } from './opfs';
import { proxyKey } from './manifest';

interface S {
  ts: number; // presentation timestamp, µs
  dur: number;
  key: boolean;
  offset: number;
  size: number;
}

interface Source {
  file: Blob;
  /** Playing the 540p proxy because the original isn't on this device (yet). */
  proxy: boolean;
  /** Are these bytes on disk? Always true for complete files; a proxy may still be arriving. */
  has(offset: number, size: number): boolean;
  config: VideoDecoderConfig;
  samples: S[]; // decode order
  byPts: number[]; // decode indices sorted by presentation time
  keyOf: Int32Array; // decode index -> decode index of its keyframe
  frameUs: number;
}

type Req =
  | { t: 'frame'; id: number; hash: string; key: string; time: number }
  | { t: 'preroll'; hash: string; key: string; time: number }
  | { t: 'release'; key: string }
  | { t: 'cap'; frames: number }
  | { t: 'clear' }
  | { t: 'invalidate'; hash: string }
  | { t: 'stats'; id: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;

// ---- source parsing -------------------------------------------------------

const sources = new Map<string, Promise<Source>>();

function source(hash: string): Promise<Source> {
  let p = sources.get(hash);
  if (!p) {
    p = loadSource(hash);
    p.catch(() => sources.delete(hash));
    sources.set(hash, p);
  }
  return p;
}

/** The original if it's complete here, otherwise the proxy — even a partially transferred one. */
async function loadSource(hash: string): Promise<Source> {
  const original = await getMediaFile(hash);
  let file: Blob;
  let proxy = false;
  let has: Source['has'] = () => true;
  if (original) file = original;
  else {
    const p = await getPartial(proxyKey(hash));
    if (!p || !p.present.has(0)) throw new Error('missing');
    file = p.blob;
    proxy = true;
    if (!p.complete) has = (offset, size) => p.has(offset, offset + size);
  }
  const d = await demux(file);
  const track = d.info.videoTracks[0];
  if (!track) throw new Error('no video track');
  const raw = trackSamples(d, track.id);
  const samples: S[] = raw.map((s) => ({
    ts: Math.round((s.cts * 1e6) / s.timescale),
    dur: Math.round((s.duration * 1e6) / s.timescale),
    key: s.is_sync,
    offset: s.offset,
    size: s.size,
  }));
  // Shift so the first presented frame is at t=0 (handles B-frame composition offsets).
  const t0 = Math.min(...samples.map((s) => s.ts));
  samples.forEach((s) => (s.ts -= t0));
  const byPts = samples.map((_, i) => i).sort((a, b) => samples[a].ts - samples[b].ts);
  const keyOf = new Int32Array(samples.length);
  let k = 0;
  samples.forEach((s, i) => {
    if (s.key) k = i;
    keyOf[i] = k;
  });
  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video!.width,
    codedHeight: track.video!.height,
    description: codecDescription(d, track.id),
    optimizeForLatency: true,
    hardwareAcceleration: 'no-preference',
  };
  const frameUs = samples.length > 1 ? samples[byPts[1]].ts - samples[byPts[0]].ts : 33_333;
  return { file, proxy, has, config, samples, byPts, keyOf, frameUs };
}

// ---- frame cache ------------------------------------------------------------

/**
 * Decoded frames, evicted in decode order (oldest first) under a memory budget. Reads don't
 * refresh an entry: in playback the frame just shown is the least likely to be needed next,
 * while frames decoded ahead are the most likely — evicting those forced long-GOP re-decodes.
 */
let cap = 240;
const BUDGET_BYTES = 384 << 20;
let cachedBytes = 0;
const cache = new Map<string, VideoFrame>();
const waiters = new Map<string, ((f: VideoFrame | null) => void)[]>();
const frameBytes = (f: VideoFrame) => f.codedWidth * f.codedHeight * 1.5;

function cacheDelete(k: string) {
  const f = cache.get(k);
  if (!f) return;
  cachedBytes -= frameBytes(f);
  f.close();
  cache.delete(k);
}

function cachePut(k: string, f: VideoFrame) {
  cacheDelete(k);
  cache.set(k, f);
  cachedBytes += frameBytes(f);
  while (cache.size > cap || cachedBytes > BUDGET_BYTES) cacheDelete(cache.keys().next().value!);
  const w = waiters.get(k);
  if (w) {
    waiters.delete(k);
    w.forEach((resolve) => resolve(f.clone()));
  }
}

function cacheGet(k: string): VideoFrame | null {
  return cache.get(k)?.clone() ?? null;
}

function waitFor(k: string, ms: number): Promise<VideoFrame | null> {
  return new Promise((resolve) => {
    const list = waiters.get(k) ?? [];
    let done = false;
    const finish = (f: VideoFrame | null) => {
      if (done) return f?.close();
      done = true;
      resolve(f);
    };
    list.push(finish);
    waiters.set(k, list);
    setTimeout(() => {
      const l = waiters.get(k);
      if (l) {
        const rest = l.filter((x) => x !== finish);
        if (rest.length) waiters.set(k, rest);
        else waiters.delete(k);
      }
      finish(null);
    }, ms);
  });
}

// ---- per-clip decoders ------------------------------------------------------

const AHEAD = 6;
/** During playback, keep this many frames decoded ahead of the last request. */
const LOOKAHEAD = 12;

class ClipDecoder {
  private decoder: VideoDecoder | null = null;
  private nextFeed = -1;
  private chain: Promise<void> = Promise.resolve();
  private pending: { time: number; resolve: (f: VideoFrame | null) => void } | null = null;
  lastUsed = performance.now();

  constructor(
    readonly hash: string,
    private src: Source,
  ) {}

  private topping = false;

  /** Requests are serialized; a newer request supersedes one that hasn't started yet. */
  request(time: number): Promise<VideoFrame | null> {
    this.lastUsed = performance.now();
    const d = this.pick(time);
    const hit = cacheGet(this.cacheKey(d));
    if (hit) {
      this.topUp(d);
      return Promise.resolve(hit);
    }
    this.pending?.resolve(null);
    return new Promise((resolve) => {
      this.pending = { time, resolve };
      this.chain = this.chain.then(() => this.run());
    });
  }

  /**
   * Playback reads frames sequentially and mostly hits the cache; keep the decoder fed
   * ahead so the next frames are already decoded instead of stalling on each miss.
   */
  private topUp(d: number) {
    const want = Math.min(d + LOOKAHEAD, this.src.samples.length - 1);
    if (this.topping || this.pending || this.nextFeed < 0 || this.nextFeed > want || this.nextFeed < d - 2) return;
    if (this.decoder?.state !== 'configured') return;
    this.topping = true;
    this.chain = this.chain
      .then(() => this.feed(want))
      .catch(() => undefined)
      .finally(() => (this.topping = false));
  }

  /**
   * Low-priority warm-up for a clip that starts soon: position the decoder and feed a couple
   * of samples per call, so a cut doesn't cause a burst that starves the clips on screen.
   */
  preroll(time: number) {
    this.lastUsed = performance.now();
    if (this.pending || this.topping) return;
    const d = this.pick(time);
    if (cache.has(this.cacheKey(d))) return;
    this.topping = true;
    this.chain = this.chain
      .then(async () => {
        const key = this.src.keyOf[d];
        const positioned = this.nextFeed >= key && this.nextFeed <= d + AHEAD + 1 && this.decoder?.state === 'configured';
        if (!positioned) {
          this.restart();
          this.nextFeed = key;
        }
        await this.feed(Math.min(d + AHEAD, this.nextFeed + 1, this.src.samples.length - 1));
      })
      .catch(() => undefined)
      .finally(() => (this.topping = false));
  }

  private async run() {
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    try {
      job.resolve(await this.decodeAt(job.time));
    } catch (e) {
      console.warn('[decoder]', e);
      this.reset();
      job.resolve(null);
    }
  }

  private pick(time: number): number {
    const { samples, byPts } = this.src;
    // The frame on screen at `time` is the latest one presented at or before it. That is
    // right for variable frame rates too; 1 ms absorbs timestamp rounding.
    const target = time * 1e6 + 1000;
    let lo = 0;
    let hi = byPts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[byPts[mid]].ts <= target) lo = mid;
      else hi = mid - 1;
    }
    return byPts[lo];
  }

  private cacheKey(i: number) {
    return `${this.hash}|${this.src.samples[i].ts}`;
  }

  /** A configured decoder, reusing this clip's existing one when it's healthy. */
  private ensureDecoder() {
    if (this.decoder?.state === 'configured') return;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = new VideoDecoder({
      output: (f) => cachePut(`${this.hash}|${f.timestamp}`, f),
      error: (e) => {
        console.warn('[decoder]', e.name, e.message);
        this.nextFeed = -1;
      },
    });
    this.decoder.configure(this.src.config);
    this.nextFeed = -1;
    this.eosFlushed = false;
  }

  /**
   * Jump: reuse the same decoder (reset + configure) instead of creating a new one.
   * Hardware decoder sessions are a limited OS resource; abandoning them unclosed made
   * later decoders fail with "Decoding error" until garbage collection caught up.
   */
  private restart() {
    this.eosFlushed = false;
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
      this.decoder.configure(this.src.config);
    } else {
      this.decoder = null;
      this.ensureDecoder();
    }
    this.nextFeed = -1;
  }

  private reset() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.nextFeed = -1;
  }

  private async decodeAt(time: number): Promise<VideoFrame | null> {
    const d = this.pick(time);
    const k = this.cacheKey(d);
    const hit = cacheGet(k);
    if (hit) return hit;

    const key = this.src.keyOf[d];
    // A proxy still arriving may not have this GOP yet: report the frame as unavailable.
    for (let i = key; i <= Math.min(d + AHEAD, this.src.samples.length - 1); i++) {
      const s = this.src.samples[i];
      if (!this.src.has(s.offset, s.size)) return null;
    }
    const sequential = this.nextFeed >= 0 && this.nextFeed <= d + 1 && (this.nextFeed >= key || d - this.nextFeed < 45);
    if (!sequential) {
      this.restart();
      this.nextFeed = key;
    } else {
      this.ensureDecoder();
      if (this.nextFeed < 0) this.nextFeed = key;
    }

    const last = this.src.samples.length - 1;
    let upTo = Math.min(d + AHEAD, last);
    await this.feed(upTo);
    const deadline = performance.now() + 3000;
    let frame: VideoFrame | null = null;
    while (!(frame = cacheGet(k))) {
      frame = await waitFor(k, 8);
      if (frame || performance.now() > deadline || !this.decoder) break;
      // Still decoding what we gave it: keep waiting.
      if (this.decoder.decodeQueueSize > 0) continue;
      // Idle but holding the target back for B-frame reordering (hardware decoders can keep a
      // deep reorder buffer): give it more of the stream rather than stalling.
      if (upTo < last && upTo < d + 64) {
        upTo = Math.min(upTo + 4, last);
        await this.feed(upTo);
        continue;
      }
      // End of stream: only a flush releases the final frames.
      await this.decoder.flush().catch(() => undefined);
      this.nextFeed = -1; // after flush the next chunk must be a keyframe
      frame = cacheGet(k);
      break;
    }
    return frame;
  }

  private eosFlushed = false;

  private async feed(upTo: number) {
    const { samples, file } = this.src;
    while (this.nextFeed <= upTo && this.decoder?.state === 'configured') {
      // One file read per batch of samples (OPFS reads have a high fixed cost per call).
      const from = this.nextFeed;
      const to = Math.min(upTo, from + 15);
      const start = samples[from].offset;
      let end = start;
      for (let i = from; i <= to; i++) end = Math.max(end, samples[i].offset + samples[i].size);
      const span = end - start;
      const buf = span <= 8 << 20 ? new Uint8Array(await file.slice(start, end).arrayBuffer()) : null;
      for (let i = from; i <= to; i++) {
        if (this.decoder?.state !== 'configured' || this.nextFeed !== i) return;
        const s = samples[i];
        if (!this.src.has(s.offset, s.size)) return; // not transferred yet
        const data = buf ? buf.subarray(s.offset - start, s.offset - start + s.size) : await file.slice(s.offset, s.offset + s.size).arrayBuffer();
        this.nextFeed = i + 1;
        this.decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, duration: s.dur, data }));
      }
    }
    // Whole stream fed: flush now so the decoder releases the frames it holds for reordering,
    // instead of stalling the last frames of the clip until someone asks for them.
    if (this.nextFeed > samples.length - 1 && !this.eosFlushed && this.decoder?.state === 'configured') {
      this.eosFlushed = true;
      await this.decoder.flush().catch(() => undefined);
    }
  }


  close() {
    this.pending?.resolve(null);
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
  }
}

const decoders = new Map<string, ClipDecoder>();

async function decoderFor(key: string, hash: string): Promise<ClipDecoder> {
  const existing = decoders.get(key);
  if (existing && existing.hash === hash) return existing;
  existing?.close();
  const d = new ClipDecoder(hash, await source(hash));
  decoders.set(key, d);
  return d;
}

// Close decoders for clips that haven't been asked for in a while.
setInterval(() => {
  const now = performance.now();
  for (const [k, d] of decoders) {
    if (now - d.lastUsed > 10_000) {
      d.close();
      decoders.delete(k);
    }
  }
}, 2000);

scope.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data;
  if (m.t === 'release') {
    decoders.get(m.key)?.close();
    decoders.delete(m.key);
  } else if (m.t === 'preroll') {
    try {
      (await decoderFor(m.key, m.hash)).preroll(m.time);
    } catch {
      /* media missing */
    }
  } else if (m.t === 'cap') {
    cap = Math.max(8, m.frames);
  } else if (m.t === 'clear') {
    // Cold-start measurements: drop every decoded frame and decoder (parsed sample tables stay).
    decoders.forEach((d) => d.close());
    decoders.clear();
    cache.forEach((f) => f.close());
    cache.clear();
    cachedBytes = 0;
  } else if (m.t === 'invalidate') {
    // The stored file changed (more proxy chunks, or the original arrived): reload it.
    sources.delete(m.hash);
    for (const [k, d] of decoders) {
      if (d.hash !== m.hash) continue;
      d.close();
      decoders.delete(k);
    }
    for (const k of [...cache.keys()]) if (k.startsWith(`${m.hash}|`)) cacheDelete(k);
  } else if (m.t === 'stats') {
    scope.postMessage({ t: 'stats', id: m.id, cached: cache.size, decoders: decoders.size });
  } else if (m.t === 'frame') {
    try {
      const frame = await (await decoderFor(m.key, m.hash)).request(m.time);
      scope.postMessage({ t: 'frame', id: m.id, frame }, frame ? [frame] : []);
    } catch (err) {
      scope.postMessage({ t: 'frame', id: m.id, frame: null, error: String((err as Error).message ?? err) });
    }
  }
};
