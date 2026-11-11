import { expect, test } from '@playwright/test';
import { addText, closeAll, twoUsers } from './helpers';

const startInput = '.field:has(label:text-is("Start")) input';

test('e) branch → edit → conflicting edit on main by another user → selective merge', async ({ browser }) => {
  const { a, b, ctxA, ctxB, link } = await twoUsers(browser);
  const code = link.match(/KAI-[A-Z0-9]{5}/)![0];
  await addText(a, 'Title'); // X
  await a.locator(startInput).fill('10');
  await addText(a, 'Lower third'); // Y — will be removed on the branch
  await a.locator(startInput).fill('200'); // keep clips from overlapping on the track
  await expect(b.locator('.clip.text')).toHaveCount(2);

  // A cuts a branch and edits it in isolation.
  await a.getByRole('tab', { name: 'Branches' }).click();
  await a.getByLabel('Branch name').fill('alt cut');
  await a.getByRole('button', { name: 'Create' }).click();
  await expect(a).toHaveURL(new RegExp(`/p/${code}/b/alt-cut$`));
  await expect(a.locator('.clip.text')).toHaveCount(2, { timeout: 30_000 });
  await a.locator('.clip.text', { hasText: 'Your title' }).click();
  await a.getByRole('tab', { name: 'Inspector' }).click();
  await a.locator(startInput).fill('45'); // conflicts with B below
  await a.locator('.clip.text', { hasText: 'Name Surname' }).click();
  await a.keyboard.press('Delete'); // clean removal
  await addText(a, 'Caption'); // added only on the branch
  await expect(b.locator('.clip.text')).toHaveCount(2); // main untouched

  // Meanwhile B edits the same field on main.
  await b.locator('.clip.text', { hasText: 'Your title' }).click();
  await b.getByRole('tab', { name: 'Inspector' }).click();
  await b.locator(startInput).fill('60');
  await b.waitForTimeout(500);

  // A reviews: 3 changes, one conflict; select only the conflict + the addition.
  await a.getByRole('tab', { name: 'Branches' }).click();
  await a.getByRole('button', { name: /Review & merge into main/ }).click();
  await expect(a.locator('.change')).toHaveCount(3);
  await expect(a.locator('.change.conflict')).toHaveCount(1);
  await a.locator('.change', { hasText: 'Name Surname' }).locator('input[type=checkbox]').uncheck();
  await a.locator('.resolve button', { hasText: 'Take branch' }).click();
  await a.getByRole('button', { name: 'Merge into main', exact: true }).click();
  await expect(a).toHaveURL(new RegExp(`/p/${code}$`));

  // B (who never left main) sees the merged state: X at 45, Y kept, caption added.
  await expect(b.locator('.clip.text')).toHaveCount(3, { timeout: 10_000 });
  await b.locator('.clip.text', { hasText: 'Your title' }).click();
  await b.getByRole('tab', { name: 'Inspector' }).click();
  await expect(b.locator(startInput)).toHaveValue('45');
  await expect(b.locator('.clip.text', { hasText: 'Name Surname' })).toHaveCount(1);
  await expect(b.locator('.clip.text', { hasText: 'Caption text goes here' })).toHaveCount(1);
  await closeAll(ctxA, ctxB);
});
