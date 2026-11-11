import { EFFECTS, layerRect, quarterTurns, type AnyCanvas, type Compositor, type DrawItem } from './compositor';

const SHADER = /* wgsl */ `
struct U {
  rect: vec4f,    // x0, y0, x1, y1 in clip space
  params: vec4f,  // opacity, reveal, effect id, output height
  adj: vec4f,     // brightness, contrast, saturation, -
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texExt: texture_external;
@group(0) @binding(3) var tex2d: texture_2d<f32>;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) src: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var corners = array(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(1, 1));
  let p = corners[i];
  var o: VO;
  o.uv = p;
  // Display → coded texture coordinates for sources stored rotated (adj.w = clockwise quarter turns).
  let q = i32(u.adj.w + 0.5);
  if (q == 1) { o.src = vec2f(p.y, 1.0 - p.x); }
  else if (q == 2) { o.src = vec2f(1.0 - p.x, 1.0 - p.y); }
  else if (q == 3) { o.src = vec2f(1.0 - p.y, p.x); }
  else { o.src = p; }
  o.pos = vec4f(mix(u.rect.x, u.rect.z, p.x), mix(u.rect.y, u.rect.w, p.y), 0.0, 1.0);
  return o;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn finish(src: vec4f, uv: vec2f, fragY: f32) -> vec4f {
  if (uv.x > u.params.y) { discard; }
  var c = src.rgb;
  c = c + u.adj.x;
  c = (c - 0.5) * u.adj.y + 0.5;
  c = mix(vec3f(luma(c)), c, u.adj.z);
  let fx = i32(u.params.z + 0.5);
  if (fx == 1) { c = vec3f(luma(c)); }
  else if (fx == 2) { let l = luma(c); c = vec3f(l * 1.07, l * 0.88, l * 0.66); }
  else if (fx == 3) { c = 1.0 - c; }
  else if (fx == 4) { c = mix(vec3f(0.06, 0.07, 0.45), vec3f(0.1, 1.0, 0.55), luma(c)); }
  else if (fx == 5) { let d = distance(uv, vec2f(0.5)); c = c * smoothstep(0.85, 0.3, d); }
  else if (fx == 6) { c = floor(c * 5.0) / 4.0; }
  else if (fx == 7) { c = c * (0.75 + 0.25 * step(0.5, fract(fragY / max(2.0, u.params.w / 270.0)))); }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), src.a * u.params.x);
}

@fragment fn fsExt(in: VO) -> @location(0) vec4f {
  return finish(textureSampleBaseClampToEdge(texExt, samp, in.src), in.uv, in.pos.y);
}

@fragment fn fs2d(in: VO) -> @location(0) vec4f {
  return finish(textureSample(tex2d, samp, in.src), in.uv, in.pos.y);
}
`;

let devicePromise: Promise<GPUDevice | null> | null = null;

export function getDevice(): Promise<GPUDevice | null> {
  devicePromise ??= (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      return (await adapter?.requestDevice()) ?? null;
    } catch {
      return null;
    }
  })();
  return devicePromise;
}

export async function createWebGPUCompositor(canvas: AnyCanvas): Promise<Compositor | null> {
  const device = await getDevice();
  const ctx = device && (canvas.getContext('webgpu') as GPUCanvasContext | null);
  if (!device || !ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const module = device.createShaderModule({ code: SHADER });
  const blend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const pipeline = (entryPoint: string) =>
    device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint, targets: [{ format, blend }] },
      primitive: { topology: 'triangle-strip' },
    });
  const extPipeline = pipeline('fsExt');
  const texPipeline = pipeline('fs2d');
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const uniforms: GPUBuffer[] = [];
  const textures = new WeakMap<ImageBitmap, GPUTexture>();

  const uniform = (i: number) =>
    (uniforms[i] ??= device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));

  const bitmapTexture = (bmp: ImageBitmap) => {
    let t = textures.get(bmp);
    if (!t) {
      t = device.createTexture({
        size: [bmp.width, bmp.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture({ source: bmp }, { texture: t, premultipliedAlpha: false }, [bmp.width, bmp.height]);
      textures.set(bmp, t);
    }
    return t;
  };

  return {
    kind: 'webgpu',
    canvas,
    async draw(items: DrawItem[]) {
      const W = canvas.width;
      const H = canvas.height;
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      items.forEach(({ layer, source }, i) => {
        const r = layerRect(layer, source, W, H);
        const p = layer.props;
        const data = new Float32Array([
          (r.x / W) * 2 - 1, 1 - (r.y / H) * 2, ((r.x + r.w) / W) * 2 - 1, 1 - ((r.y + r.h) / H) * 2,
          layer.opacity, layer.reveal, Math.max(0, EFFECTS.indexOf((p.effect ?? 'none') as never)), H,
          p.brightness ?? 0, p.contrast ?? 1, p.saturation ?? 1, quarterTurns(layer),
        ]);
        const buf = uniform(i);
        device.queue.writeBuffer(buf, 0, data);
        const isFrame = source instanceof VideoFrame;
        const pipe = isFrame ? extPipeline : texPipeline;
        const resource = isFrame ? device.importExternalTexture({ source }) : bitmapTexture(source).createView();
        const group = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: buf } },
            { binding: 1, resource: sampler },
            { binding: isFrame ? 2 : 3, resource },
          ],
        });
        pass.setPipeline(pipe);
        pass.setBindGroup(0, group);
        pass.draw(4);
      });
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    flush: () => device.queue.onSubmittedWorkDone(),
    destroy() {
      ctx.unconfigure();
      uniforms.forEach((b) => b.destroy());
    },
  };
}
