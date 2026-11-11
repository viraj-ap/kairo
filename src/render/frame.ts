import type { RenderPlan } from '../engine';
import { getImage, getTextBitmap } from '../media/bitmaps';
import { getFrame, prerollFrame } from '../media/decoderClient';
import type { DrawItem } from './compositor';

let live = 0;
/** VideoFrames handed to the main thread and not yet released (leak detection in the soak test). */
export const liveFrameCount = () => live;

export interface Gathered {
  items: DrawItem[];
  release(): void;
}

/**
 * Fetch every layer's pixels for a plan. `slot` namespaces decoder instances, so
 * export and preview never fight over the same decoder.
 */
export async function gather(plan: RenderPlan, outHeight: number, slot: string): Promise<Gathered> {
  for (const p of plan.preroll) prerollFrame(p.mediaHash, slot + p.clipId, p.sourceTime);
  const results = await Promise.all(
    plan.layers.map(async (layer): Promise<DrawItem | null> => {
      if (layer.kind === 'text') return layer.props.text ? { layer, source: getTextBitmap(layer, outHeight) } : null;
      if (!layer.mediaHash) return null;
      if (layer.kind === 'image') {
        const bmp = await getImage(layer.mediaHash);
        return bmp && { layer, source: bmp };
      }
      const frame = await getFrame(layer.mediaHash, slot + layer.clipId, layer.sourceTime);
      return frame && { layer, source: frame };
    }),
  );
  const items = results.filter((x): x is DrawItem => !!x);
  const frames = items.filter((i) => i.source instanceof VideoFrame);
  live += frames.length;
  let released = false;
  return {
    items,
    release: () => {
      if (released) return;
      released = true;
      live -= frames.length;
      frames.forEach((i) => (i.source as VideoFrame).close());
    },
  };
}
