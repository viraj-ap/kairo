// Records the Kairo product demo: two isolated browser contexts (A = Viraj, B = Sam) driving the
// real app against the real local stack. Writes raw videos + scene markers to .cache/demo/,
// which scripts/demo/compose.sh turns into demo/kairo-demo.mp4.
//
//   node scripts/demo/record-demo.ts            # stops at the first failing scene (exit 1)
//   DEMO_CONTINUE=1 node scripts/demo/record-demo.ts
//                                               # dry run: logs failures and keeps going, so every
//                                               # scene gets checked; compose.sh refuses the result
//
// Rules: real app behavior only. Every caption number comes from docs/benchmarks.json or is read
// live from the UI. A scene that can't be shown for real fails; nothing is mocked around it.
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, '.cache/demo');
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:5173';
const CONTINUE = process.env.DEMO_CONTINUE === '1';
const W = 960;
const H = 1080;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

// ---------------------------------------------------------------- markers ----

type Marker = { scene: number; caption: string; start: number; end?: number; failed?: string; notes?: string[] };
const markers: Marker[] = [];
let t0 = 0;
const now = () => (performance.now() - t0) / 1000;

function writeMarkers(extra: Record<string, unknown> = {}) {
  writeFileSync(join(OUT, 'markers.json'), JSON.stringify({ scenes: markers, ...extra }, null, 2));
}

async function scene(n: number, caption: string, body: (m: Marker) => Promise<void>) {
  const m: Marker = { scene: n, caption, start: now() };
  markers.push(m);
  console.log(`[demo] scene ${n} @ ${m.start.toFixed(2)}s: ${caption}`);
  try {
    await body(m);
  } catch (e) {
    m.failed = (e as Error).message.split('\n').slice(0, 6).join('\n');
    console.error(`[demo] scene ${n} FAILED: ${m.failed}`);
    if (!CONTINUE) throw new SceneError(n, m.failed);
  } finally {
    m.end = now();
    writeMarkers();
  }
}

class SceneError extends Error {
  scene: number;
  constructor(scene: number, why: string) {
    super(`Scene ${scene} failed: ${why}`);
    this.scene = scene;
  }
}

// ------------------------------------------------------------ human input ----

const pos = new WeakMap<Page, { x: number; y: number }>();
const pause = (page: Page, min = 300, max = 800) => page.waitForTimeout(min + Math.random() * (max - min));

/** Moves the real mouse (and so the injected cursor) in small steps from where it last was. */
async function moveTo(page: Page, x: number, y: number) {
  const from = pos.get(page) ?? { x: W / 2, y: H / 2 };
  const dist = Math.hypot(x - from.x, y - from.y);
  await page.mouse.move(x, y, { steps: Math.max(8, Math.round(dist / 18)) });
  pos.set(page, { x, y });
}

async function center(loc: Locator) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  if (!b) throw new Error(`not visible: ${loc}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function click(page: Page, loc: Locator) {
  await expect(loc).toBeVisible();
  const { x, y } = await center(loc);
  await moveTo(page, x, y);
  await pause(page, 150, 350);
  await page.mouse.down();
  await page.mouse.up();
  await pause(page);
}

async function hover(page: Page, loc: Locator) {
  const { x, y } = await center(loc);
  await moveTo(page, x, y);
  await pause(page);
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy = 0) {
  await moveTo(page, from.x, from.y);
  await pause(page, 200, 400);
  await page.mouse.down();
  await moveTo(page, from.x + dx, from.y + dy);
  await pause(page, 150, 300);
  await page.mouse.up();
  await pause(page);
}

async function type(page: Page, loc: Locator, text: string) {
  await click(page, loc);
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type(text, { delay: 70 });
  await pause(page);
}

/** A visible cursor (the headless recorder draws none) that follows real mouse events, with a click ripple. */
const CURSOR = `(() => {
  const install = () => {
    if (document.getElementById('__demo-cursor')) return;
    const s = document.createElement('style');
    s.textContent = '#__demo-cursor{position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(255,255,255,.95);box-shadow:0 0 0 2px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.5);pointer-events:none;z-index:2147483647;transition:transform .08s}' +
      '#__demo-cursor.down{transform:scale(.75)}' +
      '.__demo-ripple{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #18ff7a;pointer-events:none;z-index:2147483646;animation:__demo-r .5s ease-out forwards}' +
      '@keyframes __demo-r{to{transform:scale(3.4);opacity:0}}';
    document.documentElement.appendChild(s);
    const c = document.createElement('div');
    c.id = '__demo-cursor';
    c.style.transform = 'translate(-100px,-100px)';
    document.documentElement.appendChild(c);
    let x = -100, y = -100;
    const place = () => (c.style.left = x + 'px', c.style.top = y + 'px');
    c.style.transform = '';
    c.style.left = '-100px';
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; place(); }, true);
    addEventListener('pointermove', (e) => { x = e.clientX; y = e.clientY; place(); }, true);
    addEventListener('mousedown', (e) => {
      c.classList.add('down');
      const r = document.createElement('div');
      r.className = '__demo-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install); else install();
})();`;

// ------------------------------------------------------------------ stack ----

async function up(url: string) {
  try {
    return (await fetch(url)).status < 500;
  } catch {
    return false;
  }
}

/** Reuses a running `npm run dev` (Vite :5173 + wrangler :8787 + TURN :3478), else starts one. */
async function ensureStack(): Promise<ChildProcess | null> {
  if ((await up(BASE)) && (await up('http://localhost:8787/healthz'))) {
    console.log('[demo] reusing the running dev stack');
    return null;
  }
  console.log('[demo] starting npm run dev');
  const p = spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  for (let i = 0; i < 120; i++) {
    if ((await up(BASE)) && (await up('http://localhost:8787/healthz'))) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('dev stack did not come up on :5173/:8787 within 120 s');
}

/** A fresh, good-looking 1080p clip for scene 6, generated with ffmpeg: real media, real import. */
function importClip(): string {
  const file = join(OUT, 'Skyline.mp4');
  if (!existsSync(file)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080:r=30:end_scale=0.02:inner=period', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
      '-t', '12', '-c:v', 'libx264', '-preset', 'medium', '-b:v', '24M', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  }
  return file;
}

// ------------------------------------------------------------- the script ----

type Kairo = { __kairo: { doc: { getMap(n: string): { keys(): Iterable<string> } }; media: { snapshot(): Record<string, { state: string; via?: string; progress?: number }>; proxySnapshot(): Record<string, { state: string; playable: boolean }> } } };

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.webm') || f.endsWith('.log') || f === 'markers.json') rmSync(join(OUT, f));
  const clipFile = importClip();
  const stack = await ensureStack();

  const browser = await chromium.launch({
    channel: 'chromium', // Chrome for Testing (full browser, not headless shell): WebGPU + H.264 WebCodecs
    executablePath: process.env.KAIRO_CHROME || undefined,
    headless: process.env.DEMO_HEADED !== '1',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  const context = (name: string, color: string) =>
    browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      recordVideo: { dir: OUT, size: { width: W, height: H } },
      permissions: ['clipboard-read', 'clipboard-write'],
      // The app's own local identity (what Settings → Name saves); there are no accounts.
      storageState: { cookies: [], origins: [{ origin: new URL(BASE).origin, localStorage: [{ name: 'kairo.identity', value: JSON.stringify({ name, color }) }] }] },
    });

  let ctxA: BrowserContext | undefined, ctxB: BrowserContext | undefined;
  let failure: SceneError | null = null;
  const meta: Record<string, unknown> = { base: BASE, chrome: browser.version(), dryRun: CONTINUE };
  try {
    ctxA = await context('Viraj', '#18ff7a');
    ctxB = await context('Sam', '#00c8ff');
    for (const c of [ctxA, ctxB]) await c.addInitScript(CURSOR);
    t0 = performance.now();
    const a = await ctxA.newPage();
    const startA = now();
    const b = await ctxB.newPage();
    const startB = now();
    meta.videoStart = { A: startA, B: startB };
    for (const [who, p] of [['A', a], ['B', b]] as const) {
      const log = (line: string) => appendFileSync(join(OUT, `console-${who}.log`), `${now().toFixed(2)} ${line}\n`);
      p.on('console', (m) => log(`${m.type()} ${m.text()}`));
      p.on('pageerror', (e) => log(`pageerror ${e.stack ?? e.message}`));
    }
    await Promise.all([a.goto(BASE), b.goto(BASE)]);
    await Promise.all([expect(a.getByRole('button', { name: 'Open demo reel' }).first()).toBeVisible(), expect(b.getByRole('button', { name: 'New project' }).first()).toBeVisible()]);
    await a.waitForTimeout(500);

    // 1: title card is composed from this marker (no browser action).
    await scene(1, 'Kairo — a browser NLE with live co-editing and git-style branches', async () => {
      await a.waitForTimeout(2000);
    });

    let link = '';
    await scene(2, 'Open the demo reel and play', async (m) => {
      await click(a, a.getByRole('button', { name: 'Open demo reel' }).first());
      await expect(a.locator('.timeline')).toBeVisible({ timeout: 30_000 });
      await expect(a.locator('.status-dot')).toContainText('Live', { timeout: 15_000 });
      await expect(a.locator('.clip')).toHaveCount(5, { timeout: 30_000 });
      await expect(a.locator('.overlay-tag .badge', { hasText: 'WebGPU' })).toBeVisible();
      await hover(a, a.locator('.stage canvas'));
      await a.keyboard.press(' ');
      await expect(a.locator('.overlay-tag')).toContainText(/shown/, { timeout: 5000 });
      await a.waitForTimeout(8000);
      const stats = await a.locator('.overlay-tag').innerText();
      m.notes = [`overlay during playback: ${stats.replace(/\s+/g, ' ')}`];
      // The brief asks for a debug overlay with fps and seek ms. Kairo's preview overlay
      // (src/ui/Preview.tsx, .overlay-tag) shows only the compositor and "N shown · N dropped".
      if (!/fps/i.test(stats)) {
        await a.keyboard.press(' ');
        throw new Error(`no debug overlay with fps / seek ms: the preview overlay only shows "${stats.replace(/\s+/g, ' ')}" (src/ui/Preview.tsx .overlay-tag). The brief's "3-track 1080p" also doesn't match: Open demo reel is 3 sequential 720p clips on one video track.`);
      }
      await a.keyboard.press(' ');
    });

    await scene(3, 'Frame-accurate seek, WebCodecs decode', async () => {
      const ruler = (await a.locator('.tl-ruler').boundingBox())!;
      // Scrub the ruler, then jump to scattered frames.
      await drag(a, { x: ruler.x + 40, y: ruler.y + ruler.height / 2 }, Math.min(500, ruler.width - 80));
      for (const fx of [0.15, 0.62, 0.31, 0.83, 0.47]) {
        await moveTo(a, ruler.x + 40 + fx * Math.min(560, ruler.width - 80), ruler.y + ruler.height / 2);
        await a.mouse.down();
        await a.mouse.up();
        await pause(a, 500, 900);
      }
      for (let i = 0; i < 6; i++) {
        await a.keyboard.press('ArrowRight');
        await pause(a, 120, 220);
      }
      const seek = await a.locator('.overlay-tag').innerText();
      if (!/seek/i.test(seek)) throw new Error(`no seek-time readout to show: the preview overlay has none (it reads "${seek.replace(/\s+/g, ' ')}" when paused)`);
    });

    await scene(4, 'End-to-end encrypted: the key never leaves the link', async () => {
      await click(a, a.getByRole('button', { name: 'Share' }));
      link = await a.getByLabel('Invite link').inputValue();
      if (!/#k=/.test(link)) throw new Error(`invite link has no #k= key: ${link}`);
      await hover(a, a.getByLabel('Invite link'));
      await a.waitForTimeout(1200);
      await click(a, a.getByRole('dialog', { name: 'Share' }).getByRole('button', { name: 'Copy' }));
      const copied = await a.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      if (copied !== link) throw new Error('Copy did not put the invite link on the clipboard');
      // B "pastes" it: the same URL, opened in a separate, isolated browser profile.
      await b.goto(copied);
      await expect(b.locator('.timeline')).toBeVisible({ timeout: 30_000 });
      await expect(b.locator('.status-dot')).toContainText('Live', { timeout: 15_000 });
      await expect(b.locator('.clip')).toHaveCount(5, { timeout: 30_000 });
      await click(a, a.getByRole('dialog', { name: 'Share' }).getByRole('button', { name: 'Done' }));
      await b.waitForTimeout(1500);
    });

    await scene(5, 'Live co-editing: both edit at once, CRDT converges', async (m) => {
      const addText = async (p: Page, preset: string) => {
        const rail = p.getByRole('button', { name: 'Text', exact: true });
        if ((await rail.getAttribute('aria-pressed')) !== 'true') await click(p, rail);
        await click(p, p.locator('.text-preset').getByText(preset, { exact: true }));
      };
      // Put the two playheads apart so the new clips land in different places.
      await b.keyboard.press('End');
      await Promise.all([addText(a, 'Title'), addText(b, 'Subtitle')]); // X, Y at the same time
      await Promise.all([expect(a.locator('.clip')).toHaveCount(7), expect(b.locator('.clip')).toHaveCount(7)]);
      // A deletes A′ (the reel's "Made with Kairo" title) while B adds B′.
      await Promise.all([
        (async () => {
          await click(a, a.locator('.clip.text', { hasText: 'Made with Kairo' }));
          await a.keyboard.press('Delete');
        })(),
        addText(b, 'Lower third'),
      ]);
      await Promise.all([expect(a.locator('.clip')).toHaveCount(7), expect(b.locator('.clip')).toHaveCount(7)]);
      // Remote cursors and selections.
      const laneA = (await a.locator('.tl-lane').nth(1).boundingBox())!;
      const laneB = (await b.locator('.tl-lane').nth(1).boundingBox())!;
      await Promise.all([moveTo(a, laneA.x + 220, laneA.y + 16), moveTo(b, laneB.x + 380, laneB.y + 16)]);
      await Promise.all([moveTo(a, laneA.x + 300, laneA.y + 18), moveTo(b, laneB.x + 320, laneB.y + 14)]);
      await expect(a.locator('.peer-cursor')).toHaveCount(1, { timeout: 5000 });
      await expect(b.locator('.peer-cursor')).toHaveCount(1, { timeout: 5000 });
      await click(b, b.locator('.clip', { hasText: 'Fractal' }));
      await expect(a.locator('.peer-sel')).toHaveCount(1, { timeout: 5000 });
      await pause(a, 800, 1200);
      await Promise.all([click(a, a.getByRole('tab', { name: /People/ })), click(b, b.getByRole('tab', { name: /People/ }))]);
      await Promise.all([
        expect(a.locator('.badge', { hasText: 'all converged' })).toBeVisible({ timeout: 10_000 }),
        expect(b.locator('.badge', { hasText: 'all converged' })).toBeVisible({ timeout: 10_000 }),
      ]);
      const [ha, hb] = [(await a.locator('.hash-box').innerText()).trim(), (await b.locator('.hash-box').innerText()).trim()];
      if (ha.length !== 64 || ha !== hb) throw new Error(`timeline hashes differ: A ${ha} / B ${hb}`);
      await hover(a, a.locator('.hash-box'));
      await hover(b, b.locator('.hash-box'));
      m.notes = [`converged hash ${ha}`];
      await a.waitForTimeout(2500);
    });

    await scene(6, 'Media moves browser-to-browser over WebRTC (no server storage)', async (m) => {
      await click(a, a.getByRole('button', { name: 'Media', exact: true }));
      await click(b, b.getByRole('button', { name: 'Media', exact: true }));
      const tilesA = await a.locator('.tile').count();
      // Watch B from the moment A picks the file: on localhost the transfer takes seconds.
      let hash = '';
      const seen = new Set<string>();
      const snapshot = () => b.evaluate((h) => (window as unknown as Kairo).__kairo.media.snapshot()[h] ?? null, hash);
      const watch = (async () => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const tile = await b.locator('.tile', { hasText: 'Skyline' }).allInnerTexts();
          const clip = await b.locator('.clip', { hasText: 'Skyline' }).allInnerTexts();
          for (const pct of tile.join(' ').matchAll(/(\d+)%/g)) seen.add(`${pct[1]}%`);
          if (/receiving/i.test(clip.join(' '))) seen.add('receiving…');
          if (/540p|proxy/i.test(clip.join(' '))) seen.add('proxy');
          if (hash && (await snapshot())?.state === 'ready') return;
          await b.waitForTimeout(50);
        }
      })();
      const chooser = a.waitForEvent('filechooser');
      await click(a, a.getByRole('button', { name: 'Import files' }));
      await (await chooser).setFiles(clipFile);
      await expect(a.locator('.tile')).toHaveCount(tilesA + 1, { timeout: 60_000 });
      hash = await a.evaluate(() => [...(window as unknown as Kairo).__kairo.doc.getMap('media').keys()].at(-1)!);
      await a.keyboard.press('End'); // append after the reel
      await click(a, a.locator('.tile', { hasText: 'Skyline' }).locator('.add'));
      await watch;
      const pcts = [...seen].filter((x) => x.endsWith('%'));
      m.notes = [`B saw: ${[...seen].filter((x) => !x.endsWith('%')).join(', ')}${pcts.length ? `, ${pcts.length} progress values ${pcts[0]}…${pcts.at(-1)}` : ''}`];
      const st = await snapshot();
      if (st?.state !== 'ready' || st.via !== 'peer') throw new Error(`B did not receive the file from A over WebRTC: ${JSON.stringify(st)}`);
      if (!pcts.length && !seen.has('receiving…')) throw new Error('the transfer finished before B showed any "Receiving" or % state, so there was nothing to show');
      // B plays the new clip from its first frame: click the ruler above it.
      const clipBox = (await b.locator('.clip', { hasText: 'Skyline' }).boundingBox())!;
      const ruler = (await b.locator('.tl-ruler').boundingBox())!;
      if (clipBox.x + 4 > ruler.x + ruler.width) throw new Error('the imported clip is off-screen on B\'s timeline');
      await moveTo(b, clipBox.x + 4, ruler.y + ruler.height / 2);
      await b.mouse.down();
      await b.mouse.up();
      await pause(b);
      await hover(b, b.locator('.stage canvas'));
      await b.keyboard.press(' ');
      await b.waitForTimeout(3500);
      await b.keyboard.press(' ');
    });

    await scene(7, 'Sam branches "intro-fix" while Viraj keeps editing main', async () => {
      await click(b, b.getByRole('tab', { name: 'Branches' }));
      await type(b, b.getByLabel('Branch name'), 'intro-fix');
      await click(b, b.getByRole('button', { name: 'Create' }));
      await expect(b).toHaveURL(/\/b\/intro-fix$/, { timeout: 15_000 });
      await expect(b.locator('.clip', { hasText: 'Aurora' })).toHaveCount(1, { timeout: 30_000 });
      const trim = async (p: Page, px: number) => {
        const clip = p.locator('.clip', { hasText: 'Aurora' });
        await hover(p, clip);
        const box = (await clip.boundingBox())!;
        await drag(p, { x: box.x + box.width - 3, y: box.y + box.height / 2 }, -px);
      };
      await Promise.all([trim(b, 30), trim(a, 70)]); // same clip, different trims: a conflict
      const rail = b.getByRole('button', { name: 'Text', exact: true });
      if ((await rail.getAttribute('aria-pressed')) !== 'true') await click(b, rail);
      await click(b, b.locator('.text-preset').getByText('Caption', { exact: true }));
      await expect(b.locator('.clip.text', { hasText: 'Caption text goes here' })).toHaveCount(1);
      await expect(a.locator('.clip.text', { hasText: 'Caption text goes here' })).toHaveCount(0); // main untouched
      await b.waitForTimeout(1500);
    });

    await scene(8, 'Selective three-way merge', async (m) => {
      await click(b, b.getByRole('tab', { name: 'Branches' }));
      await click(b, b.getByRole('button', { name: /Review & merge into main/ }));
      await expect(b.getByRole('dialog', { name: 'Merge branch' })).toBeVisible({ timeout: 15_000 });
      await expect(b.locator('.change.conflict')).toHaveCount(1, { timeout: 15_000 });
      const caption = b.locator('.change', { hasText: 'Caption' });
      await expect(caption).toHaveCount(1);
      const conflict = b.locator('.change.conflict');
      await click(b, conflict);
      m.notes = [`conflict: ${(await conflict.getByTestId('conflict-line').innerText()).trim()}`];
      await b.waitForTimeout(4000); // the loop preview plays the affected range
      const box = caption.locator('input[type=checkbox]');
      if (!(await box.isChecked())) await click(b, box);
      await click(b, caption);
      await b.waitForTimeout(1500);
      await click(b, conflict.locator('.resolve button', { hasText: 'Take branch' }));
      await click(b, b.getByRole('button', { name: 'Merge into main', exact: true }));
      await expect(b).not.toHaveURL(/\/b\//, { timeout: 15_000 });
      // A (on main the whole time) sees the merged result.
      await expect(a.locator('.clip.text', { hasText: 'Caption text goes here' })).toHaveCount(1, { timeout: 15_000 });
      await hover(a, a.locator('.clip.text', { hasText: 'Caption text goes here' }));
      await Promise.all([click(a, a.getByRole('tab', { name: /People/ })), click(b, b.getByRole('tab', { name: /People/ }))]);
      await expect(a.locator('.badge', { hasText: 'all converged' })).toBeVisible({ timeout: 10_000 });
      await a.waitForTimeout(2500);
    });

    await scene(9, 'On-device 1080p H.264 export', async (m) => {
      await hover(a, a.locator('.stage canvas'));
      await a.keyboard.press(`${mod}+e`);
      await click(a, a.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: '1080p' }));
      const download = a.waitForEvent('download', { timeout: 180_000 });
      await click(a, a.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export', exact: true }));
      await expect(a.locator('.progress-bar')).toBeVisible({ timeout: 10_000 });
      await download;
      const done = (await a.locator('.dialog .badge.ok').innerText()).trim();
      const speed = done.match(/([\d.]+)× real time/)?.[1];
      if (!speed) throw new Error(`export finished without a speed readout: "${done}"`);
      m.notes = [done];
      m.caption = `On-device 1080p H.264 export: ${speed}× real time`;
      await a.waitForTimeout(2500);
    });
  } catch (e) {
    if (e instanceof SceneError) failure = e;
    else throw e;
  } finally {
    // Videos are only finalised when the contexts close.
    const pageA = ctxA?.pages()[0];
    const pageB = ctxB?.pages()[0];
    await ctxA?.close();
    await ctxB?.close();
    await browser.close();
    const vA = await pageA?.video()?.path();
    const vB = await pageB?.video()?.path();
    if (vA) renameSync(vA, join(OUT, 'A.webm'));
    if (vB) renameSync(vB, join(OUT, 'B.webm'));
    const failed = markers.filter((m) => m.failed).map((m) => m.scene);
    writeMarkers({ ...meta, end: now(), failed });
    if (stack) process.kill(-stack.pid!, 'SIGTERM');
  }

  const failed = markers.filter((m) => m.failed);
  for (const m of markers) console.log(`[demo] scene ${m.scene}: ${m.failed ? 'FAILED' : 'ok'}  ${(m.end! - m.start).toFixed(1)}s${m.notes ? `  (${m.notes.join('; ')})` : ''}`);
  if (failure || failed.length) {
    console.error(`\n[demo] ${failed.length} scene(s) failed:\n${failed.map((m) => `  scene ${m.scene}: ${m.failed}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`[demo] recorded → ${OUT}/{A,B}.webm + markers.json. Next: bash scripts/demo/compose.sh`);
}

await main();
