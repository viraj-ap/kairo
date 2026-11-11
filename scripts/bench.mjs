// Full benchmark report: 3 runs of every suite (median of each statistic), collaboration
// latency over the real server between two isolated browser contexts, and a memory soak.
//
//   npm run bench                 # everything (~45 min: the soak is 3 × 10 min)
//   SOAK_MINUTES=1 npm run bench  # shorter soak
//   RUNS=1 npm run bench
//
// Starts its own `wrangler dev` on :4175. Writes docs/benchmarks.json.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { chromium } from '@playwright/test';

const PORT = 4175;
const BASE = `http://localhost:${PORT}`;
const RUNS = Number(process.env.RUNS ?? 3);
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? 10);
const SOAK_RUNS = Number(process.env.SOAK_RUNS ?? RUNS);
const log = (...a) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a);

// Resume support: SOAK_ONLY=1 keeps the decode/collab results in docs/benchmarks.json and reruns only the soak.
const SOAK_ONLY = process.env.SOAK_ONLY === '1';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Median of every numeric leaf across runs; non-numeric leaves come from the first run. */
function medianOf(runs) {
  const [first] = runs;
  if (typeof first === 'number') return Math.round(median(runs) * 100) / 100;
  if (Array.isArray(first) || first === null || typeof first !== 'object') return first;
  return Object.fromEntries(Object.keys(first).map((k) => [k, medianOf(runs.map((r) => r?.[k]))]));
}

function pct(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  const r = (v) => Math.round(v * 100) / 100;
  return { n: s.length, p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}

async function startServer() {
  log('building…');
  execSync('npx vite build', { stdio: 'ignore' });
  mkdirSync('.scratch', { recursive: true });
  const proc = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', '.scratch/bench-state'], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

const browserArgs = ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'];

async function benchPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message));
  await page.goto(`${BASE}/bench`);
  await page.waitForFunction(() => 'kairoBench' in window);
  await page.evaluate(async () => (window.__h = await window.kairoBench.prepare()));
  return { ctx, page };
}

const suite = (page, expr) => page.evaluate(`(async () => { const b = window.kairoBench, h = window.__h; return ${expr}; })()`);

async function decodeRun(browser) {
  const { ctx, page } = await benchPage(browser);
  const r = { crossOriginIsolated: await page.evaluate(() => crossOriginIsolated) };
  const steps = [
    ['seekWarm_540p_gop30', `b.seekSuite(h.frames540, { n: 200, cold: false, far: false })`],
    ['seekCold_540p_gop30', `b.seekSuite(h.frames540, { n: 100, cold: true, far: false })`],
    ['farSeekWarm_1080p_gop60', `b.seekSuite(h.g60, { n: 60, cold: false, far: true })`],
    ['farSeekCold_1080p_gop60', `b.seekSuite(h.g60, { n: 60, cold: true, far: true })`],
    ['farSeekWarm_1080p_gop250', `b.seekSuite(h.g250, { n: 40, cold: false, far: true })`],
    ['farSeekCold_1080p_gop250', `b.seekSuite(h.g250, { n: 40, cold: true, far: true })`],
    ['sequential_1080p', `b.sequentialSuite(h.g60, 300)`],
    ['playback_3track_1080p_60s', `b.playbackSuite(h, 60)`],
    ['export_1080p_10s', `b.exportSuite(h, { width: 1920, height: 1080, seconds: 10 })`],
    ['export_720p_10s', `b.exportSuite(h, { width: 1280, height: 720, seconds: 10 })`],
  ];
  for (const [name, expr] of steps) {
    log('  ', name);
    r[name] = await suite(page, expr);
  }
  await ctx.close();
  return r;
}

/** Round trip through the server: A writes ping=i, B (another isolated context) answers pong=i. */
async function collabRun(browser, n = 200) {
  const [ca, cb] = [await browser.newContext(), await browser.newContext()];
  const [a, b] = [await ca.newPage(), await cb.newPage()];
  await a.goto(`${BASE}/`);
  await a.getByRole('button', { name: 'New project' }).first().click();
  await a.waitForFunction(() => document.querySelector('.status-dot')?.textContent?.includes('Live'), null, { timeout: 30000 });
  await a.getByRole('button', { name: 'Share' }).click();
  const link = await a.getByLabel('Invite link').inputValue();
  await b.goto(link);
  await b.waitForFunction(() => document.querySelector('.status-dot')?.textContent?.includes('Live'), null, { timeout: 30000 });
  await b.evaluate(() => {
    const m = window.__kairo.doc.getMap('bench');
    m.observe(() => {
      const p = m.get('ping');
      if (p !== undefined && m.get('pong') !== p) m.set('pong', p);
    });
  });
  const rtts = await a.evaluate(async (n) => {
    const m = window.__kairo.doc.getMap('bench');
    const out = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const done = new Promise((res) => {
        const h = () => m.get('pong') === i && (m.unobserve(h), res());
        m.observe(h);
      });
      m.set('ping', i);
      await done;
      out.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 20));
    }
    return out;
  }, n);
  await ca.close();
  await cb.close();
  return { transport: 'wss → Durable Object relay (wrangler dev, localhost), AES-GCM both ways', edits: n, roundTripMs: pct(rtts), oneWayEstimateMs: pct(rtts.map((x) => x / 2)) };
}

async function soakRun(browser) {
  const { ctx, page } = await benchPage(browser);
  const deadline = (SOAK_MINUTES + 3) * 60_000;
  const r = await Promise.race([
    page.evaluate((m) => window.kairoBench.soakSuite(window.__h, m, 30), SOAK_MINUTES),
    new Promise((res) => setTimeout(() => res({ error: `soak did not finish within ${deadline / 60000} min (hang)` }), deadline)),
  ]);
  await ctx.close().catch(() => undefined);
  return r;
}

mkdirSync('docs', { recursive: true }); // docs/ is gitignored, so it may not exist in a fresh clone
const server = await startServer();
const browser = await chromium.launch({ executablePath: process.env.KAIRO_CHROME || undefined, headless: true, args: browserArgs });
const report = {
  date: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}`, browser: browser.version(), headless: true },
  runs: RUNS,
};
try {
  const decode = [];
  const collab = [];
  if (SOAK_ONLY) Object.assign(report, (({ median, perRun, runs }) => ({ median, perRun, runs }))(JSON.parse((await import('node:fs')).readFileSync('docs/benchmarks.json', 'utf8'))));
  for (let i = 0; i < (SOAK_ONLY ? 0 : RUNS); i++) {
    log(`run ${i + 1}/${RUNS}: decode/playback/export`);
    decode.push(await decodeRun(browser));
    log(`run ${i + 1}/${RUNS}: collaboration latency`);
    collab.push(await collabRun(browser));
  }
  if (!SOAK_ONLY) {
    report.median = { ...medianOf(decode), collab: medianOf(collab) };
    report.perRun = { decode, collab };
  }
  writeFileSync('docs/benchmarks.json', JSON.stringify(report, null, 2));
  const soak = [];
  for (let i = 0; i < SOAK_RUNS; i++) {
    log(`soak ${i + 1}/${SOAK_RUNS} (${SOAK_MINUTES} min)`);
    soak.push(await soakRun(browser));
    report.soak = { minutes: SOAK_MINUTES, runs: soak };
    writeFileSync('docs/benchmarks.json', JSON.stringify(report, null, 2));
  }
  log('done → docs/benchmarks.json');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
