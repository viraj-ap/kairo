/**
 * Media bytes live in the Origin Private File System, addressed by a key: the file's
 * SHA-256, or `<sha256>.proxy` for its preview proxy.
 *
 * Two layouts:
 *  - `media/<key>`          a single complete file (local imports, locally generated proxies)
 *  - `media/<key>.chunks/`  one file per 1 MB chunk (`0`, `1`, …) for peer transfers. Chunks are
 *                           written once and never modified, so a partially transferred file can
 *                           be read (and played) while more chunks arrive, and a transfer resumes
 *                           by listing which chunks exist.
 */

const DIR = 'media';

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function chunkDir(key: string, create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await dir()).getDirectoryHandle(`${key}.chunks`, { create });
  } catch {
    return null;
  }
}

export interface ChunkLayout {
  size: number;
  chunkSize: number;
}

const chunkCount = (l: ChunkLayout) => Math.ceil(l.size / l.chunkSize);

async function singleFile(key: string): Promise<File | null> {
  try {
    return await (await (await dir()).getFileHandle(key)).getFile();
  } catch {
    return null;
  }
}

async function readLayout(d: FileSystemDirectoryHandle): Promise<ChunkLayout | null> {
  try {
    return JSON.parse(await (await (await d.getFileHandle('layout.json')).getFile()).text());
  } catch {
    return null;
  }
}

/** Indices of the chunks stored for `key` (empty if none). */
export async function listChunks(key: string): Promise<Set<number>> {
  const d = await chunkDir(key);
  const out = new Set<number>();
  if (!d) return out;
  for await (const name of (d as unknown as { keys(): AsyncIterable<string> }).keys()) {
    if (/^\d+$/.test(name)) out.add(Number(name));
  }
  return out;
}

/** The complete file for `key`, from either layout, or null if it isn't fully present. */
export async function getMediaFile(key: string): Promise<Blob | null> {
  const single = await singleFile(key);
  if (single) return single;
  // Cheap completeness check (a directory listing) before opening every chunk.
  const d = await chunkDir(key);
  const layout = d && (await readLayout(d));
  if (!layout || (await listChunks(key)).size < chunkCount(layout)) return null;
  const p = await getPartial(key);
  return p && p.complete ? p.blob : null;
}

export async function hasMedia(key: string): Promise<boolean> {
  return (await getMediaFile(key)) !== null;
}

const zeroChunks = new Map<number, Blob>();
const zeros = (n: number) => {
  let z = zeroChunks.get(n);
  if (!z) zeroChunks.set(n, (z = new Blob([new Uint8Array(n)])));
  return z;
};

export interface PartialFile {
  /** The file with missing chunks zero-filled (no memory is used for the gaps). */
  blob: Blob;
  present: Set<number>;
  layout: ChunkLayout;
  complete: boolean;
  /** Are all bytes in [start, end) present? */
  has(start: number, end: number): boolean;
}

/** Whatever is stored for `key`, complete or not. */
export async function getPartial(key: string): Promise<PartialFile | null> {
  const single = await singleFile(key);
  if (single) {
    const layout = { size: single.size, chunkSize: 1 << 20 };
    return { blob: single, present: new Set(Array.from({ length: chunkCount(layout) }, (_, i) => i)), layout, complete: true, has: () => true };
  }
  const d = await chunkDir(key);
  if (!d) return null;
  const layout = await readLayout(d);
  if (!layout) return null;
  const n = chunkCount(layout);
  const present = new Set<number>();
  const parts: Blob[] = [];
  for (let i = 0; i < n; i++) {
    const len = Math.min(layout.chunkSize, layout.size - i * layout.chunkSize);
    let part: Blob | null = null;
    try {
      const f = await (await d.getFileHandle(String(i))).getFile();
      if (f.size === len) part = f;
    } catch {
      /* missing */
    }
    if (part) present.add(i);
    parts.push(part ?? zeros(len));
  }
  return {
    blob: new Blob(parts),
    present,
    layout,
    complete: present.size === n,
    has(start, end) {
      for (let i = Math.floor(start / layout.chunkSize); i * layout.chunkSize < end; i++) if (!present.has(i)) return false;
      return true;
    },
  };
}

export async function putMedia(key: string, data: Blob | BufferSource) {
  const handle = await (await dir()).getFileHandle(key, { create: true });
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

/** Prepare chunked storage for an incoming transfer (idempotent). */
export async function openChunks(key: string, layout: ChunkLayout) {
  const d = (await chunkDir(key, true))!;
  if (!(await readLayout(d))) {
    const w = await (await d.getFileHandle('layout.json', { create: true })).createWritable();
    await w.write(JSON.stringify(layout));
    await w.close();
  }
}

/** Store one verified chunk. Written to a temp name and renamed, so a crash never leaves a short chunk. */
export async function writeChunk(key: string, index: number, data: Uint8Array) {
  const d = (await chunkDir(key, true))!;
  const tmp = await d.getFileHandle(`${index}.tmp`, { create: true });
  const w = await tmp.createWritable();
  await w.write(data as Uint8Array<ArrayBuffer>);
  await w.close();
  await (tmp as unknown as { move(name: string): Promise<void> }).move(String(index));
}

export async function readChunkFile(key: string, index: number): Promise<Blob | null> {
  const d = await chunkDir(key);
  if (!d) return null;
  try {
    return await (await d.getFileHandle(String(index))).getFile();
  } catch {
    return null;
  }
}

export async function deleteChunk(key: string, index: number) {
  await (await chunkDir(key))?.removeEntry(String(index)).catch(() => undefined);
}

/** Manifests are cached next to the files they describe, so they never need re-hashing. */
export async function saveManifestLocal(key: string, manifest: unknown) {
  await putMedia(`${key}.manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
}

export async function loadManifestLocal<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await (await (await (await dir()).getFileHandle(`${key}.manifest.json`)).getFile()).text());
  } catch {
    return null;
  }
}

/** Remove a partial (or superseded) chunked copy of `key`. */
export async function removeChunks(key: string) {
  await (await dir()).removeEntry(`${key}.chunks`, { recursive: true }).catch(() => undefined);
}
