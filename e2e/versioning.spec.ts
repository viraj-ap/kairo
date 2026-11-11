import { expect, test, type Page } from '@playwright/test';
import { addText, closeAll, twoUsers } from './helpers';

// Phase B: merge base, plain-language conflicts, grouped changes, version history.

const startInput = '.field:has(label:text-is("Start")) input';
const myName = (p: Page) => p.evaluate(() => (window as unknown as { __kairo: { identity: { name: string } } }).__kairo.identity.name);

async function branchOff(page: Page, name: string) {
  await page.getByRole('tab', { name: 'Branches' }).click();
  await page.getByLabel('Branch name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/b\//);
  await expect(page.locator('.timeline')).toBeVisible({ timeout: 30_000 });
}

async function review(page: Page) {
  await page.getByRole('tab', { name: 'Branches' }).click();
  await page.getByRole('button', { name: /Review & merge into main/ }).click();
  await expect(page.locator('.merge')).toBeVisible();
}

test('B2: conflicts read in plain language with real names, thumbnails, a loop of the range and the clip highlighted', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  const bName = await myName(b);
  await addText(a, 'Title');
  await a.locator(startInput).fill('10');
  await expect(b.locator('.clip.text')).toHaveCount(1);

  await branchOff(a, 'alt');
  await expect(a.locator('.clip.text')).toHaveCount(1, { timeout: 30_000 });
  await a.locator('.clip.text').click();
  await a.getByRole('tab', { name: 'Inspector' }).click();
  await a.locator(startInput).fill('45'); // A on the branch: 0:01.5

  await b.locator('.clip.text').click();
  await b.getByRole('tab', { name: 'Inspector' }).click();
  await b.locator(startInput).fill('60'); // B on main: 0:02
  await b.waitForTimeout(500);

  await review(a);
  await expect(a.locator('[data-testid=conflict-line]')).toHaveText(`You moved 'Your title' to 0:01.5 · ${bName} moved it to 0:02`);
  await expect(a.locator('.conflict-thumb')).toHaveCount(2);
  await expect(a.locator('.conflict-thumb').nth(0)).toContainText(`${bName} moved 'Your title' to 0:02`);
  await expect(a.locator('.conflict-thumb').nth(1)).toContainText("You moved 'Your title' to 0:01.5");
  await a.locator('.change.conflict').click();
  await expect(a.getByTestId('loop-player')).toBeVisible();
  await expect(a.getByTestId('loop-player')).toContainText('Affected range');
  await expect(a.locator('.diff-clip.highlight')).toHaveCount(3); // main, branch and result lanes
  await closeAll(ctxA, ctxB);
});

test('B1 + B3: a multi-select move is one grouped change, and merging again shows only newer changes', async ({ browser }) => {
  const { a, ctxA, ctxB } = await twoUsers(browser);
  for (const p of ['Title', 'Subtitle', 'Caption'] as const) {
    await addText(a, p);
    await a.locator(startInput).fill(String({ Title: 0, Subtitle: 100, Caption: 200 }[p]));
  }
  await branchOff(a, 'nudge');
  await expect(a.locator('.clip.text')).toHaveCount(3, { timeout: 30_000 });
  await a.locator('.timeline').click({ position: { x: 600, y: 200 } });
  await a.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await a.keyboard.press('Shift+Alt+ArrowRight'); // move all three +1 s

  await review(a);
  await expect(a.getByTestId('change-group')).toHaveCount(1);
  await expect(a.getByTestId('change-group')).toContainText('Shifted 3 clips +1.0 s on Titles');
  await expect(a.locator('.change:not(.group)')).toHaveCount(0);
  await a.getByTestId('change-group').getByRole('button', { name: 'Expand' }).click();
  await expect(a.locator('.group-items li')).toHaveCount(3);
  await a.getByRole('button', { name: 'Merge into main', exact: true }).click();
  await expect(a).toHaveURL(/\/p\/KAI-[A-Z0-9]{5}$/);

  // Back on the branch: nothing new yet, then one more edit shows up alone.
  await a.getByRole('tab', { name: 'Branches' }).click();
  await a.getByRole('button', { name: 'Open' }).first().click();
  await expect(a.locator('.clip.text')).toHaveCount(3, { timeout: 30_000 });
  await review(a);
  await expect(a.getByText('No changes on this branch since it was created.')).toBeVisible();
  await a.getByRole('button', { name: 'Cancel' }).click();
  await a.locator('.clip.text', { hasText: 'Caption' }).click();
  await a.getByRole('tab', { name: 'Inspector' }).click();
  await a.locator(startInput).fill('400');
  await review(a);
  await expect(a.locator('.change')).toHaveCount(1);
  await expect(a.locator('.change')).toContainText('Caption text goes here');
  await closeAll(ctxA, ctxB);
});

test('B4: save a version, change things, restore it, and undo the restore', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser);
  await addText(a, 'Title');
  await a.getByRole('tab', { name: 'History' }).click();
  await a.getByLabel('Version name').fill('Rough cut');
  await a.getByRole('button', { name: 'Save version' }).click();
  await expect(a.getByTestId('version')).toHaveCount(1);
  // Versions are shared through the room.
  await b.getByRole('tab', { name: 'History' }).click();
  await expect(b.getByTestId('version')).toContainText('Rough cut');

  await addText(a, 'Caption');
  await addText(a, 'Accent');
  await expect(a.locator('.clip.text')).toHaveCount(3);

  await a.getByRole('tab', { name: 'History' }).click();
  await a.getByTestId('version').click();
  await expect(a.locator('.right-body .kv', { hasText: 'Clips' })).toContainText('1');
  await a.getByRole('button', { name: 'Restore this version' }).click();
  await expect(a.locator('.clip.text')).toHaveCount(1);
  await expect(b.locator('.clip.text')).toHaveCount(1);

  await a.locator('.timeline').click({ position: { x: 600, y: 200 } });
  await a.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(a.locator('.clip.text')).toHaveCount(3);
  await closeAll(ctxA, ctxB);
});
