import { getFrame, releaseDecoder } from './decoderClient';
import { getMediaFile } from './opfs';
import type { MediaInfo } from '../model/schema';

const cache = new Map<string, Promise<string | null>>();

/** A small data-URL poster for the media library and timeline clips. */
export function getThumbnail(hash: string, info: MediaInfo): Promise<string | null> {
  let p = cache.get(hash);
  if (!p) {
    p = make(hash, info).catch(() => null);
    cache.set(hash, p);
    void p.then((u) => u || cache.delete(hash));
  }
  return p;
}

async function make(hash: string, info: MediaInfo): Promise<string | null> {
  if (info.kind === 'audio') return null;
  let source: VideoFrame | ImageBitmap | null = null;
  if (info.kind === 'image') {
    const f = await getMediaFile(hash);
    source = f ? await createImageBitmap(f) : null;
  } else {
    const key = `thumb:${hash}`;
    source = await getFrame(hash, key, Math.min(1, info.durationFrames / info.fps / 2));
    releaseDecoder(key);
  }
  if (!source) return null;
  const w = 240;
  const cw = 'displayWidth' in source ? source.displayWidth : source.width;
  const ch = 'displayHeight' in source ? source.displayHeight : source.height;
  const q = Math.round((info.rotation ?? 0) / 90) % 4;
  const [sw, sh] = q % 2 ? [ch, cw] : [cw, ch];
  const h = Math.round((w * sh) / sw);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((q * Math.PI) / 2);
  const [dw, dh] = q % 2 ? [h, w] : [w, h];
  ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
  source.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });
}
