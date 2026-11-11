import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { closeAll, twoUsers } from './helpers';

type W = { __kairo: { doc: { getMap(n: string): Map<string, { src?: string }> }; media: { snapshot(): Record<string, { state: string; via?: string }> }; seek(f: number): void } };

test('d) P2P media: A imports a file, B receives it over WebRTC, hash matches, B plays it', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);

  // Imported from disk: the room has no URL for it, so B can only get the bytes from A.
  await a.locator('.left-panel input[type=file]').setInputFiles('public/demo/life.mp4');
  await expect(a.locator('.tile')).toHaveCount(1, { timeout: 20_000 });
  const hash = await a.evaluate(() => [...(window as unknown as W).__kairo.doc.getMap('media').keys()][0]);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await a.locator('.tile .add').click({ force: true });

  // B sees the clip, the media is missing, then fetched from the peer.
  await expect(b.locator('.clip')).toHaveCount(1, { timeout: 10_000 });
  expect(await b.evaluate((h) => (window as unknown as W).__kairo.doc.getMap('media').get(h)?.src ?? null, hash)).toBeNull();
  await expect
    .poll(() => b.evaluate((h) => (window as unknown as W).__kairo.media.snapshot()[h], hash), { timeout: 60_000 })
    .toEqual({ state: 'ready', via: 'peer' });

  // Bytes in B's own OPFS hash to the same content address.
  // Transfers are stored as 1 MB chunk files (media/<hash>.chunks/<index>): reassemble and hash.
  const bHash = await b.evaluate(async (h) => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('media')).getDirectoryHandle(`${h}.chunks`);
    const layout = JSON.parse(await (await (await dir.getFileHandle('layout.json')).getFile()).text());
    const parts: Blob[] = [];
    for (let i = 0; i < Math.ceil(layout.size / layout.chunkSize); i++) parts.push(await (await dir.getFileHandle(String(i))).getFile());
    const d = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }, hash);
  expect(bHash).toBe(hash);

  // B can play it: the preview shows decoded pixels, not black.
  await b.evaluate(() => (window as unknown as W).__kairo.seek(45));
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
    .toBeGreaterThan(0.05);
  await closeAll(ctxA, ctxB);
});
