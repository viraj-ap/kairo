// Large-asset sync benchmark (Phase A): a 1 GB 1080p clip shared between isolated browser
// contexts through the real local server (wrangler dev) and a local TURN relay, like the e2e tests.
//
//   bash scripts/make-big-media.sh     # once: generates .cache/media/big_1080p.mp4 (~1 GB, not committed)
//   npm run bench:transfer             # writes docs/benchmarks-transfer.json
//
// Measures, over RUNS runs (median reported):
//   - time from B opening the invite link until B can play at the playhead (proxy header + 10 s)
//   - time until the full proxy and the full original arrive, and throughput in MB/s
// plus a resume run (A's connection killed at 40 %) and a two-holder run (A and C both hold it).
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { chromium } from '@playwright/test';
import Turn from 'node-turn';

const PORT = 4177;
const BASE = `http://localhost:${PORT}`;
const RUNS = Number(process.env.RUNS ?? 3);
const FILE = '.cache/media/big_1080p.mp4';
const ICE = JSON.stringify([{ urls: 'turn:127.0.0.1:3479?transport=udp', username: 'kairo', credential: 'kairo' }]);
const log = (...a) => console.log(`[transfer ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r2 = (x) => Math.round(x * 100) / 100;

if (!existsSync(FILE)) {
  console.error(`Missing ${FILE}. Run: bash scripts/make-big-media.sh`);
  process.exit(1);
}
const SIZE = statSync(FILE).size;

new Turn({ listeningPort: 3479, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', credentials: { kairo: 'kairo' }, debugLevel: 'OFF' }).start();
log('building…');
execSync('npx vite build', { stdio: 'ignore', env: { ...process.env, VITE_ICE_SERVERS: ICE } });
rmSync('.cache/bench-transfer-state', { recursive: true, force: true });
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', '.cache/bench-transfer-state'], { stdio: 'ignore' });
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await sleep(500);
}

const browser = await chromium.launch({
  executablePath: process.env.KAIRO_CHROME || undefined,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

const state = (page, hash) =>
  page.evaluate((h) => {
    const m = window.__kairo?.media;
    if (!m) return null;
    const s = m.stats;
    return {
      original: m.snapshot()[h] ?? null,
      proxy: m.proxySnapshot()[h] ?? null,
      firstChunkAt: s.firstChunkAt,
      completeAt: s.completeAt,
      playableAt: s.playableAt,
      received: s.received,
      receivedFrom: s.receivedFrom,
      rerequestedStored: s.rerequestedStored,
      retriedInflight: s.retriedInflight,
      duplicates: s.duplicates,
      served: s.served,
      servedLog: s.servedLog,
      order: s.order,
    };
  }, hash);

async function newProject(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.waitForFunction(() => document.querySelector('.status-dot')?.textContent?.includes('Live'), null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Share' }).click();
  const link = await page.getByLabel('Invite link').inputValue();
  await page.keyboard.press('Escape');
  return { page, link };
}

async function importBig(page) {
  const t0 = Date.now();
  await page.locator('.left-panel input[type=file]').setInputFiles(FILE);
  await page.waitForFunction(() => window.__kairo.doc.getMap('media').size > 0, null, { timeout: 600000 });
  const importMs = Date.now() - t0;
  const hash = await page.evaluate(() => [...window.__kairo.doc.getMap('media').keys()][0]);
  return { hash, importMs };
}

/** Open the invite link in a fresh isolated context and time until each milestone. */
async function join(link, hash, onProgress, maxSeconds = 1200, debugPages = []) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(link);
  const out = { playableS: null, proxyS: null, originalS: null };
  for (;;) {
    const s = await state(page, hash).catch(() => null);
    const t = (Date.now() - t0) / 1000;
    if (s) {
      if (out.playableS === null && s.proxy?.playable) out.playableS = t;
      if (out.proxyS === null && s.proxy?.state === 'ready') out.proxyS = t;
      if (s.original?.state === 'ready') {
        out.originalS = t;
        out.final = s;
        break;
      }
      if (onProgress && (await onProgress(s, t))) continue;
    }
    if (t > maxSeconds) {
      const dump = async (p) =>
        p.evaluate((h) => {
          const m = window.__kairo.media;
          return {
            original: m.snapshot()[h],
            transfers: [...m.transfers.values()].map((t) => ({ key: t.manifest.key.slice(0, 8), present: t.present.size, count: t.count, done: t.done, failed: t.failed, writing: t.writing.size })),
            links: [...m.links.values()].map((l) => ({ peer: l.peer.slice(0, 8), open: l.isOpen, inflight: l.inflightCount(), state: l.pc.connectionState })),
            holders: Object.fromEntries([...m.holders.entries()].map(([k, s]) => [k.slice(0, 8), [...s].map((p) => p.slice(0, 8))])),
            held: [...m.held].map((k) => k.slice(0, 8)),
            peerId: m.peerId.slice(0, 8),
            stats: { received: Object.values(m.stats.received), served: Object.values(m.stats.served), duplicates: m.stats.duplicates, retried: m.stats.retriedInflight },
          };
        }, hash);
      console.log('DEBUG B', JSON.stringify(await dump(page)));
      for (const [name, p] of debugPages) console.log(`DEBUG ${name}`, JSON.stringify(await dump(p)));
      throw new Error(`transfer did not finish in ${maxSeconds} s`);
    }
    await sleep(50);
  }
  return { ctx, page, ...out };
}

const report = {
  date: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30), browser: browser.version() },
  file: { path: FILE, bytes: SIZE, description: '1080p30 H.264 40 Mbit/s CBR + AAC, 200 s' },
  transport: 'WebRTC DataChannel via local TURN relay (node-turn on 127.0.0.1); signaling over the encrypted WebSocket room (wrangler dev, localhost)',
};

try {
  const ctxA = await browser.newContext();
  const { page: a, link } = await newProject(ctxA);
  log('A imports the 1 GB file…');
  const { hash, importMs } = await importBig(a);
  const tProxy0 = Date.now();
  await a.waitForFunction((h) => window.__kairo.media.proxySnapshot()[h]?.state === 'ready', hash, { timeout: 1200000, polling: 500 });
  const proxyGenMs = Date.now() - tProxy0;
  await a.evaluate((h) => window.__kairo.addMediaClip(h, 0), hash);
  const manifests = await a.evaluate(() => window.__kairo.doc.getMap('manifests').toJSON());
  const proxyKey = `${hash}.proxy`;
  const originalChunks = Math.ceil(manifests[hash].size / manifests[hash].chunkSize);
  report.import = { hashAndStoreSeconds: r2(importMs / 1000), proxyGenerationSeconds: r2(proxyGenMs / 1000), proxyBytes: manifests[proxyKey].size, originalChunks };
  log(`import ${importMs} ms, proxy ${proxyGenMs} ms (${manifests[proxyKey].size} bytes)`);

  const mbps = (bytes, s, key) => r2(bytes / 2 ** 20 / ((s.completeAt[key] - s.firstChunkAt[key]) / 1000));
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    log(`run ${i + 1}/${RUNS}: B joins`);
    const r = await join(link, hash);
    runs.push({
      playableSeconds: r2(r.playableS),
      fullProxySeconds: r2(r.proxyS),
      fullOriginalSeconds: r2(r.originalS),
      proxyMBps: mbps(manifests[proxyKey].size, r.final, proxyKey),
      originalMBps: mbps(SIZE, r.final, hash),
      rerequestedStored: r.final.rerequestedStored,
      duplicateChunks: r.final.duplicates,
    });
    log(JSON.stringify(runs.at(-1)));
    await r.ctx.close();
  }
  report.runs = runs;
  report.median = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, r2(median(runs.map((r) => r[k])))]));
  if (process.env.ONLY_TWO) report.runs = report.median = 'skipped';

  if (!process.env.ONLY_TWO) {
  log('resume: kill A at 40 % of the original');
  const servedBefore = (await state(a, hash)).served[hash] ?? 0;
  let killed = null;
  let storedAtKill = new Set();
  let servedAtKill = 0;
  const res = await join(link, hash, async (s, t) => {
    if (killed || !s.original || s.original.state !== 'fetching' || (s.original.progress ?? 0) < 0.4) return false;
    killed = { atSeconds: r2(t), progress: r2(s.original.progress), chunksStored: s.received[hash] ?? 0 };
    storedAtKill = new Set(s.order[hash] ?? []);
    servedAtKill = ((await state(a, hash)).servedLog[hash] ?? []).length;
    await a.evaluate(() => window.__kairo.media.dropPeers());
    await ctxA.setOffline(true);
    await sleep(3000);
    await ctxA.setOffline(false);
    return true;
  });
  const servedAfter = (await state(a, hash)).served[hash] ?? 0;
  const servedLog = (await state(a, hash)).servedLog[hash] ?? [];
  const thisRun = servedLog.slice(servedBefore);
  const afterKill = servedLog.slice(servedAtKill);
  const counts = new Map();
  thisRun.forEach((i) => counts.set(i, (counts.get(i) ?? 0) + 1));
  report.resume = {
    killed,
    completedSeconds: r2(res.originalS),
    hashVerified: res.final.original.state === 'ready',
    chunksTotal: originalChunks,
    chunksServedByA: servedAfter - servedBefore,
    chunksResent: servedAfter - servedBefore - originalChunks,
    distinctChunksSentTwice: [...counts.values()].filter((n) => n > 1).length,
    storedChunksResentAfterKill: afterKill.filter((i) => storedAtKill.has(i)).length,
    retriedInflight: res.final.retriedInflight,
    rerequestedStored: res.final.rerequestedStored,
  };
  log(JSON.stringify(report.resume));
  await res.ctx.close();
  }

  log('two holders: C imports the same file');
  const ctxC = await browser.newContext();
  const c = await ctxC.newPage();
  // C is a second holder only: it never starts downloading, it imports its own copy.
  await c.addInitScript(() => (window.__kairoNoFetch = true));
  await c.goto(link);
  await c.waitForFunction(() => document.querySelector('.status-dot')?.textContent?.includes('Live'), null, { timeout: 30000 });
  await c.locator('.left-panel input[type=file]').setInputFiles(FILE);
  await c.waitForFunction((h) => window.__kairo.media.snapshot()[h]?.state === 'ready', hash, { timeout: 600000, polling: 500 });
  report.twoHoldersSetup = { cGotItVia: (await state(c, hash)).original?.via };
  const two = await join(link, hash, undefined, 180, [['A', a], ['C', c]]);
  report.twoHolders = {
    fullOriginalSeconds: r2(two.originalS),
    originalMBps: mbps(SIZE, two.final, hash),
    chunksPerPeer: Object.values(two.final.receivedFrom),
    chunksNeeded: originalChunks + Math.ceil(manifests[proxyKey].size / manifests[proxyKey].chunkSize),
    duplicateChunks: two.final.duplicates,
    onePeerOriginalMBps: report.median.originalMBps,
  };
  log(JSON.stringify(report.twoHolders));
} catch (e) {
  report.error = String(e?.stack ?? e);
  console.error(e);
  process.exitCode = 1;
} finally {
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/benchmarks-transfer.json', JSON.stringify(report, null, 2));
  await browser.close();
  server.kill('SIGTERM');
  process.exit(process.exitCode ?? 0);
}
