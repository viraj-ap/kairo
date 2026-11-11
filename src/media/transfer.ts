/**
 * Media sync: proxies, chunked peer-to-peer transfer and selective sync.
 *
 * Every stored file (an original, or its 540p `<hash>.proxy`) is described by a manifest of
 * 1 MB chunk hashes published in the encrypted room doc. A device missing a file:
 *   1. asks the room who holds it ("need", encrypted broadcast) and connects to up to 2 holders
 *      over WebRTC (signaling also through the room, strictly in order);
 *   2. pulls chunks from them in parallel — at most 4 in flight per peer — choosing chunks by
 *      priority: proxy header, then ±10 s around the playhead, then the rest of the proxy,
 *      then originals in the background (re-ranked whenever the playhead moves);
 *   3. verifies every chunk against its hash and stores it in OPFS by index, so a transfer
 *      resumes from the chunks still missing after a disconnect or reload;
 *   4. verifies the whole-file hash at the end.
 * The device holding an original generates the proxy and publishes both manifests.
 */
import type { MediaInfo } from '../model/schema';
import type { SyncProvider } from '../sync/types';
import { demux, headerChunks, timeIndex } from './mp4';
import { buildManifest, chunkCountOf, chunkHashes, hashBlob, proxyKey, sha256Hex, type Manifest } from './manifest';
import { deleteChunk, getMediaFile, listChunks, removeChunks, loadManifestLocal, openChunks, putMedia, readChunkFile, saveManifestLocal, writeChunk } from './opfs';
import { chunkScores, chunksForPlayback, nextChunk } from './priority';
import { generateProxy, PROXY_THRESHOLD_HEIGHT } from './proxyClient';
import { fetchAsFile } from './import';

export type MediaState = 'ready' | 'missing' | 'fetching' | 'error';

/** Availability of an original on this device. */
export interface MediaStatus {
  state: MediaState;
  progress?: number;
  /** Where the bytes came from: already on this device, a collaborator (WebRTC), or a public URL. */
  via?: 'local' | 'peer' | 'url';
}

/** Availability of an original's 540p proxy on this device. */
export interface ProxyStatus {
  state: 'none' | 'generating' | 'partial' | 'ready';
  progress: number;
  /** Header + the 10 s at the playhead are here: the proxy can start playing. */
  playable: boolean;
}

export interface TransferStats {
  /** Chunks this device served to peers, per key. */
  served: Record<string, number>;
  /** Indices served, in order, per key (to audit re-sends). */
  servedLog: Record<string, number[]>;
  /** Chunks received and stored, per key. */
  received: Record<string, number>;
  /** Requests for chunks that were already stored (should stay 0: resume never re-fetches). */
  rerequestedStored: number;
  /** Chunks that were in flight when a connection dropped and had to be requested again. */
  retriedInflight: number;
  /** When each key became playable / complete (performance.now()). */
  playableAt: Record<string, number>;
  completeAt: Record<string, number>;
  firstChunkAt: Record<string, number>;
  /** Chunk indices in the order they arrived, per key (selective-sync verification). */
  order: Record<string, number[]>;
  /** Chunks received from each peer. */
  receivedFrom: Record<string, number>;
  /** Chunks that arrived when already stored or being written (wasted transfer; should be 0). */
  duplicates: number;
}

type Signal =
  | { k: 'kairo-media'; type: 'need'; keys: string[]; from: string }
  | { k: 'kairo-media'; type: 'have'; keys: string[]; from: string; to: string }
  | { k: 'kairo-media'; type: 'dial'; from: string; to: string }
  | { k: 'kairo-media'; type: 'offer' | 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { k: 'kairo-media'; type: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit };

const MAX_PEERS = 2;
const INFLIGHT_PER_PEER = 4;
const FRAGMENT = 60 * 1024; // DataChannel messages stay well under SCTP limits
const HIGH_WATER = 4 << 20;
const DISCOVERY_MS = 3000;

/**
 * ICE servers: VITE_ICE_SERVERS (a JSON RTCIceServer[] baked in at build time, e.g. your own
 * coturn) plus whatever the sync server hands out at runtime (/ice: Cloudflare TURN when
 * configured, else STUN). With none, peers only connect via host candidates: one machine or LAN.
 */
let runtimeIce: RTCIceServer[] = [];
function iceConfig(): RTCConfiguration {
  let built: RTCIceServer[] = [];
  try {
    const raw = import.meta.env?.VITE_ICE_SERVERS as string | undefined;
    built = raw ? JSON.parse(raw) : [];
  } catch {
    /* malformed: ignore */
  }
  return { iceServers: [...built, ...runtimeIce] };
}
const ICE_WAIT_MS = 4000;
/** A connection that hasn't opened by now never will (ICE normally gives up at ~15 s). */
const LINK_OPEN_MS = 20_000;

// ---- one WebRTC connection per remote peer, shared by all transfers ---------------------

interface PendingChunk {
  key: string;
  index: number;
  buf: Uint8Array;
  got: number;
  resolve: (d: Uint8Array) => void;
  reject: (e: Error) => void;
}

class Link {
  readonly pc: RTCPeerConnection;
  private ch: RTCDataChannel | null = null;
  private queuedIce: RTCIceCandidateInit[] = [];
  private pending = new Map<number, PendingChunk>();
  private nextReq = 1;
  private serving: Promise<void> = Promise.resolve();
  closed = false;
  /** The data channel opened at least once (so a close isn't a failure to connect). */
  everOpened = false;
  /** Chunks this side has requested from the peer and not yet received, per key. */
  inflight = new Map<string, Set<number>>();
  readonly opened: Promise<void>;
  private resolveOpen!: () => void;

  constructor(
    readonly peer: string,
    private sync: MediaSync,
    initiator: boolean,
  ) {
    this.pc = new RTCPeerConnection(iceConfig());
    this.opened = new Promise((r) => (this.resolveOpen = r));
    this.pc.onicecandidate = (e) => e.candidate && sync.signal({ type: 'ice', to: peer, candidate: e.candidate.toJSON() });
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(this.pc.connectionState)) this.close();
    };
    if (initiator) this.attach(this.pc.createDataChannel('kairo-media', { ordered: true }));
    else this.pc.ondatachannel = (e) => this.attach(e.channel);
    setTimeout(() => !this.everOpened && this.close(), LINK_OPEN_MS);
  }

  private attach(ch: RTCDataChannel) {
    this.ch = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 1 << 20;
    ch.onopen = () => {
      this.everOpened = true;
      this.resolveOpen();
    };
    ch.onclose = () => this.close();
    ch.onmessage = (e) => (typeof e.data === 'string' ? this.onControl(JSON.parse(e.data)) : this.onData(e.data as ArrayBuffer));
  }

  async offer() {
    const o = await this.pc.createOffer();
    await this.pc.setLocalDescription(o);
    this.sync.signal({ type: 'offer', to: this.peer, sdp: o });
  }

  async onOffer(sdp: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(sdp);
    const a = await this.pc.createAnswer();
    await this.pc.setLocalDescription(a);
    this.flushIce();
    this.sync.signal({ type: 'answer', to: this.peer, sdp: a });
  }

  async onAnswer(sdp: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(sdp);
    this.flushIce();
  }

  async onIce(c: RTCIceCandidateInit) {
    if (this.pc.remoteDescription) await this.pc.addIceCandidate(c).catch(() => undefined);
    else this.queuedIce.push(c);
  }

  private flushIce() {
    this.queuedIce.splice(0).forEach((c) => void this.pc.addIceCandidate(c).catch(() => undefined));
  }

  get isOpen(): boolean {
    return !this.closed && this.ch?.readyState === 'open';
  }

  inflightCount(): number {
    let n = 0;
    this.inflight.forEach((s) => (n += s.size));
    return n;
  }

  /** Ask the peer for one chunk; resolves with its bytes (not yet verified). */
  request(key: string, index: number, size: number): Promise<Uint8Array> {
    if (!this.ch || this.ch.readyState !== 'open') return Promise.reject(new Error('link not open'));
    const r = this.nextReq++;
    const set = this.inflight.get(key) ?? new Set();
    set.add(index);
    this.inflight.set(key, set);
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(r, { key, index, buf: new Uint8Array(size), got: 0, resolve, reject });
      this.ch!.send(JSON.stringify({ t: 'get', r, key, i: index }));
    });
  }

  /** The caller has taken over the chunk (or given up on it): no longer in flight on this link. */
  release(key: string, index: number) {
    this.inflight.get(key)?.delete(index);
  }

  private onControl(m: { t: string; r: number; key: string; i: number }) {
    if (m.t === 'get') this.serving = this.serving.then(() => this.serve(m.r, m.key, m.i)).catch(() => undefined);
    else if (m.t === 'nak') {
      const p = this.pending.get(m.r);
      this.pending.delete(m.r);
      p?.reject(new Error('peer does not have this chunk'));
    }
  }

  private onData(data: ArrayBuffer) {
    const v = new DataView(data);
    const r = v.getUint32(0);
    const offset = v.getUint32(4);
    const p = this.pending.get(r);
    if (!p) return;
    const payload = new Uint8Array(data, 8);
    p.buf.set(payload, offset);
    p.got += payload.byteLength;
    if (p.got >= p.buf.byteLength) {
      this.pending.delete(r);
      p.resolve(p.buf);
    }
  }

  /** Send one chunk as 60 KB fragments, pausing while the channel's buffer is full. */
  private async serve(r: number, key: string, index: number) {
    const ch = this.ch;
    if (!ch || ch.readyState !== 'open') return;
    const data = await this.sync.readLocalChunk(key, index);
    if (!data) {
      ch.send(JSON.stringify({ t: 'nak', r }));
      return;
    }
    for (let off = 0; off < data.byteLength; off += FRAGMENT) {
      if (ch.readyState !== 'open') return;
      if (ch.bufferedAmount > HIGH_WATER) await new Promise((res) => ch.addEventListener('bufferedamountlow', res, { once: true }));
      const piece = data.subarray(off, off + FRAGMENT);
      const frame = new Uint8Array(8 + piece.byteLength);
      const v = new DataView(frame.buffer);
      v.setUint32(0, r);
      v.setUint32(4, off);
      frame.set(piece, 8);
      ch.send(frame);
    }
    this.sync.stats.served[key] = (this.sync.stats.served[key] ?? 0) + 1;
    (this.sync.stats.servedLog[key] ??= []).push(index);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending.forEach((p) => p.reject(new Error('link closed')));
    this.pending.clear();
    try {
      this.ch?.close();
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.sync.onLinkClosed(this);
  }
}

// ---- one incoming file ----------------------------------------------------------------

class Transfer {
  hashes: string[] = [];
  present = new Set<number>();
  /** Received, now being verified and written: neither in flight nor stored, but must not be re-requested. */
  writing = new Set<number>();
  scores: Float64Array = new Float64Array();
  ready = false;
  done = false;
  failed = false;

  constructor(
    readonly manifest: Manifest,
    readonly media: string,
    readonly isProxy: boolean,
  ) {}

  get count() {
    return chunkCountOf(this.manifest);
  }

  /** Load what's already stored; a chunk that doesn't match its hash is discarded and refetched. */
  async init() {
    this.hashes = chunkHashes(this.manifest);
    await openChunks(this.manifest.key, { size: this.manifest.size, chunkSize: this.manifest.chunkSize });
    for (const i of await listChunks(this.manifest.key)) {
      const blob = await readChunkFile(this.manifest.key, i);
      if (blob && (await sha256Hex(new Uint8Array(await blob.arrayBuffer()))) === this.hashes[i]) this.present.add(i);
      else await deleteChunk(this.manifest.key, i);
    }
    this.ready = true;
  }

  rescore(windows: number[]) {
    this.scores = chunkScores(this.count, this.manifest.timeIndex, windows, this.isProxy, this.manifest.headerChunks);
  }

  inflight(links: Iterable<Link>): Set<number> {
    const s = new Set<number>(this.writing);
    for (const l of links) l.inflight.get(this.manifest.key)?.forEach((i) => s.add(i));
    return s;
  }

  playable(window: number): boolean {
    if (!this.isProxy || !this.manifest.timeIndex) return this.present.size === this.count;
    return chunksForPlayback(this.count, this.manifest.timeIndex, window, this.manifest.headerChunks).every((c) => this.present.has(c));
  }
}

// ---- the coordinator ------------------------------------------------------------------

export interface MediaSyncHooks {
  onChange(originals: Record<string, MediaStatus>, proxies: Record<string, ProxyStatus>): void;
  /** A stored file changed (chunks arrived, original or proxy completed): reload decoders. */
  onStored(hash: string): void;
  publishManifest(m: Manifest): void;
  /** A peer connection failed before it ever opened (no usable ICE route between the two browsers). */
  onPeerUnreachable?(): void;
}

export class MediaSync {
  readonly peerId = crypto.randomUUID();
  readonly stats: TransferStats = { served: {}, servedLog: {}, received: {}, rerequestedStored: 0, retriedInflight: 0, playableAt: {}, completeAt: {}, firstChunkAt: {}, order: {}, receivedFrom: {}, duplicates: 0 };
  private status = new Map<string, MediaStatus>();
  private proxies = new Map<string, ProxyStatus>();
  private media: Record<string, MediaInfo> = {};
  private manifests: Record<string, Manifest> = {};
  /** Keys whose complete file is on this device and matches the room's manifest. */
  private held = new Set<string>();
  private transfers = new Map<string, Transfer>();
  private links = new Map<string, Link>();
  private holders = new Map<string, Set<string>>();
  private signals: Promise<void> = Promise.resolve();
  private local: Promise<void> = Promise.resolve();
  private checked = new Set<string>();
  private windowsFor: (hash: string) => number[] = () => [0];
  private priorityOriginals = new Set<string>();
  private discovery: number;
  private off: () => void;
  private destroyed = false;
  private iceReady: Promise<void> = Promise.resolve();
  private iceRefresh = 0;
  private unreachableReported = false;
  private localBlobs = new Map<string, Promise<Blob | null>>();
  /** Test controls: don't offer originals (only proxies), and delay each served chunk. */
  testing = { holdOriginals: false, serveDelayMs: 0, noFetch: !!(globalThis as { __kairoNoFetch?: boolean }).__kairoNoFetch };

  constructor(
    private provider: SyncProvider,
    private hooks: MediaSyncHooks,
  ) {
    this.off = provider.onBroadcast((m) => {
      if ((m as Signal)?.k !== 'kairo-media') return;
      // Strict order: ICE candidates must never overtake their offer.
      this.signals = this.signals.then(() => this.handle(m as Signal)).catch((e) => console.warn('[media]', e));
    });
    this.discovery = window.setInterval(() => this.discover(), DISCOVERY_MS);
  }

  /** Fetch ICE servers (and refresh them before the credentials expire); links wait briefly for them. */
  useIce(load: () => Promise<{ iceServers: RTCIceServer[]; ttl: number }>) {
    const run = () =>
      load()
        .then(({ iceServers, ttl }) => {
          runtimeIce = iceServers;
          clearTimeout(this.iceRefresh);
          if (!this.destroyed) this.iceRefresh = window.setTimeout(run, Math.max(60, ttl * 0.8) * 1000);
        })
        .catch((e) => console.warn('[media] ICE servers unavailable:', (e as Error).message));
    this.iceReady = Promise.race([run(), new Promise<void>((r) => setTimeout(r, ICE_WAIT_MS))]);
  }

  snapshot(): Record<string, MediaStatus> {
    return Object.fromEntries(this.status);
  }

  proxySnapshot(): Record<string, ProxyStatus> {
    return Object.fromEntries(this.proxies);
  }

  private emit() {
    this.hooks.onChange(this.snapshot(), this.proxySnapshot());
  }

  private setStatus(hash: string, s: MediaStatus) {
    this.status.set(hash, s);
    this.emit();
  }

  private setProxy(hash: string, p: Partial<ProxyStatus>) {
    const cur = this.proxies.get(hash) ?? { state: 'none', progress: 0, playable: false };
    this.proxies.set(hash, { ...cur, ...p });
    this.emit();
  }

  /** Source-time positions (seconds) where each media is needed first: the playhead. */
  setPlayheadWindows(fn: (hash: string) => number[]) {
    this.windowsFor = fn;
  }

  /** The playhead moved: re-rank what to fetch next. */
  reprioritize() {
    for (const t of this.transfers.values()) if (t.ready && !t.done) t.rescore(this.windowsFor(t.media));
    this.refreshPlayable();
    this.pump();
  }

  /** Look at the room's media and manifests; fetch, generate or publish what's needed. */
  sync(media: Record<string, MediaInfo>, manifests: Record<string, Manifest>) {
    this.media = media;
    this.manifests = manifests;
    for (const hash of Object.keys(media)) {
      if (!this.checked.has(hash)) {
        this.checked.add(hash);
        this.local = this.local.then(() => this.checkLocal(hash)).catch((e) => console.warn('[media]', e));
      }
    }
    this.local = this.local.then(() => this.ensureTransfers());
  }

  /** What this device already has for `hash`; holders generate and publish what's missing. */
  private async checkLocal(hash: string) {
    const original = await getMediaFile(hash);
    if (original) {
      this.held.add(hash);
      if (!this.status.has(hash)) this.setStatus(hash, { state: 'ready', via: 'local' });
      await this.ensureManifest(hash, original, false);
      await this.ensureProxy(hash);
    } else if (!this.status.has(hash)) {
      this.setStatus(hash, { state: 'missing' });
    }
    const proxy = await getMediaFile(proxyKey(hash));
    if (proxy) {
      const m = this.manifests[proxyKey(hash)];
      // Only serve a proxy that is the one the room agreed on (first published wins).
      if (!m || m.hash === (await this.ensureManifest(hash, proxy, true))?.hash) this.held.add(proxyKey(hash));
      this.setProxy(hash, { state: 'ready', progress: 1, playable: true });
    }
  }

  private async ensureManifest(hash: string, blob: Blob, proxy: boolean): Promise<Manifest | null> {
    const key = proxy ? proxyKey(hash) : hash;
    let m = this.manifests[key] ?? (await loadManifestLocal<Manifest>(key));
    if (!m) {
      m = await buildManifest(blob, () => key);
      if (proxy) {
        const d = await demux(blob);
        m.timeIndex = timeIndex(d, m.chunkSize);
        m.headerChunks = headerChunks(d, m.chunkSize);
      }
      if (!proxy && m.hash !== hash) throw new Error(`stored file ${hash} has a different hash`);
    }
    await saveManifestLocal(key, m);
    if (!this.manifests[key]) this.hooks.publishManifest(m);
    return m;
  }

  /** The original's holder makes the 540p proxy (once per room). */
  private async ensureProxy(hash: string) {
    const info = this.media[hash];
    if (!info || info.kind !== 'video' || Math.min(info.width, info.height) <= PROXY_THRESHOLD_HEIGHT) return;
    if (this.manifests[proxyKey(hash)] || (await getMediaFile(proxyKey(hash)))) return;
    this.setProxy(hash, { state: 'generating', progress: 0 });
    try {
      await generateProxy(hash, (p) => this.setProxy(hash, { state: 'generating', progress: p }));
      const blob = await getMediaFile(proxyKey(hash));
      if (blob) {
        await this.ensureManifest(hash, blob, true);
        this.held.add(proxyKey(hash));
        this.setProxy(hash, { state: 'ready', progress: 1, playable: true });
      }
    } catch (e) {
      console.warn('[proxy]', e);
      this.setProxy(hash, { state: 'none', progress: 0 });
    }
  }

  /** A local import or relink put the original in OPFS. */
  markReady(hash: string, via: MediaStatus['via'] = 'local') {
    this.held.add(hash);
    const t = this.transfers.get(hash);
    if (t) {
      t.done = true;
      // A partial download is now redundant: free the space.
      void removeChunks(hash);
    }
    // With the original here, a proxy still downloading is no longer needed.
    const pt = this.transfers.get(proxyKey(hash));
    if (pt && !this.held.has(proxyKey(hash))) pt.done = true;
    this.setStatus(hash, { state: 'ready', via });
    this.hooks.onStored(hash);
    this.checked.add(hash);
    this.local = this.local.then(async () => {
      const blob = await getMediaFile(hash);
      if (blob) await this.ensureManifest(hash, blob, false);
      await this.ensureProxy(hash);
    });
  }

  /** Start (or resume) transfers for whatever this device is missing. Proxy before original. */
  private async ensureTransfers() {
    if (this.testing.noFetch) return;
    for (const hash of Object.keys(this.media)) {
      if (this.held.has(hash)) continue;
      const pm = this.manifests[proxyKey(hash)];
      const proxyDone = !pm || this.held.has(proxyKey(hash));
      if (pm && !proxyDone) await this.startTransfer(pm, hash, true);
      const om = this.manifests[hash];
      if (om && (proxyDone || this.priorityOriginals.has(hash))) await this.startTransfer(om, hash, false);
      if (this.media[hash]?.src) this.urlFallback(hash);
    }
    this.discover();
    this.pump();
  }

  private async startTransfer(m: Manifest, hash: string, isProxy: boolean) {
    if (this.transfers.has(m.key)) return;
    const t = new Transfer(m, hash, isProxy);
    this.transfers.set(m.key, t);
    await t.init();
    t.rescore(this.windowsFor(hash));
    if (t.present.size === t.count) await this.finish(t);
    else this.progress(t);
  }

  private urlTried = new Set<string>();
  /**
   * Demo media has a public URL: use it whenever no peer is actually delivering the file
   * (no holder, or no connection to one). Peers that are connected keep priority.
   */
  private urlFallback(hash: string) {
    if (this.urlTried.has(hash)) return;
    this.urlTried.add(hash);
    const tick = async () => {
      if (this.destroyed || this.held.has(hash)) return;
      if ([hash, proxyKey(hash)].some((k) => this.linkedHolders(k).some((l) => l.isOpen))) {
        setTimeout(tick, 5000);
        return;
      }
      this.setStatus(hash, { state: 'fetching', via: 'url' });
      try {
        const file = await fetchAsFile(this.media[hash].src!, this.media[hash].name);
        if ((await hashBlob(file)) !== hash) throw new Error('hash mismatch');
        await putMedia(hash, file);
        this.markReady(hash, 'url');
      } catch {
        this.setStatus(hash, { state: 'missing' });
        this.urlTried.delete(hash); // try again on the next pass
      }
    };
    setTimeout(tick, 2500);
  }

  /** Export needs originals: fetch them now (ahead of remaining proxy work). */
  async requestOriginals(hashes: string[]): Promise<void> {
    hashes.forEach((h) => this.priorityOriginals.add(h));
    this.local = this.local.then(() => this.ensureTransfers());
    await this.local;
    await new Promise<void>((resolve) => {
      const check = () => (hashes.every((h) => this.held.has(h)) ? resolve() : setTimeout(check, 250));
      check();
    });
  }

  // ---- discovery & connections ----------------------------------------------------------

  private wantedKeys(): string[] {
    return [...this.transfers.values()].filter((t) => !t.done).map((t) => t.manifest.key);
  }

  private discover() {
    if (this.destroyed) return;
    const keys = this.wantedKeys().filter((k) => this.linkedHolders(k).length < MAX_PEERS);
    if (keys.length) this.signal({ type: 'need', keys });
    for (const key of this.wantedKeys()) this.connectHolders(key);
    this.pump();
  }

  private linkedHolders(key: string): Link[] {
    return [...(this.holders.get(key) ?? [])].map((p) => this.links.get(p)).filter((l): l is Link => !!l && !l.closed);
  }

  private connectHolders(key: string) {
    const holders = [...(this.holders.get(key) ?? [])];
    let linked = this.linkedHolders(key).length;
    for (const peer of holders) {
      if (linked >= MAX_PEERS) break;
      if (this.links.has(peer)) continue;
      this.link(peer);
      linked++;
    }
  }

  /** Lower peer id makes the offer, so two peers never dial each other at once. */
  private link(peer: string) {
    if (this.peerId < peer) {
      const l = new Link(peer, this, true);
      this.links.set(peer, l);
      void this.iceReady.then(() => l.offer());
      void l.opened.then(() => this.pump());
    } else {
      this.signal({ type: 'dial', to: peer });
    }
  }

  signal(body: Record<string, unknown>) {
    this.provider.broadcast({ k: 'kairo-media', from: this.peerId, ...body });
  }

  private async handle(m: Signal) {
    if (m.from === this.peerId || this.destroyed) return;
    if (m.type === 'need') {
      const have = m.keys.filter((k) => this.held.has(k) && !(this.testing.holdOriginals && !k.endsWith('.proxy')));
      if (have.length) this.signal({ type: 'have', keys: have, to: m.from });
      return;
    }
    if (m.to !== this.peerId) return;
    switch (m.type) {
      case 'have':
        for (const k of m.keys) {
          const s = this.holders.get(k) ?? new Set();
          s.add(m.from);
          this.holders.set(k, s);
          this.connectHolders(k);
        }
        // We may already be connected to this peer (e.g. for the proxy): start pulling now.
        this.pump();
        break;
      case 'dial':
        await this.iceReady;
        if (!this.links.has(m.from)) {
          const l = new Link(m.from, this, true);
          this.links.set(m.from, l);
          void l.opened.then(() => this.pump());
          await l.offer();
        }
        break;
      case 'offer': {
        let l = this.links.get(m.from);
        if (!l || l.closed) {
          await this.iceReady;
          l = new Link(m.from, this, false);
          this.links.set(m.from, l);
          void l.opened.then(() => this.pump());
        }
        await l.onOffer(m.sdp);
        break;
      }
      case 'answer':
        await this.links.get(m.from)?.onAnswer(m.sdp);
        break;
      case 'ice':
        await this.links.get(m.from)?.onIce(m.candidate);
        break;
    }
  }

  onLinkClosed(l: Link) {
    if (!l.everOpened && !this.destroyed && !this.unreachableReported) {
      this.unreachableReported = true;
      this.hooks.onPeerUnreachable?.();
    }
    if (this.links.get(l.peer) === l) this.links.delete(l.peer);
    this.holders.forEach((s) => s.delete(l.peer));
    this.pump();
  }

  /** Test hook: drop every peer connection (simulates a network loss mid-transfer). */
  dropPeers() {
    [...this.links.values()].forEach((l) => l.close());
  }

  async readLocalChunk(key: string, index: number): Promise<Uint8Array | null> {
    if (!this.held.has(key)) return null;
    if (this.testing.holdOriginals && !key.endsWith('.proxy')) return null;
    if (this.testing.serveDelayMs) await new Promise((r) => setTimeout(r, this.testing.serveDelayMs));
    let p = this.localBlobs.get(key);
    if (!p) this.localBlobs.set(key, (p = getMediaFile(key)));
    const blob = await p;
    const m = this.manifests[key];
    if (!blob || !m) return null;
    return new Uint8Array(await blob.slice(index * m.chunkSize, (index + 1) * m.chunkSize).arrayBuffer());
  }

  // ---- scheduling -------------------------------------------------------------------

  /** Fill every open link's request slots with the most urgent missing chunks. */
  private pump() {
    if (this.destroyed) return;
    const active = [...this.transfers.values()].filter((t) => t.ready && !t.done && !t.failed);
    // Proxies first; originals only when nothing proxy-related is waiting.
    active.sort((a, b) => Number(b.isProxy) - Number(a.isProxy));
    for (const t of active) {
      for (const l of this.linkedHolders(t.manifest.key)) {
        if (!l.isOpen) continue;
        while (l.inflightCount() < INFLIGHT_PER_PEER) {
          const i = nextChunk(t.scores, t.present, t.inflight(this.links.values()));
          if (i < 0) break;
          if (t.present.has(i)) this.stats.rerequestedStored++;
          void this.fetchChunk(t, l, i);
        }
      }
    }
  }

  private async fetchChunk(t: Transfer, l: Link, i: number) {
    const size = Math.min(t.manifest.chunkSize, t.manifest.size - i * t.manifest.chunkSize);
    let data: Uint8Array;
    try {
      data = await l.request(t.manifest.key, i, size);
      if (t.present.has(i) || t.writing.has(i)) {
        this.stats.duplicates++;
        l.release(t.manifest.key, i);
        return;
      }
      t.writing.add(i); // hand-off in one synchronous step: never neither in flight nor writing
      l.release(t.manifest.key, i);
    } catch {
      l.release(t.manifest.key, i);
      this.stats.retriedInflight++;
      this.pump();
      return;
    }
    try {
      // The file may have become available another way meanwhile (e.g. imported locally).
      if (t.done || this.held.has(t.manifest.key)) return;
      if ((await sha256Hex(data)) !== t.hashes[i]) {
        console.warn('[media] chunk failed verification', t.manifest.key, i);
        return;
      }
      await writeChunk(t.manifest.key, i, data);
      t.present.add(i);
    } finally {
      t.writing.delete(i);
      if (!t.present.has(i)) this.pump();
    }
    this.stats.firstChunkAt[t.manifest.key] ??= performance.now();
    this.stats.received[t.manifest.key] = (this.stats.received[t.manifest.key] ?? 0) + 1;
    (this.stats.order[t.manifest.key] ??= []).push(i);
    this.stats.receivedFrom[l.peer] = (this.stats.receivedFrom[l.peer] ?? 0) + 1;
    if (t.present.size === t.count) await this.finish(t);
    else this.progress(t);
    this.pump();
  }

  private lastStoredSignal = new Map<string, number>();

  private progress(t: Transfer) {
    if (t.done) return;
    const frac = t.present.size / t.count;
    if (t.isProxy) {
      const playable = t.playable(this.windowsFor(t.media)[0] ?? 0);
      if (playable) this.stats.playableAt[t.manifest.key] ??= performance.now();
      this.setProxy(t.media, { state: 'partial', progress: frac, playable });
      // Let the decoder see new proxy chunks (throttled; immediately once it becomes playable).
      const last = this.lastStoredSignal.get(t.media) ?? 0;
      if (playable && performance.now() - last > 1000) {
        this.lastStoredSignal.set(t.media, performance.now());
        this.hooks.onStored(t.media);
      }
    } else {
      this.setStatus(t.media, { state: 'fetching', progress: frac, via: 'peer' });
    }
  }

  private refreshPlayable() {
    for (const t of this.transfers.values()) if (t.isProxy && !t.done && t.ready) this.progress(t);
  }

  private async finish(t: Transfer) {
    t.done = true;
    const blob = await getMediaFile(t.manifest.key);
    const ok = !!blob && (await hashBlob(blob)) === t.manifest.hash;
    if (!ok) {
      t.failed = true;
      if (t.isProxy) this.setProxy(t.media, { state: 'none' });
      else this.setStatus(t.media, { state: 'error' });
      return;
    }
    this.stats.completeAt[t.manifest.key] = performance.now();
    await saveManifestLocal(t.manifest.key, t.manifest);
    this.held.add(t.manifest.key);
    if (t.isProxy) {
      this.stats.playableAt[t.manifest.key] ??= performance.now();
      this.setProxy(t.media, { state: 'ready', progress: 1, playable: true });
      this.local = this.local.then(() => this.ensureTransfers()); // now the original
    } else {
      this.setStatus(t.media, { state: 'ready', via: 'peer' });
    }
    this.hooks.onStored(t.media);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.iceRefresh);
    this.off();
    clearInterval(this.discovery);
    [...this.links.values()].forEach((l) => l.close());
  }
}
