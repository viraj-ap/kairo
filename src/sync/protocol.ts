/**
 * Kairo sync wire protocol, shared by the browser client and the Durable Object relay.
 *
 * Client → server:  [type u8][body]
 * Server → client:  [type u8][sender conn u32 BE][body]
 *
 * For UPDATE / AWARENESS / EVENT / SNAPSHOT the body is end-to-end encrypted:
 *   [iv 12 bytes][AES-GCM ciphertext + tag]       (SNAPSHOT prefixes a u32 seq)
 * The server never holds the key; it only stores and relays these opaque bytes.
 */

export const T = {
  UPDATE: 1, // Yjs update — persisted and relayed
  AWARENESS: 2, // presence — relayed only
  EVENT: 3, // app broadcast (WebRTC signaling) — relayed only
  SNAPSHOT: 4, // client-built compacted state replacing stored updates ≤ seq
  COMPACT: 17, // server asks a client for a SNAPSHOT covering seq
  PEER_LEFT: 18,
  PEER_JOINED: 19,
  HISTORY_END: 20, // all stored updates have been sent
  WELCOME: 21, // tells the client its own conn id
} as const;

/** Close code the server uses when the room key's auth token doesn't match. */
export const CLOSE_BAD_KEY = 4003;
export const CLOSE_TOO_LARGE = 4009;

export const MAX_FRAME = 1 << 20;

/** Text-frame heartbeat, answered by the runtime without waking the Durable Object. */
export const PING = 'ping';
export const PONG = 'pong';
export const IV_BYTES = 12;
export const HEADER_S2C = 5;

export function c2s(type: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + body.byteLength);
  out[0] = type;
  out.set(body, 1);
  return out;
}

export function s2c(type: number, conn: number, body: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_S2C + body.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, conn >>> 0);
  out.set(body, HEADER_S2C);
  return out;
}

export function parseS2C(buf: ArrayBuffer | Uint8Array): { type: number; conn: number; body: Uint8Array } {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return { type: u[0], conn: new DataView(u.buffer, u.byteOffset).getUint32(1), body: u.subarray(HEADER_S2C) };
}

export function u32(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

export const readU32 = (b: Uint8Array, at = 0) => new DataView(b.buffer, b.byteOffset).getUint32(at);
