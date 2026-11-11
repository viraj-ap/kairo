import type { Layer } from '../engine';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Source = VideoFrame | ImageBitmap;

export interface DrawItem {
  layer: Layer;
  source: Source;
}

export interface Compositor {
  readonly kind: 'webgpu' | 'canvas2d';
  readonly canvas: AnyCanvas;
  /** Composite layers (bottom first) onto the canvas; resolves when the GPU work is submitted. */
  draw(items: DrawItem[]): Promise<void>;
  /** Resolves once drawn pixels are readable (e.g. for new VideoFrame(canvas)). */
  flush(): Promise<void>;
  destroy(): void;
}

export const EFFECTS = ['none', 'grayscale', 'sepia', 'invert', 'duotone', 'vignette', 'posterize', 'scanlines'] as const;

export function sourceSize(s: Source): [number, number] {
  return 'displayWidth' in s ? [s.displayWidth, s.displayHeight] : [s.width, s.height];
}

/**
 * Where a layer lands in output pixels. Media is fit inside the frame ("contain");
 * text bitmaps are already rasterized at output scale. x/y offset by a fraction of the frame.
 */
/** Quarter turns clockwise (0–3) to display a layer's source upright. */
export const quarterTurns = (layer: Layer) => (Math.round((layer.rotation ?? 0) / 90) % 4 + 4) % 4;

/** Where a layer lands in output pixels, in display orientation (rotation already applied). */
export function layerRect(layer: Layer, src: Source, outW: number, outH: number) {
  const [cw, ch] = sourceSize(src);
  const [sw, sh] = quarterTurns(layer) % 2 ? [ch, cw] : [cw, ch];
  const fit = layer.kind === 'text' ? 1 : Math.min(outW / sw, outH / sh);
  const w = sw * fit * layer.scale;
  const h = sh * fit * layer.scale;
  const cx = outW / 2 + layer.x * outW;
  const cy = outH / 2 + layer.y * outH;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
