import { support } from '../lib/support';
import { createCanvas2DCompositor } from './canvas2d';
import type { AnyCanvas, Compositor } from './compositor';
import { createWebGPUCompositor } from './webgpu';

export async function createCompositor(canvas: AnyCanvas, prefer: 'webgpu' | 'canvas2d' = 'webgpu'): Promise<Compositor> {
  if (prefer === 'webgpu' && support.webgpu) {
    const gpu = await createWebGPUCompositor(canvas).catch(() => null);
    if (gpu) return gpu;
  }
  return createCanvas2DCompositor(canvas);
}

export type { Compositor, DrawItem } from './compositor';
