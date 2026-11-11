// Streaming-audio benchmarks (Phase C1), 3 runs each (median reported):
//   - peak memory playing + drawing the waveform of a 60-minute audio file (streaming vs old full decode)
//   - A/V drift over 5 minutes on a flash + beep sync clip
//   bash scripts/make-bench-media.sh   # once (.cache/media, not committed)
//   npm run bench:audio                # writes docs/benchmarks-audio.json
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { execSync as sh } from 'node:child_process';

/** Resident memory (MB) of every Chrome for Testing process — what the OS actually holds. */
function chromeRssMB() {
  const out = sh('ps -A -o rss=,comm=').toString();
  let kb = 0;
  for (const line of out.split('\n')) if (/Chrome for Testing|chrome-headless/i.test(line)) kb += Number(line.trim().split(/\s+/)[0]) || 0;
  return Math.round(kb / 1024);
}

/** Run `fn` while sampling browser RSS every 500 ms; returns its result plus the peak over the baseline. */
async function withRss(fn) {
  const baseline = chromeRssMB();
  let peak = baseline;
  const t = setInterval(() => (peak = Math.max(peak, chromeRssMB())), 500);
  try {
    const result = await fn();
    peak = Math.max(peak, chromeRssMB());
    return { result, baselineMB: baseline, peakMB: peak, deltaMB: peak - baseline };
  } finally {
    clearInterval(t);
  }
}
import { chromium } from '@playwright/test';

const PORT = 4178;
const BASE = `http://localhost:${PORT}`;
const RUNS = Number(process.env.RUNS ?? 3);
const DRIFT_SECONDS = Number(process.env.DRIFT_SECONDS ?? 300);
const log = (...a) => console.log(`[audio ${new Date().toISOString().slice(11, 19)}]`, ...a);
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
function medianOf(runs) {
  const [first] = runs;
  if (typeof first === 'number') return Math.round(median(runs) * 100) / 100;
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return first;
  return Object.fromEntries(Object.keys(first).map((k) => [k, medianOf(runs.map((r) => r?.[k]))]));
}

execSync('npx vite build', { stdio: 'ignore' });
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', '.cache/bench-audio-state'], { stdio: 'ignore' });
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch({
  executablePath: process.env.KAIRO_CHROME || undefined,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'],
});
const report = { date: new Date().toISOString(), machine: { cpu: os.cpus()[0]?.model, memoryGB: Math.round(os.totalmem() / 2 ** 30), browser: browser.version() }, runs: RUNS };

async function page() {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('pageerror', e.message));
  // Benchmark media is too large for static assets (25 MiB limit): serve it from disk.
  await p.route('**/bench-media/*', (route) => route.fulfill({ path: `.cache/media/${new URL(route.request().url()).pathname.split('/').pop()}` }));
  await p.goto(`${BASE}/bench`);
  await p.waitForFunction(() => 'kairoBench' in window);
  return { ctx, p };
}

try {
  const mem = [];
  const drift = [];
  for (let i = 0; i < RUNS; i++) {
    log(`run ${i + 1}/${RUNS}: 60-minute audio memory`);
    let { ctx, p } = await page();
    const hash60 = await p.evaluate(() => window.kairoBench.loadExtra('/bench-media/audio_60min.m4a'));
    const streamingRun = await withRss(() => p.evaluate((h) => window.kairoBench.audioMemorySuite(h, 20), hash60));
    await ctx.close();
    ({ ctx, p } = await page());
    await p.evaluate(() => window.kairoBench.loadExtra('/bench-media/audio_60min.m4a'));
    const legacyRun = await withRss(() => p.evaluate((h) => window.kairoBench.legacyAudioDecode(h, 10), hash60));
    await ctx.close();
    mem.push({
      ...streamingRun.result,
      processRss: {
        streaming: { baselineMB: streamingRun.baselineMB, peakMB: streamingRun.peakMB, deltaMB: streamingRun.deltaMB },
        oldFullDecode: { baselineMB: legacyRun.baselineMB, peakMB: legacyRun.peakMB, deltaMB: legacyRun.deltaMB, decodedPcmMB: legacyRun.result.decodedPcmMB },
      },
    });
    log(JSON.stringify(mem.at(-1)));
    if (process.env.ONLY_MEMORY) continue;
    log(`run ${i + 1}/${RUNS}: A/V drift over ${DRIFT_SECONDS} s`);
    ({ ctx, p } = await page());
    drift.push(await p.evaluate(async (s) => window.kairoBench.avDriftSuite(await window.kairoBench.loadExtra('/bench-media/sync_5min.mp4'), s), DRIFT_SECONDS));
    log(JSON.stringify(drift.at(-1)));
    await ctx.close();
  }
  report.memory = { median: medianOf(mem), runs: mem };
  if (drift.length) report.avDrift = { median: medianOf(drift), runs: drift };
} catch (e) {
  report.error = String(e?.stack ?? e);
  console.error(e);
  process.exitCode = 1;
} finally {
  mkdirSync('docs', { recursive: true });
  writeFileSync(process.env.OUT ?? 'docs/benchmarks-audio.json', JSON.stringify(report, null, 2));
  await browser.close();
  server.kill('SIGTERM');
  process.exit(process.exitCode ?? 0);
}
