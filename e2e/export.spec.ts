import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { createProject } from './helpers';

function ffprobe(file: string): { frames: number; width: number; height: number } | null {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', file]).toString();
    const s = JSON.parse(out).streams[0];
    return { frames: +s.nb_read_frames, width: +s.width, height: +s.height };
  } catch {
    return null;
  }
}

for (const res of ['1080p', '540p'] as const) {
  test(`export ${res}: frame count matches the timeline to the frame`, async ({ page }) => {
    await createProject(page, 'demo');
    await expect(page.locator('.clip')).toHaveCount(5, { timeout: 30_000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+e' : 'Control+e');
    await page.getByRole('button', { name: res }).click();
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const file = await (await download).path();
    const expected = Number((await page.locator('.kv', { hasText: 'Length' }).innerText()).match(/\((\d+) frames\)/)![1]);
    const probe = ffprobe(file!);
    test.skip(!probe, 'ffprobe not installed');
    expect(probe!.frames).toBe(expected);
    expect(probe!.height).toBe(res === '1080p' ? 1080 : 540);
  });
}
