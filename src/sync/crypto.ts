/**
 * End-to-end encryption for room traffic.
 *
 * A project has one random 256-bit secret, carried in the invite link's #fragment
 * (browsers never send fragments to servers). Per room (project + branch) we derive
 * with HKDF-SHA-256:
 *   - roomHash: the room's id on the server (so the server never sees code or branch names)
 *   - token:    proof of key possession for joining (the server stores only its SHA-256)
 *   - enc:      the AES-256-GCM key for every update, presence and signaling message
 *
 * Every message gets a unique 96-bit IV: a random 64-bit per-session prefix plus a
 * 32-bit counter. The AAD binds the ciphertext to its message type and room.
 */
import { IV_BYTES } from './protocol';

export interface RoomKeys {
  roomName: string;
  roomHash: string;
  roomHashBytes: Uint8Array;
  token: string;
  enc: CryptoKey;
}

const te = new TextEncoder();
/** WebCrypto wants ArrayBuffer-backed views; ours always are. */
const bs = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A new project secret (base64url, 43 chars). */
export function generateProjectKey(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isProjectKey(s: string): boolean {
  try {
    return fromB64url(s).byteLength === 32;
  } catch {
    return false;
  }
}

export async function deriveRoomKeys(projectKey: string, roomName: string): Promise<RoomKeys> {
  const raw = fromB64url(projectKey);
  if (raw.byteLength !== 32) throw new Error('Invalid project key');
  const base = await crypto.subtle.importKey('raw', bs(raw), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) });
  const roomHashBytes = new Uint8Array(await crypto.subtle.deriveBits(hkdf(`kairo/room-id/v1/${roomName}`), base, 256));
  const token = toB64url(new Uint8Array(await crypto.subtle.deriveBits(hkdf(`kairo/auth/v1/${roomName}`), base, 256)));
  const enc = await crypto.subtle.deriveKey(hkdf(`kairo/enc/v1/${roomName}`), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { roomName, roomHash: toHex(roomHashBytes), roomHashBytes, token, enc };
}

export class Sealer {
  private prefix = crypto.getRandomValues(new Uint8Array(8));
  private counter = 0;
  /** Every IV this session produced, for the IV-reuse test. Kept only when `trackIvs` is set. */
  readonly ivs: string[] | null;

  constructor(
    private keys: RoomKeys,
    trackIvs = false,
  ) {
    this.ivs = trackIvs ? [] : null;
  }

  private nextIv(): Uint8Array {
    if (this.counter >= 0xffffffff) {
      this.prefix = crypto.getRandomValues(new Uint8Array(8));
      this.counter = 0;
    }
    const iv = new Uint8Array(IV_BYTES);
    iv.set(this.prefix, 0);
    new DataView(iv.buffer).setUint32(8, this.counter++);
    this.ivs?.push(toHex(iv));
    return iv;
  }

  private aad(type: number): Uint8Array {
    const a = new Uint8Array(1 + this.keys.roomHashBytes.byteLength);
    a[0] = type;
    a.set(this.keys.roomHashBytes, 1);
    return a;
  }

  async seal(type: number, plain: Uint8Array): Promise<Uint8Array> {
    const iv = this.nextIv();
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(this.aad(type)) }, this.keys.enc, bs(plain)));
    const out = new Uint8Array(IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(ct, IV_BYTES);
    return out;
  }

  /** Throws if the message was tampered with, replayed into another room/type, or sealed with another key. */
  async open(type: number, body: Uint8Array): Promise<Uint8Array> {
    if (body.byteLength < IV_BYTES + 16) throw new Error('short message');
    const iv = body.subarray(0, IV_BYTES);
    const ct = body.subarray(IV_BYTES);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(this.aad(type)) }, this.keys.enc, bs(ct)));
  }
}
