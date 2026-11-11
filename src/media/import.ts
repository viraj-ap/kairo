import type * as Y from 'yjs';
import { addMedia, publishManifest, readMeta } from '../model/doc';
import type { MediaInfo } from '../model/schema';
import { buildManifest, hashBlob } from './manifest';
import { hasMedia, putMedia, saveManifestLocal } from './opfs';
import { kindOf, probe } from './probe';

export interface Imported {
  hash: string;
  info: MediaInfo;
}

/**
 * Hash → store in OPFS → probe → register in the room. Bytes never leave this device here.
 * Hashing streams the file in 1 MB chunks (whole-file SHA-256 plus the transfer manifest),
 * so importing a multi-GB file doesn't load it into memory.
 */
export async function importFile(doc: Y.Doc, file: File, src?: string): Promise<Imported> {
  if (!kindOf(file)) throw new Error(`${file.name}: unsupported file type`);
  const manifest = await buildManifest(file, (h) => h);
  const hash = manifest.hash;
  if (!(await hasMedia(hash))) await putMedia(hash, file);
  await saveManifestLocal(hash, manifest);
  publishManifest(doc, manifest);
  const existing = (doc.getMap('media').get(hash) as MediaInfo | undefined) ?? null;
  const info = existing ?? { ...(await probe(file, readMeta(doc).fps)), ...(src ? { src } : {}) };
  addMedia(doc, hash, info);
  return { hash, info };
}

/** Relink: a dropped file whose hash matches media already on the timeline. */
export async function relinkFile(file: File): Promise<string> {
  const hash = await hashBlob(file);
  await putMedia(hash, file);
  return hash;
}

export const DEMO_MEDIA = [
  { url: '/demo/aurora.mp4', name: 'Aurora.mp4' },
  { url: '/demo/fractal.mp4', name: 'Fractal.mp4' },
  { url: '/demo/life.mp4', name: 'Life.mp4' },
  { url: '/demo/drone.m4a', name: 'Drone.m4a' },
];

export async function fetchAsFile(url: string, name: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${name}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type });
}
