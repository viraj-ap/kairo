import type { TimelineEngine } from '../engine';
import { createCanvas2DCompositor } from './canvas2d';
import { gather } from './frame';

/** Render one frame to a PNG (2D path, so it doesn't depend on the preview's swap chain). */
export async function snapshotPng(engine: TimelineEngine, frame: number, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const comp = createCanvas2DCompositor(canvas);
  const g = await gather(engine.renderPlan(frame, 0), height, 'snap:');
  await comp.draw(g.items);
  g.release();
  return canvas.convertToBlob({ type: 'image/png' });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
