import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export async function openEditor(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('.timeline')).toBeVisible({ timeout: 30_000 });
}

/** Create a project from the dashboard and return its invite link (code + #k=key). */
export async function createProject(page: Page, template?: 'demo'): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: template === 'demo' ? 'Open demo reel' : 'New project' }).first().click();
  await expect(page.locator('.timeline')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.status-dot')).toContainText('Live', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Share' }).click();
  const link = await page.getByLabel('Invite link').inputValue();
  await page.keyboard.press('Escape');
  return link;
}

/** Two users in separate browser contexts: no shared storage, BroadcastChannel or OPFS. */
export async function twoUsers(browser: Browser, template?: 'demo', opts: { initScript?: string } = {}) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  if (opts.initScript) await Promise.all([ctxA.addInitScript(opts.initScript), ctxB.addInitScript(opts.initScript)]);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const link = await createProject(a, template);
  await openEditor(b, link);
  await expect(b.locator('.status-dot')).toContainText('Live', { timeout: 15_000 });
  return { a, b, ctxA, ctxB, link };
}

export async function addText(page: Page, preset: 'Title' | 'Subtitle' | 'Lower third' | 'Caption' | 'Accent') {
  const rail = page.getByRole('button', { name: 'Text', exact: true });
  if ((await rail.getAttribute('aria-pressed')) !== 'true') await rail.click();
  await page.locator('.text-preset').getByText(preset, { exact: true }).click();
}

export async function timelineHash(page: Page): Promise<string> {
  await page.getByRole('tab', { name: /People/ }).click();
  return (await page.locator('.hash-box').innerText()).trim();
}

export const clipCount = (page: Page) => page.locator('.clip').count();

export async function closeAll(...ctxs: BrowserContext[]) {
  await Promise.all(ctxs.map((c) => c.close()));
}
