/**
 * Kairo sync server: a Cloudflare Worker that serves the built app and routes
 * /sync/<roomHash> WebSockets to one Durable Object per room.
 *
 * The server is a blind relay. Room ids are HMACs of the room name, payloads are
 * AES-GCM ciphertext, and the auth token is derived from the room key, so the server
 * never sees project names, clip data, file names or the key itself.
 */
import { DurableObject } from 'cloudflare:workers';
import { CLOSE_BAD_KEY, CLOSE_TOO_LARGE, MAX_FRAME, PING, PONG, T, readU32, s2c, u32 } from '../../src/sync/protocol';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  /** "1" enables /debug/room/<hash> (stored + relayed bytes) for the security tests. Never set in production. */
  KAIRO_DEBUG?: string;
  /** Cloudflare Realtime TURN key (dashboard → Realtime → TURN). Set both as secrets to relay P2P media through TURN. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const ROOM_RE = /^[0-9a-f]{64}$/;
const COMPACT_AFTER = 200;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const sync = url.pathname.match(/^\/sync\/([0-9a-f]+)$/);
    if (sync) {
      if (!ROOM_RE.test(sync[1])) return new Response('bad room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(sync[1])).fetch(req);
    }
    const ice = url.pathname.match(/^\/ice\/([0-9a-f]+)$/);
    if (ice) {
      if (!ROOM_RE.test(ice[1])) return new Response('bad room', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(ice[1])).fetch(req);
    }
    const debug = url.pathname.match(/^\/debug\/room\/([0-9a-f]{64})$/);
    if (debug) {
      if (env.KAIRO_DEBUG !== '1') return new Response('not found', { status: 404 });
      return env.ROOMS.get(env.ROOMS.idFromName(debug[1])).fetch(new Request('https://room/debug'));
    }
    if (url.pathname === '/healthz') return new Response('ok');
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

type IceServer = { urls: string | string[]; username?: string; credential?: string };
const ICE_TTL = 4 * 3600;
const FALLBACK_ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/**
 * ICE servers for peer-to-peer media. With a Cloudflare TURN key, mints short-lived TURN
 * credentials (the relay only ever carries DTLS-encrypted bytes); otherwise STUN only, which
 * works across most home NATs but not symmetric NATs, VPNs or two browsers behind one VPN.
 */
async function iceServers(env: Env): Promise<{ iceServers: IceServer[]; ttl: number; turn: boolean }> {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: ICE_TTL }),
      });
      if (!res.ok) throw new Error(`TURN credentials: HTTP ${res.status}`);
      const { iceServers } = (await res.json()) as { iceServers: IceServer[] };
      // Browsers block port 53; without filtering, those URLs only add timeouts.
      const servers = iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }));
      return { iceServers: servers, ttl: ICE_TTL, turn: true };
    } catch (e) {
      console.error('[ice]', (e as Error).message);
    }
  }
  return { iceServers: FALLBACK_ICE, ttl: ICE_TTL, turn: false };
}

interface Attachment {
  conn: number;
}

export class Room extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.sql.exec(`CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS debug_frames (id INTEGER PRIMARY KEY AUTOINCREMENT, conn INTEGER, data BLOB NOT NULL)`);
  }

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === '/debug') return this.debugDump();
    if (new URL(req.url).pathname.startsWith('/ice/')) return this.ice(req);

    // Trust on first use: the first client fixes the room's token hash. The token is
    // derived from the room key, so a client with a different key is refused.
    const token = new URL(req.url).searchParams.get('t') ?? '';
    const hash = await sha256Hex(token);
    const saved = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'token'`).toArray()[0]?.v;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (token.length < 32 || (saved && saved !== hash)) {
      server.accept();
      server.close(CLOSE_BAD_KEY, 'wrong room key');
      return new Response(null, { status: 101, webSocket: client });
    }
    const conn = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ conn } satisfies Attachment);
    if (!saved) this.sql.exec(`INSERT INTO meta (k, v) VALUES ('token', ?)`, hash);

    server.send(s2c(T.WELCOME, conn));
    let last = 0;
    for (const row of this.sql.exec<{ seq: number; data: ArrayBuffer }>(`SELECT seq, data FROM updates ORDER BY seq`)) {
      server.send(s2c(T.UPDATE, 0, new Uint8Array(row.data)));
      last = row.seq;
    }
    server.send(s2c(T.HISTORY_END, 0, u32(last)));
    this.broadcast(s2c(T.PEER_JOINED, conn), server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string') return;
    if (message.byteLength > MAX_FRAME) return ws.close(CLOSE_TOO_LARGE, 'frame too large');
    const { conn } = ws.deserializeAttachment() as Attachment;
    const frame = new Uint8Array(message);
    const type = frame[0];
    const body = frame.subarray(1);
    if (this.env.KAIRO_DEBUG === '1') this.sql.exec(`INSERT INTO debug_frames (conn, data) VALUES (?, ?)`, conn, frame);

    switch (type) {
      case T.UPDATE: {
        this.sql.exec(`INSERT INTO updates (data) VALUES (?)`, body);
        this.broadcast(s2c(T.UPDATE, conn, body), ws);
        const { n, max } = this.sql.exec<{ n: number; max: number }>(`SELECT COUNT(*) AS n, MAX(seq) AS max FROM updates`).one();
        if (n > COMPACT_AFTER) ws.send(s2c(T.COMPACT, 0, u32(max)));
        break;
      }
      case T.AWARENESS:
      case T.EVENT:
        this.broadcast(s2c(type, conn, body), ws);
        break;
      case T.SNAPSHOT: {
        // The client encrypted its full state after receiving every update ≤ seq.
        const seq = readU32(body);
        const data = body.subarray(4);
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`DELETE FROM updates WHERE seq <= ?`, seq);
          this.sql.exec(`INSERT INTO updates (seq, data) VALUES (?, ?)`, seq, data);
        });
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const { conn } = ws.deserializeAttachment() as Attachment;
    // Complete the close handshake so the client's socket closes promptly.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
    this.broadcast(s2c(T.PEER_LEFT, conn), ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011);
  }

  private broadcast(frame: Uint8Array, except?: WebSocket) {
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      try {
        s.send(frame);
      } catch {
        /* closing */
      }
    }
  }

  /** TURN credentials only for clients holding this room's key (same token check as the socket). */
  private async ice(req: Request): Promise<Response> {
    const token = new URL(req.url).searchParams.get('t') ?? '';
    const saved = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'token'`).toArray()[0]?.v;
    if (token.length < 32 || !saved || saved !== (await sha256Hex(token))) return new Response('forbidden', { status: 403 });
    return Response.json(await iceServers(this.env), { headers: { 'Cache-Control': 'no-store' } });
  }

  private debugDump(): Response {
    const stored = this.sql.exec<{ seq: number; data: ArrayBuffer }>(`SELECT seq, data FROM updates ORDER BY seq`).toArray();
    const frames = this.sql.exec<{ conn: number; data: ArrayBuffer }>(`SELECT conn, data FROM debug_frames ORDER BY id`).toArray();
    const meta = this.sql.exec<{ k: string; v: string }>(`SELECT k, v FROM meta`).toArray();
    return Response.json({
      meta,
      stored: stored.map((r) => ({ seq: r.seq, data: b64(new Uint8Array(r.data)) })),
      frames: frames.map((r) => ({ conn: r.conn, data: b64(new Uint8Array(r.data)) })),
    });
  }
}
