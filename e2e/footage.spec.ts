import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProject } from './helpers';

// Phase C2: footage that isn't neat 30 fps landscape H.264.
// Synthetic phone-like clips come from scripts/make-test-media.sh (generated on demand).
// Real phone clips are read from e2e/media/real/ if any are present.

const MEDIA = '.cache/test-media';
const REAL = 'e2e/media/real';

type K = {
  __kairo: {
    doc: { getMap(n: string): { keys(): Iterable<string>; get(k: string): Record<string, unknown> } };
    addMediaClip(hash: string, frame?: number): string | null;
    seek(f: number): void;
    togglePlay(): void;
    player: { stats: { presented: number; dropped: number }; playing: boolean } | null;
  };
  __kairoDecoder: { getFrame(hash: string, key: string, t: number): Promise<VideoFrame | null>; clearDecoderCache(): void };
};

test.beforeAll(() => {
  if (!['vfr.mp4', 'rotated.mp4', '4k.mp4'].every((f) => existsSync(`${MEDIA}/${f}`))) execFileSync('bash', ['scripts/make-test-media.sh'], { stdio: 'inherit' });
});

function ptsList(file: string): number[] {
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'json', file]).toString());
  return out.frames.map((f: { pts_time: string }) => Number(f.pts_time)).sort((a: number, b: number) => a - b);
}

async function importAndGetHash(page: Page, path: string): Promise<string> {
  const before = await page.locator('.tile').count();
  await page.locator('.left-panel input[type=file]').setInputFiles(path);
  await expect(page.locator('.tile')).toHaveCount(before + 1, { timeout: 120_000 });
  return page.evaluate(() => {
    const keys = [...(window as unknown as K).__kairo.doc.getMap('media').keys()];
    return keys[keys.length - 1];
  });
}

/** Decode at each time and read back the frame index encoded in the pixels (and the frame's timestamp). */
function decodeIndices(page: Page, hash: string, times: number[]) {
  return page.evaluate(
    async ({ h, times }) => {
      const dec = (window as unknown as K).__kairoDecoder;
      const c = new OffscreenCanvas(256, 16).getContext('2d', { willReadFrequently: true })!;
      const out: { t: number; got: number; ts: number }[] = [];
      for (const t of times) {
        const f = await dec.getFrame(h, 'footage-test', t);
        if (!f) {
          out.push({ t, got: -1, ts: -1 });
          continue;
        }
        c.drawImage(f, 0, 0, 256, 16, 0, 0, 256, 16);
        const px = c.getImageData(0, 0, 256, 16).data;
        let n = 0;
        for (let b = 0; b < 16; b++) if (px[(8 * 256 + b * 16 + 8) * 4] > 128) n |= 1 << b;
        out.push({ t, got: n, ts: f.timestamp });
        f.close();
      }
      return out;
    },
    { h: hash, times },
  );
}

test('C2: variable frame rate — every lookup shows the frame being displayed at that time', async ({ page }) => {
  await createProject(page);
  const hash = await importAndGetHash(page, `${MEDIA}/vfr.mp4`);
  const info = await page.evaluate((h) => (window as unknown as K).__kairo.doc.getMap('media').get(h), hash);
  expect(info.vfr, 'detected as variable frame rate').toBe(true);
  const pts = ptsList(`${MEDIA}/vfr.mp4`);
  const t0 = pts[0];
  // Random times plus times just before/after irregular frames.
  const times = Array.from({ length: 40 }, () => Math.random() * (pts[pts.length - 1] - t0));
  for (const i of [3, 4, 10, 25]) times.push(pts[i] - t0 + 0.0005, pts[i] - t0 - 0.002);
  const results = await decodeIndices(page, hash, times);
  for (const r of results) {
    const expected = pts.filter((p) => p - t0 <= r.t + 0.001).length - 1;
    expect(r.got, `t=${r.t.toFixed(4)}s`).toBe(expected);
    expect(Math.abs(r.ts / 1e6 - (pts[expected] - t0)), 'frame timestamp').toBeLessThan(0.001);
  }
});

test('C2: rotated phone footage is displayed upright, matching ffmpeg', async ({ page }) => {
  await createProject(page);
  // Portrait project, like a phone video.
  await page.getByRole('button', { name: /16:9/ }).click();
  await page.locator('.menu-pop button', { hasText: '9:16' }).click();
  const hash = await importAndGetHash(page, `${MEDIA}/rotated.mp4`);
  const info = await page.evaluate((h) => (window as unknown as K).__kairo.doc.getMap('media').get(h), hash);
  expect(info.rotation, 'rotation read from the display matrix').toBeTruthy();
  expect(Number(info.height)).toBeGreaterThan(Number(info.width)); // display size is portrait

  await page.evaluate((h) => (window as unknown as K).__kairo.addMediaClip(h, 0), hash);
  await page.evaluate(() => (window as unknown as K).__kairo.seek(1));
  await page.waitForTimeout(1500);
  const ours = PNG.sync.read(await page.locator('.stage canvas').screenshot());

  // ffmpeg applies the display matrix when decoding (autorotate): our reference.
  const ref = PNG.sync.read(execFileSync('ffmpeg', ['-v', 'error', '-i', `${MEDIA}/rotated.mp4`, '-vf', 'select=eq(n\\,1)', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']));
  expect(ref.height).toBeGreaterThan(ref.width);
  const redCorner = (p: PNG) => {
    const corners = { tl: [0.05, 0.05], tr: [0.95, 0.05], bl: [0.05, 0.95], br: [0.95, 0.95] } as const;
    let best = '';
    let bestScore = -1;
    for (const [k, [fx, fy]] of Object.entries(corners)) {
      // Search near each corner of the picture area (our canvas is letterbox-free at 9:16).
      const x = Math.floor(fx * (p.width - 1));
      const y = Math.floor(fy * (p.height - 1));
      const i = (y * p.width + x) * 4;
      const score = p.data[i] - (p.data[i + 1] + p.data[i + 2]) / 2;
      if (score > bestScore) [best, bestScore] = [k, score];
    }
    return best;
  };
  expect(redCorner(ours), 'marker corner (ours vs ffmpeg)').toBe(redCorner(ref));
});

test('C2: 4K — frame-accurate seeks and real-time playback', async ({ page }) => {
  test.setTimeout(240_000);
  await createProject(page);
  const hash = await importAndGetHash(page, `${MEDIA}/4k.mp4`);
  const info = await page.evaluate((h) => (window as unknown as K).__kairo.doc.getMap('media').get(h), hash);
  expect([info.width, info.height]).toEqual([3840, 2160]);
  const frames = Array.from({ length: 20 }, () => Math.floor(Math.random() * 900));
  const results = await decodeIndices(page, hash, frames.map((f) => f / 30));
  results.forEach((r, i) => expect(r.got, `frame ${frames[i]}`).toBe(frames[i]));

  await page.evaluate((h) => (window as unknown as K).__kairo.addMediaClip(h, 0), hash);
  await page.evaluate(() => (window as unknown as K).__kairo.seek(0));
  await page.waitForTimeout(1000);
  await page.evaluate(() => (window as unknown as K).__kairo.togglePlay());
  await page.waitForTimeout(10_000);
  const s = await page.evaluate(() => {
    const k = (window as unknown as K).__kairo;
    const st = { ...k.player!.stats };
    k.togglePlay();
    return st;
  });
  const total = s.presented + s.dropped;
  test.info().annotations.push({ type: '4k-playback', description: JSON.stringify(s) });
  console.log('4K playback (10 s):', s);
  expect(total).toBeGreaterThan(250);
  expect(s.dropped / total, 'drop rate').toBeLessThan(0.05);
});

const realClips = existsSync(REAL) ? readdirSync(REAL).filter((f) => /\.(mp4|mov|m4v)$/i.test(f)) : [];

// Shows up as skipped (not silently absent) until real clips are provided.
if (realClips.length === 0) test.skip(`C2: real phone clips — none in ${REAL}/ (see Known issues)`, () => {});

test.describe('C2: real phone clips', () => {
  for (const name of realClips) {
    test(`${name}: orientation, exact frame timestamps, playback`, async ({ page }) => {
      test.setTimeout(240_000);
      const file = `${REAL}/${name}`;
      await createProject(page);
      const hash = await importAndGetHash(page, file);
      const info = await page.evaluate((h) => (window as unknown as K).__kairo.doc.getMap('media').get(h), hash);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', file]).toString()).streams[0];
      const rot = Math.abs(Number(probe.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
      const portrait = rot === 90 ? probe.width > probe.height : probe.height > probe.width;
      expect(Number(info.height) > Number(info.width), 'display orientation matches ffprobe').toBe(portrait);

      const pts = ptsList(file);
      const t0 = pts[0];
      const picks = Array.from({ length: 30 }, () => pts[Math.floor(Math.random() * pts.length)] - t0);
      const results = await decodeIndices(page, hash, picks);
      for (const r of results) expect(Math.abs(r.ts / 1e6 - r.t), `frame at ${r.t.toFixed(4)}s`).toBeLessThan(0.001);

      await page.evaluate((h) => (window as unknown as K).__kairo.addMediaClip(h, 0), hash);
      await page.evaluate(() => (window as unknown as K).__kairo.togglePlay());
      await page.waitForTimeout(10_000);
      const s = await page.evaluate(() => {
        const k = (window as unknown as K).__kairo;
        const st = { ...k.player!.stats };
        k.togglePlay();
        return st;
      });
      expect(s.dropped / Math.max(1, s.presented + s.dropped), 'drop rate').toBeLessThan(0.05);
    });
  }
});
