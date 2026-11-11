import { layerRect, quarterTurns, type AnyCanvas, type Compositor, type DrawItem } from './compositor';

const FILTERS: Record<string, string> = {
  grayscale: 'grayscale(1)',
  sepia: 'sepia(1)',
  invert: 'invert(1)',
  duotone: 'grayscale(1) sepia(1) hue-rotate(110deg) saturate(3)',
  posterize: 'contrast(1.6) saturate(1.4)',
};

/** Fallback when WebGPU isn't available. Same layout math; effects approximated with CSS filters. */
export function createCanvas2DCompositor(canvas: AnyCanvas): Compositor {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  return {
    kind: 'canvas2d',
    canvas,
    async draw(items: DrawItem[]) {
      const W = canvas.width;
      const H = canvas.height;
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      for (const { layer, source } of items) {
        const r = layerRect(layer, source, W, H);
        const p = layer.props;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        const filters = [
          p.brightness ? `brightness(${1 + p.brightness})` : '',
          p.contrast != null && p.contrast !== 1 ? `contrast(${p.contrast})` : '',
          p.saturation != null && p.saturation !== 1 ? `saturate(${p.saturation})` : '',
          FILTERS[p.effect ?? ''] ?? '',
        ].filter(Boolean);
        ctx.filter = filters.join(' ') || 'none';
        if (layer.reveal < 1) {
          ctx.beginPath();
          ctx.rect(r.x, r.y, r.w * layer.reveal, r.h);
          ctx.clip();
        }
        const q = quarterTurns(layer);
        if (q) {
          // Source stored rotated: draw it turned clockwise into the display rect.
          ctx.save();
          ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
          ctx.rotate((q * Math.PI) / 2);
          const [w, h] = q % 2 ? [r.h, r.w] : [r.w, r.h];
          ctx.drawImage(source, -w / 2, -h / 2, w, h);
          ctx.restore();
        } else ctx.drawImage(source, r.x, r.y, r.w, r.h);
        if (p.effect === 'vignette') {
          const g = ctx.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.3, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 0.7);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, 'rgba(0,0,0,0.85)');
          ctx.filter = 'none';
          ctx.fillStyle = g;
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        ctx.restore();
      }
    },
    flush: async () => undefined,
    destroy() {},
  };
}
