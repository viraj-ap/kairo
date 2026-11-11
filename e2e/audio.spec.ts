import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { createProject } from './helpers';

// Phase C1: streaming audio (AudioDecoder → ring buffer → AudioWorklet), used for playback,
// waveforms and export.

type P = { __kairo: { player: { audioOut: { underruns(): number } | null } | null; togglePlay(): void } };

test('C1: playback streams audio through the worklet with no underruns', async ({ page }) => {
  await createProject(page, 'demo');
  await expect(page.locator('.clip')).toHaveCount(5, { timeout: 30_000 });
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.evaluate(() => (window as unknown as P).__kairo.togglePlay());
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const out = (window as unknown as P).__kairo.player?.audioOut;
    return { streaming: !!out, underruns: out?.underruns() ?? -1 };
  });
  await page.evaluate(() => (window as unknown as P).__kairo.togglePlay());
  expect(r.streaming).toBe(true);
  expect(r.underruns).toBe(0);
});

test('C1: waveforms are drawn from streamed peaks', async ({ page }) => {
  await createProject(page, 'demo');
  const wave = page.locator('.clip.audio canvas.wave');
  await expect(wave).toHaveCount(1, { timeout: 30_000 });
  await expect
    .poll(async () => {
      const png = PNG.sync.read(await wave.screenshot());
      let lit = 0;
      for (let i = 0; i < png.data.length; i += 4) if (png.data[i + 1] > 150) lit++;
      return lit;
    })
    .toBeGreaterThan(50);
});

test('C1: exported audio is streamed, the full length, and audible', async ({ page }) => {
  await createProject(page, 'demo');
  await expect(page.locator('.clip')).toHaveCount(5, { timeout: 30_000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+e' : 'Control+e');
  await page.getByRole('button', { name: '540p' }).click();
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = (await (await download).path())!;
  const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', file]).toString()).streams;
  const v = streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  expect(a, 'audio stream').toBeTruthy();
  expect(Math.abs(Number(a.duration) - Number(v.duration))).toBeLessThan(0.1);
  const out = execFileSync('sh', ['-c', `ffmpeg -i "${file}" -map 0:a -af volumedetect -f null - 2>&1 | grep mean_volume`]).toString();
  const mean = Number(out.match(/mean_volume: (-?[\d.]+) dB/)![1]);
  expect(mean).toBeGreaterThan(-40);
});
