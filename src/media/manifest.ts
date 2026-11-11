/**
 * Transfer manifests. A manifest describes one stored file (an original or its proxy) as
 * 1 MB chunks: whole-file SHA-256, size, and each chunk's SHA-256. Manifests live in the
 * room's Yjs doc, so they reach collaborators end-to-end encrypted like every other edit.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { toHex } from '../lib/hash';

export const CHUNK_SIZE = 1 << 20;

export interface Manifest {
  /** Storage key: `<sha256>` or `<sha256>.proxy`. */
  key: string;
  /** SHA-256 of the whole file. For originals this equals the media's content address. */
  hash: string;
  size: number;
  chunkSize: number;
  /** Concatenated 32-byte chunk hashes, base64. */
  chunks: string;
  /**
   * Proxies only: for each second of media, the [first, last] chunk holding its samples
   * (from the keyframe before it), flattened. Used to fetch what the playhead needs first.
   */
  timeIndex?: number[];
  /** Proxies only: chunks covering everything before the first media sample (moov etc.). */
  headerChunks?: number;
}

export const chunkCountOf = (m: Pick<Manifest, 'size' | 'chunkSize'>) => Math.ceil(m.size / m.chunkSize);

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** All chunk hashes as hex (decode once per transfer). */
export function chunkHashes(m: Manifest): string[] {
  const raw = atob(m.chunks);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 32) {
    let h = '';
    for (let j = i; j < i + 32; j++) h += raw.charCodeAt(j).toString(16).padStart(2, '0');
    out.push(h);
  }
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

/**
 * One streaming pass over the file: whole-file SHA-256 (incremental, so a 1 GB file never
 * sits in memory) plus every chunk's SHA-256.
 */
export async function buildManifest(blob: Blob, keyOf: (hash: string) => string, onProgress?: (done: number, total: number) => void): Promise<Manifest> {
  const whole = nobleSha256.create();
  const n = Math.ceil(blob.size / CHUNK_SIZE);
  const hashes = new Uint8Array(n * 32);
  for (let i = 0; i < n; i++) {
    const buf = new Uint8Array(await blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer());
    whole.update(buf);
    hashes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), i * 32);
    onProgress?.(i + 1, n);
  }
  const hash = toHex(whole.digest().buffer as ArrayBuffer);
  return { key: keyOf(hash), hash, size: blob.size, chunkSize: CHUNK_SIZE, chunks: b64(hashes) };
}

/** Streaming SHA-256 of a whole Blob. */
export async function hashBlob(blob: Blob): Promise<string> {
  const h = nobleSha256.create();
  for (let pos = 0; pos < blob.size; pos += 8 * CHUNK_SIZE) h.update(new Uint8Array(await blob.slice(pos, pos + 8 * CHUNK_SIZE).arrayBuffer()));
  return toHex(h.digest().buffer as ArrayBuffer);
}

export const proxyKey = (hash: string) => `${hash}.proxy`;
