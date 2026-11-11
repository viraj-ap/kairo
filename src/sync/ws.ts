import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { CLOSE_BAD_KEY, PING, T, c2s, parseS2C, readU32, u32 } from './protocol';
import { Sealer, type RoomKeys } from './crypto';
import type { SyncProvider, SyncStatus } from './types';

export interface WsProviderOptions {
  /** ws:// or wss:// origin of the Kairo server. */
  url: string;
  keys: RoomKeys | Promise<RoomKeys>;
  /** Record every IV used (tests only). */
  trackIvs?: boolean;
  /** How long to wait for the server before opening from local state only. */
  syncTimeoutMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Client ids inside an encoded awareness update, so we can drop them when their connection leaves. */
function awarenessClientIds(update: Uint8Array): number[] {
  const d = decoding.createDecoder(update);
  const n = decoding.readVarUint(d);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(decoding.readVarUint(d));
    decoding.readVarUint(d);
    decoding.readVarString(d);
  }
  return ids;
}

/**
 * Yjs sync over a WebSocket to Kairo's own relay, end-to-end encrypted.
 *
 * On (re)connect the server replays its stored (encrypted) updates; we rebuild what the
 * server has in a scratch doc and send only what it's missing. Offline edits therefore
 * merge on reconnect with no special queue.
 */
export class WsProvider implements SyncProvider {
  readonly mode = 'server' as const;
  readonly awareness: Awareness;
  readonly whenSynced: Promise<void>;
  readonly stats = { sent: 0, received: 0, rejected: 0, reconnects: 0 };
  sealer: Sealer | null = null;
  keys: RoomKeys | null = null;

  private ws: WebSocket | null = null;
  private st: SyncStatus = 'connecting';
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private listeners = new Set<(m: unknown) => void>();
  private history: Y.Doc | null = null;
  private peers = new Map<number, Set<number>>();
  private outQ: Promise<void> = Promise.resolve();
  private inQ: Promise<void> = Promise.resolve();
  private backoff = 500;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private resolveSynced!: () => void;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;

  constructor(
    readonly doc: Y.Doc,
    private opts: WsProviderOptions,
  ) {
    this.awareness = new Awareness(doc);
    this.whenSynced = new Promise((r) => (this.resolveSynced = r));
    setTimeout(() => this.resolveSynced(), opts.syncTimeoutMs ?? 5000);
    doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('online', this.onOnline);
    }
    void Promise.resolve(opts.keys).then((keys) => {
      this.keys = keys;
      this.sealer = new Sealer(keys, opts.trackIvs);
      this.connect();
    });
  }

  status(): SyncStatus {
    return this.st;
  }

  onStatus(cb: (s: SyncStatus) => void) {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  broadcast(msg: unknown) {
    if (this.st === 'connected') this.send(T.EVENT, enc.encode(JSON.stringify(msg)));
  }

  onBroadcast(cb: (m: unknown) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setStatus(s: SyncStatus) {
    if (this.st === s) return;
    this.st = s;
    this.statusListeners.forEach((cb) => cb(s));
  }

  private connect() {
    if (this.closed || !this.keys) return;
    this.setStatus('connecting');
    const ws = new WebSocket(`${this.opts.url}/sync/${this.keys.roomHash}?t=${this.keys.token}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.history = new Y.Doc();
    ws.onopen = () => {
      this.backoff = 500;
      this.lastHeard = Date.now();
      this.startHeartbeat(ws);
    };
    ws.onmessage = (e) => {
      this.lastHeard = Date.now();
      if (typeof e.data === 'string') return; // pong
      const data = e.data as ArrayBuffer;
      this.inQ = this.inQ.then(() => this.receive(ws, data)).catch((err) => console.warn('[sync]', err));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      if (e.code === CLOSE_BAD_KEY) {
        this.drop(ws, 'rejected');
        this.resolveSynced();
        return;
      }
      this.drop(ws, 'offline');
      this.scheduleReconnect();
    };
  }

  /**
   * Forget a socket right away rather than waiting for its close handshake, which may never
   * finish when the network is gone.
   */
  private drop(ws: WebSocket, status: SyncStatus) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.history?.destroy();
    this.history = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    ws.onclose = ws.onmessage = ws.onopen = null;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    this.dropRemotePresence();
    this.setStatus(status);
  }

  /** A silent connection (no frames, no pong) for 12 s is treated as dead. */
  private startHeartbeat(ws: WebSocket) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.ws !== ws) return;
      if (Date.now() - this.lastHeard > 12_000) {
        this.drop(ws, 'offline');
        this.scheduleReconnect();
        return;
      }
      try {
        ws.send(PING);
      } catch {
        /* closing */
      }
    }, 5000);
  }

  private scheduleReconnect() {
    if (this.closed || this.timer) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // wait for 'online'
    this.timer = setTimeout(() => {
      this.timer = null;
      this.stats.reconnects++;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10_000);
  }

  private onOffline = () => {
    if (this.ws) this.drop(this.ws, 'offline');
  };

  private onOnline = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.backoff = 500;
    if (!this.ws) this.connect();
  };

  private async open(type: number, body: Uint8Array): Promise<Uint8Array | null> {
    try {
      return await this.sealer!.open(type, body);
    } catch {
      this.stats.rejected++;
      return null;
    }
  }

  private async receive(ws: WebSocket, data: ArrayBuffer) {
    if (this.ws !== ws) return;
    const { type, conn, body } = parseS2C(data);
    this.stats.received++;
    switch (type) {
      case T.UPDATE: {
        const plain = await this.open(T.UPDATE, body);
        if (!plain) return;
        if (this.history && conn === 0) Y.applyUpdate(this.history, plain);
        Y.applyUpdate(this.doc, plain, this);
        break;
      }
      case T.HISTORY_END: {
        // Send exactly what the server is missing (edits made offline or before connecting).
        const sv = Y.encodeStateVector(this.history ?? new Y.Doc());
        this.history?.destroy();
        this.history = null;
        const missing = Y.encodeStateAsUpdate(this.doc, sv);
        this.setStatus('connected');
        if (missing.byteLength > 2) this.send(T.UPDATE, missing);
        this.sendAwareness();
        this.resolveSynced();
        break;
      }
      case T.AWARENESS: {
        const plain = await this.open(T.AWARENESS, body);
        if (!plain) return;
        const ids = this.peers.get(conn) ?? new Set();
        awarenessClientIds(plain).forEach((id) => ids.add(id));
        this.peers.set(conn, ids);
        applyAwarenessUpdate(this.awareness, plain, this);
        break;
      }
      case T.EVENT: {
        const plain = await this.open(T.EVENT, body);
        if (!plain) return;
        const msg = JSON.parse(dec.decode(plain));
        this.listeners.forEach((cb) => cb(msg));
        break;
      }
      case T.COMPACT: {
        // Stored as an UPDATE row, so it's sealed with the UPDATE AAD.
        const seq = readU32(body);
        const sealed = await this.sealer!.seal(T.UPDATE, Y.encodeStateAsUpdate(this.doc));
        const payload = new Uint8Array(4 + sealed.byteLength);
        payload.set(u32(seq), 0);
        payload.set(sealed, 4);
        this.outQ = this.outQ.then(() => (this.ws === ws ? ws.send(c2s(T.SNAPSHOT, payload)) : undefined));
        break;
      }
      case T.PEER_JOINED:
        this.sendAwareness();
        break;
      case T.PEER_LEFT: {
        const ids = this.peers.get(conn);
        if (ids) removeAwarenessStates(this.awareness, [...ids], this);
        this.peers.delete(conn);
        break;
      }
    }
  }

  /** Messages are sealed and sent strictly in order. */
  private send(type: number, plain: Uint8Array) {
    this.outQ = this.outQ.then(async () => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || !this.sealer) return;
      const sealed = await this.sealer.seal(type, plain);
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(c2s(type, sealed));
      this.stats.sent++;
    });
  }

  private sendAwareness() {
    if (this.awareness.getLocalState() !== null) this.send(T.AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Until history has been replayed, the reconnect diff covers local edits.
    if (origin !== this && this.st === 'connected') this.send(T.UPDATE, update);
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this || this.st !== 'connected') return;
    const mine = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
    if (mine.length) this.send(T.AWARENESS, encodeAwarenessUpdate(this.awareness, mine));
  };

  private dropRemotePresence() {
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length) removeAwarenessStates(this.awareness, others, this);
    this.peers.clear();
  }

  /** Simulate a network drop (tests). */
  disconnect() {
    this.closed = true;
    if (this.ws) this.drop(this.ws, 'offline');
  }

  reconnect() {
    this.closed = false;
    if (!this.ws) this.connect();
  }

  destroy() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('online', this.onOnline);
    }
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    if (this.heartbeat) clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = null;
    void this.outQ.then(() => ws?.close());
    this.awareness.destroy();
  }
}
