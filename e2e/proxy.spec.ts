import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { closeAll, openEditor, twoUsers } from './helpers';

// Phase A: proxies, chunked resumable transfer, multi-peer and selective sync.
// Every test uses isolated browser contexts against the real server (wrangler dev).

type K = {
  __kairo: {
    doc: { getMap(n: string): { keys(): Iterable<string>; get(k: string): unknown; toJSON(): Record<string, unknown> } };
    media: {
      snapshot(): Record<string, { state: string; via?: string; progress?: number }>;
      proxySnapshot(): Record<string, { state: string; playable: boolean; progress: number }>;
      stats: { served: Record<string, number>; received: Record<string, number>; rerequestedStored: number; order: Record<string, number[]>; receivedFrom: Record<string, number> };
      testing: { holdOriginals: boolean; serveDelayMs: number };
    };
    seek(f: number): void;
    addMediaClip(hash: string, frame?: number): string | null;
  };
  __kairoDecoder: { getFrame(hash: string, key: string, t: number): Promise<VideoFrame | null> };
};

async function importFile(page: Page, path: string): Promise<string> {
  const before = await page.locator('.tile').count();
  await page.locator('.left-panel input[type=file]').setInputFiles(path);
  await expect(page.locator('.tile')).toHaveCount(before + 1, { timeout: 60_000 });
  return page.evaluate(() => {
    const keys = [...(window as unknown as K).__kairo.doc.getMap('media').keys()];
    return keys[keys.length - 1];
  });
}

const media = (p: Page, hash: string) => p.evaluate((h) => (window as unknown as K).__kairo.media.snapshot()[h] ?? null, hash);
const proxy = (p: Page, hash: string) => p.evaluate((h) => (window as unknown as K).__kairo.media.proxySnapshot()[h] ?? null, hash);
const testing = (p: Page, t: Partial<K['__kairo']['media']['testing']>) => p.evaluate((t) => Object.assign((window as unknown as K).__kairo.media.testing, t), t);

function ffprobeJson(file: string, args: string[]) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', file]).toString());
}

test('A1: a 720p import gets a 540p H.264 proxy, keyframe every 30 frames, with the original audio', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto('/');
  await a.getByRole('button', { name: 'New project' }).first().click();
  await expect(a.locator('.timeline')).toBeVisible();
  const hash = await importFile(a, 'public/demo/aurora.mp4');
  await expect.poll(() => proxy(a, hash).then((p) => p?.state), { timeout: 60_000 }).toBe('ready');

  const bytes = await a.evaluate(async (h) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('media');
    return [...new Uint8Array(await (await (await dir.getFileHandle(`${h}.proxy`)).getFile()).arrayBuffer())];
  }, hash);
  mkdirSync('e2e/.out', { recursive: true });
  const file = 'e2e/.out/proxy-aurora.mp4';
  writeFileSync(file, Buffer.from(bytes));

  const streams = ffprobeJson(file, ['-show_entries', 'stream=codec_name,codec_type,width,height,duration']).streams;
  const v = streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const au = streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  expect(v.codec_name).toBe('h264');
  expect(v.height).toBe(540);
  expect(v.width).toBe(960);
  expect(au?.codec_name).toBe('aac');
  const orig = ffprobeJson('public/demo/aurora.mp4', ['-show_entries', 'stream=duration,codec_type']).streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  expect(Math.abs(Number(v.duration) - Number(orig.duration))).toBeLessThan(0.1);

  const frames = ffprobeJson(file, ['-select_streams', 'v:0', '-show_entries', 'frame=key_frame']).frames as { key_frame: number }[];
  const keys = frames.map((f, i) => (f.key_frame ? i : -1)).filter((i) => i >= 0);
  expect(keys.length).toBeGreaterThan(1);
  for (const k of keys) expect(k % 30, `keyframe at frame ${k}`).toBe(0);
  for (let i = 0; i < frames.length; i += 30) expect(keys).toContain(i);
  await ctx.close();
});

test('A1: B edits on the proxy (badge, frame-accurate) while the original is held back; export fetches the original first', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await testing(a, { holdOriginals: true });
  const hash = await importFile(a, 'public/demo/frames_1080_g60.mp4');
  await a.evaluate((h) => (window as unknown as K).__kairo.addMediaClip(h, 0), hash);

  await expect.poll(() => proxy(b, hash).then((p) => p?.state), { timeout: 60_000 }).toBe('ready');
  expect((await media(b, hash))?.state).not.toBe('ready');
  await expect(b.locator('.clip .proxy-badge')).toBeVisible();

  // The proxy keeps the original's timestamps: frame n is exactly frame n (bits scaled to 540p).
  const results = await b.evaluate(async (h) => {
    const dec = (window as unknown as K).__kairoDecoder;
    const c = new OffscreenCanvas(128, 8).getContext('2d', { willReadFrequently: true })!;
    const out: { want: number; got: number; w: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const want = Math.floor(Math.random() * 600);
      const f = await dec.getFrame(h, `proxy-test`, want / 30);
      if (!f) {
        out.push({ want, got: -1, w: 0 });
        continue;
      }
      c.drawImage(f, 0, 0, 128, 8, 0, 0, 128, 8);
      const px = c.getImageData(0, 0, 128, 8).data;
      let n = 0;
      for (let bit = 0; bit < 16; bit++) if (px[(4 * 128 + bit * 8 + 4) * 4] > 128) n |= 1 << bit;
      out.push({ want, got: n, w: f.displayWidth });
      f.close();
    }
    return out;
  }, hash);
  for (const r of results) {
    expect(r.w, 'decoded from the 960×540 proxy').toBe(960);
    expect(r.got, `frame ${r.want}`).toBe(r.want);
  }

  // Export lists the missing original, then fetches it before rendering.
  await b.keyboard.press(process.platform === 'darwin' ? 'Meta+e' : 'Control+e');
  await expect(b.getByTestId('missing-originals')).toContainText('frames_1080_g60.mp4');
  await b.getByRole('button', { name: '540p' }).click();
  await testing(a, { holdOriginals: false });
  const download = b.waitForEvent('download', { timeout: 120_000 });
  await b.getByRole('button', { name: 'Fetch originals & export' }).click();
  const file = await (await download).path();
  expect(await media(b, hash)).toEqual({ state: 'ready', via: 'peer' });
  const n = Number(ffprobeJson(file!, ['-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames']).streams[0].nb_read_frames);
  expect(n).toBe(600);
  await closeAll(ctxA, ctxB);
});

test('A2: a reload mid-transfer resumes from the missing chunks only', async ({ browser }) => {
  const { a, b, ctxA, ctxB, link } = await twoUsers(browser);
  await testing(a, { serveDelayMs: 400 });
  const hash = await importFile(a, 'public/demo/frames.mp4'); // 4.3 MB → 5 chunks, no proxy (540p)
  await expect.poll(() => b.evaluate((h) => (window as unknown as K).__kairo.media.stats.received[h] ?? 0, hash), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  await b.reload();
  await openEditor(b, link);
  const storedAtReload = await b.evaluate(async (h) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('media')).getDirectoryHandle(`${h}.chunks`);
    let n = 0;
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) if (/^\d+$/.test(name)) n++;
    return n;
  }, hash);
  expect(storedAtReload).toBeGreaterThanOrEqual(2);

  await expect.poll(() => media(b, hash), { timeout: 60_000 }).toEqual({ state: 'ready', via: 'peer' });
  const after = await b.evaluate((h) => {
    const s = (window as unknown as K).__kairo.media.stats;
    return { received: s.received[h] ?? 0, rerequested: s.rerequestedStored };
  }, hash);
  expect(after.rerequested).toBe(0);
  expect(after.received, 'after the reload only the missing chunks were fetched').toBe(5 - storedAtReload);
  const served = await a.evaluate((h) => (window as unknown as K).__kairo.media.stats.served[h] ?? 0, hash);
  // Chunks that were mid-flight at the reload are the only ones that can be sent twice.
  expect(served).toBeLessThanOrEqual(5 + 4);
  await closeAll(ctxA, ctxB);
});

test('A2: with two holders, chunks come from both in parallel', async ({ browser }) => {
  const { a, b: c, ctxA, ctxB: ctxC, link } = await twoUsers(browser);
  const hash = await importFile(a, 'public/demo/frames.mp4');
  // C imports the same file: same content address (so no new tile), and C becomes a second holder.
  await expect.poll(() => media(c, hash).then((m) => m?.state)).not.toBeNull();
  await c.locator('.left-panel input[type=file]').setInputFiles('public/demo/frames.mp4');
  await expect.poll(() => media(c, hash).then((m) => m?.state), { timeout: 30_000 }).toBe('ready');
  await testing(a, { serveDelayMs: 300 });
  await testing(c, { serveDelayMs: 300 });

  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await openEditor(b, link);
  await expect.poll(() => media(b, hash), { timeout: 60_000 }).toEqual({ state: 'ready', via: 'peer' });
  const from = await b.evaluate(() => (window as unknown as K).__kairo.media.stats.receivedFrom);
  const counts = Object.values(from);
  expect(counts.length, 'peers that served chunks').toBe(2);
  expect(counts.reduce((x, y) => x + y, 0)).toBe(5);
  await closeAll(ctxA, ctxB, ctxC);
});

test('A3: proxy chunks at the playhead arrive before the rest', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await testing(a, { holdOriginals: true, serveDelayMs: 250 });
  // B parks its playhead 15 s in; A places the clip at 0 right after importing.
  await b.evaluate(() => (window as unknown as K).__kairo.seek(450));
  const hash = await importFile(a, 'public/demo/frames_1080_g60.mp4');
  await a.evaluate((h) => (window as unknown as K).__kairo.addMediaClip(h, 0), hash);
  await expect.poll(() => proxy(b, hash).then((p) => p?.state), { timeout: 60_000 }).toBe('ready');

  const { order, manifest } = await b.evaluate((h) => {
    const k = window as unknown as K;
    return { order: k.__kairo.media.stats.order[`${h}.proxy`], manifest: k.__kairo.doc.getMap('manifests').get(`${h}.proxy`) as { timeIndex: number[]; headerChunks: number } };
  }, hash);
  const header = manifest.headerChunks;
  const atPlayhead = new Set<number>();
  for (let s = 15; s < 20; s++) for (let c = manifest.timeIndex[2 * s]; c <= manifest.timeIndex[2 * s + 1]; c++) atPlayhead.add(c);
  const firstAfterHeader = order.filter((c) => c >= header)[0];
  expect(order.slice(0, header).every((c) => c < header), 'header first').toBe(true);
  expect(atPlayhead.has(firstAfterHeader), `first media chunk ${firstAfterHeader} covers the playhead (chunks ${[...atPlayhead]})`).toBe(true);
  await closeAll(ctxA, ctxB);
});

test('A1: B can watch the proxy before the original arrives (preview shows pixels)', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await testing(a, { holdOriginals: true });
  const hash = await importFile(a, 'public/demo/frames_1080_g60.mp4');
  await a.evaluate((h) => (window as unknown as K).__kairo.addMediaClip(h, 0), hash);
  await expect.poll(() => proxy(b, hash).then((p) => p?.playable), { timeout: 60_000 }).toBe(true);
  await b.evaluate(() => (window as unknown as K).__kairo.seek(100));
  await expect
    .poll(
      async () => {
        const png = PNG.sync.read(await b.locator('.stage canvas').screenshot());
        let lit = 0;
        for (let i = 0; i < png.data.length; i += 4) if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 60) lit++;
        return lit / (png.width * png.height);
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0.2);
  await closeAll(ctxA, ctxB);
});

test('A2: importing your own copy of a file mid-download marks it ready and stops the transfer', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await testing(a, { serveDelayMs: 1500 });
  const hash = await importFile(a, 'public/demo/frames.mp4');
  await expect.poll(() => b.evaluate((h) => (window as unknown as K).__kairo.media.stats.received[h] ?? 0, hash), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  await b.locator('.left-panel input[type=file]').setInputFiles('public/demo/frames.mp4');
  await expect.poll(() => media(b, hash), { timeout: 15_000 }).toEqual({ state: 'ready', via: 'local' });
  await b.waitForTimeout(4000); // chunks still in flight arrive and must not flip it back
  expect(await media(b, hash)).toEqual({ state: 'ready', via: 'local' });
  await closeAll(ctxA, ctxB);
});
