import { expect, test } from '@playwright/test';
import { addText, clipCount, closeAll, timelineHash, twoUsers } from './helpers';

// Every test here uses two ISOLATED browser contexts (like Chrome vs. incognito) talking
// through the real server (wrangler dev): nothing is shared except the network.

test('a) concurrent edits converge: A adds X, B adds Y, A deletes A′, B adds B′', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await addText(a, 'Title'); // X
  await addText(b, 'Subtitle'); // Y
  await addText(a, 'Accent'); // A′ (selected after adding)
  await addText(b, 'Caption'); // B′
  await expect.poll(() => clipCount(a)).toBe(4);
  await expect.poll(() => clipCount(b)).toBe(4);
  await a.locator('.clip.text', { hasText: 'KAIRO' }).click();
  await a.keyboard.press('Delete');
  await expect.poll(() => clipCount(b)).toBe(3);
  await expect.poll(async () => {
    const [ha, hb] = [await timelineHash(a), await timelineHash(b)];
    return ha.length === 64 && ha === hb;
  }).toBe(true);
  await expect(a.locator('.badge', { hasText: 'all converged' })).toBeVisible();
  await expect(b.locator('.badge', { hasText: 'all converged' })).toBeVisible();
  await closeAll(ctxA, ctxB);
});

test('b) remote cursors are visible on both sides', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await a.getByRole('tab', { name: /People/ }).click();
  const nameA = (await a.locator('.person').first().locator('.grow > div').first().innerText()).replace('(you)', '').trim();
  for (const [from, to] of [[a, b], [b, a]] as const) {
    const lane = (await from.locator('.tl-lane').nth(1).boundingBox())!;
    await from.mouse.move(lane.x + 200, lane.y + 15);
    await from.mouse.move(lane.x + 260, lane.y + 18);
    await expect(to.locator('.peer-cursor')).toHaveCount(1, { timeout: 5000 });
  }
  await expect(b.locator('.peer-cursor span')).toHaveText(nameA);
  await closeAll(ctxA, ctxB);
});

test('c) A goes offline, both edit, A reconnects, both converge', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await addText(a, 'Title');
  await expect.poll(() => clipCount(b)).toBe(1);

  await ctxA.setOffline(true);
  await expect(a.locator('.status-dot')).toContainText('Offline', { timeout: 10_000 });
  await addText(a, 'Subtitle'); // offline edit
  await addText(b, 'Caption'); // online edit A can't see yet
  await expect.poll(() => clipCount(a)).toBe(2);
  await expect.poll(() => clipCount(b)).toBe(2);

  await ctxA.setOffline(false);
  await expect(a.locator('.status-dot')).toContainText('Live', { timeout: 20_000 });
  await expect.poll(() => clipCount(a), { timeout: 15_000 }).toBe(3);
  await expect.poll(() => clipCount(b), { timeout: 15_000 }).toBe(3);
  await expect.poll(async () => (await timelineHash(a)) === (await timelineHash(b))).toBe(true);
  await closeAll(ctxA, ctxB);
});
