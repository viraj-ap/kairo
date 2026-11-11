import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { ssim } from 'ssim.js';

// Visual regression: frames 0, mid and last of a fixed 3-track project (video with a wipe +
// brightness, image overlay with opacity, text with a fade), rendered by the real compositor.
// Goldens live in e2e/golden; refresh them deliberately with `npm run golden`.

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const THRESHOLD = 0.99;

type Bench = { kairoBench: { prepare(): Promise<unknown>; renderGoldenFrames(h: unknown): Promise<{ compositor: string; frames: number[]; pngs: string[] }> } };

test('golden frames match (SSIM ≥ 0.99)', async ({ page }) => {
  await page.goto('/bench');
  await page.waitForFunction(() => 'kairoBench' in window);
  const out = await page.evaluate(async () => {
    const b = (window as unknown as Bench).kairoBench;
    return b.renderGoldenFrames(await b.prepare());
  });
  test.info().annotations.push({ type: 'compositor', description: out.compositor });
  mkdirSync('e2e/golden', { recursive: true });
  mkdirSync('e2e/.out', { recursive: true });

  const names = ['first', 'mid', 'last'];
  const scores: Record<string, number> = {};
  const written: string[] = [];
  for (const [i, dataUrl] of out.pngs.entries()) {
    const actual = Buffer.from(dataUrl.split(',')[1], 'base64');
    const file = `e2e/golden/frame-${names[i]}.png`;
    writeFileSync(`e2e/.out/actual-${names[i]}.png`, actual);
    if (UPDATE || !existsSync(file)) {
      writeFileSync(file, actual);
      written.push(file);
      continue;
    }
    const a = PNG.sync.read(actual);
    const g = PNG.sync.read(readFileSync(file));
    expect([a.width, a.height]).toEqual([g.width, g.height]);
    const toImage = (p: PNG) => ({ data: new Uint8ClampedArray(p.data), width: p.width, height: p.height });
    scores[names[i]] = ssim(toImage(a), toImage(g)).mssim;
  }
  if (written.length && !UPDATE) throw new Error(`Goldens were missing and have been written (${written.join(', ')}); review them and re-run.`);
  test.info().annotations.push({ type: 'ssim', description: JSON.stringify(scores) });
  console.log('SSIM', out.compositor, scores);
  for (const [k, v] of Object.entries(scores)) expect(v, `SSIM of frame ${k}`).toBeGreaterThanOrEqual(THRESHOLD);
});
