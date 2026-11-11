import type { Layer } from '../engine';
import { getMediaFile } from './opfs';

/** Decoded still images, by media hash. */
const images = new Map<string, Promise<ImageBitmap | null>>();

export function getImage(hash: string): Promise<ImageBitmap | null> {
  let p = images.get(hash);
  if (!p) {
    p = getMediaFile(hash).then((f) => (f ? createImageBitmap(f) : null)).catch(() => null);
    images.set(hash, p);
    void p.then((b) => b || images.delete(hash));
  }
  return p;
}

/** Text layers are rasterized once per distinct text + style and reused across frames. */
const texts = new Map<string, ImageBitmap>();
const TEXT_CACHE_MAX = 64;

/** Font sizes are authored in pixels at 1080p and scaled to the output height. */
export function getTextBitmap(layer: Layer, outHeight: number): ImageBitmap {
  const p = layer.props;
  const size = Math.round((p.fontSize ?? 96) * (outHeight / 1080));
  const weight = p.fontWeight ?? 700;
  const color = p.color ?? '#ffffff';
  const bg = p.background ?? '';
  const text = p.text ?? '';
  const key = [text, size, weight, color, bg].join('\u0000');
  const hit = texts.get(key);
  if (hit) return hit;

  const font = `${weight} ${size}px Inter, system-ui, sans-serif`;
  const lines = text.split('\n');
  const measure = new OffscreenCanvas(1, 1).getContext('2d')!;
  measure.font = font;
  const lineH = Math.ceil(size * 1.2);
  const pad = bg ? Math.ceil(size * 0.4) : Math.ceil(size * 0.1);
  const w = Math.max(1, Math.ceil(Math.max(...lines.map((l) => measure.measureText(l).width))) + pad * 2);
  const h = Math.max(1, lineH * lines.length + pad * 2);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, size * 0.25);
    ctx.fill();
  }
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (!bg) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = size * 0.12;
  }
  lines.forEach((l, i) => ctx.fillText(l, w / 2, pad + lineH * (i + 0.5)));
  const bmp = canvas.transferToImageBitmap();
  if (texts.size >= TEXT_CACHE_MAX) {
    const [k, b] = texts.entries().next().value!;
    b.close();
    texts.delete(k);
  }
  texts.set(key, bmp);
  return bmp;
}
