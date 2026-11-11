// Renders the demo's text graphics as PNGs with real Inter (via Chrome), for compose.sh to overlay:
// the A/B label bar, one caption per scene, the title card and the end card. Homebrew's ffmpeg is
// built without drawtext/libfreetype, and Inter is only installed here as woff2, so text is drawn
// by the browser and ffmpeg only composites (with alpha fades).
//
// Every number on the end card is read from docs/benchmarks.json; scene captions come from
// .cache/demo/markers.json (some were read live from the app's UI while recording).
//
// Writes .cache/demo/cards/*.png and .cache/demo/cards/segments.tsv.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, '.cache/demo/cards');
const DRAFT = process.argv.includes('--draft');
mkdirSync(OUT, { recursive: true });

type Marker = { scene: number; caption: string; start: number; end: number; failed?: string };
const markers = JSON.parse(readFileSync(join(ROOT, '.cache/demo/markers.json'), 'utf8')) as { scenes: Marker[]; videoStart: { A: number; B: number } };
const bench = JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks.json'), 'utf8'));

// ---- benchmark highlights, computed from the file (never typed in) ----
const med = bench.median;
const seekRuns = Object.entries(med).filter(([k]) => /seek/i.test(k)).map(([, v]) => v as { n: number; exact: number });
const seeks = seekRuns.reduce((s, r) => ({ n: s.n + r.n, exact: s.exact + r.exact }), { n: 0, exact: 0 });
const play = med.playback_3track_1080p_60s;
const exp = med.export_1080p_10s;
const highlights = [
  { big: `${Math.round((seeks.exact / seeks.n) * 1000) / 10}%`, small: `frame-accurate seeks (${seeks.exact}/${seeks.n})` },
  { big: `${play.presented}/${play.expectedFrames}`, small: `frames shown, 3-track ${play.resolution === '1920x1080' ? '1080p' : play.resolution} playback` },
  { big: `${exp.xRealtime.toFixed(1)}×`, small: `real-time ${exp.height}p MP4 export` },
];
const provenance = `${bench.machine.cpu} · Chrome ${bench.machine.browser} · median of ${bench.runs} runs · ${bench.date.slice(0, 10)}`;

const github = process.env.DEMO_GITHUB_URL ?? '';
if (!github && !DRAFT) {
  console.error('[cards] Set DEMO_GITHUB_URL (e.g. https://github.com/<you>/kairo): the repo has no GitHub URL to read, and the end card must not guess one.');
  process.exit(1);
}

// Inlined: setContent pages are about:blank and can't load file:// fonts.
const woff2 = (rel: string) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'node_modules/@fontsource', rel)).toString('base64')}`;
const font = (w: number) => woff2(`inter/files/inter-latin-${w}-normal.woff2`);
const mono = woff2('jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const page = (body: string, bg = 'transparent') => `<!doctype html><html><head><style>
${[400, 500, 600, 700, 800].map((w) => `@font-face{font-family:Inter;font-weight:${w};src:url(${font(w)})}`).join('\n')}
@font-face{font-family:Mono;src:url(${mono})}
html,body{margin:0;background:${bg};font-family:Inter;color:#f4f4f5;-webkit-font-smoothing:antialiased}
.logo{background:linear-gradient(135deg,#9dffc9,#18ff7a 35%,#00c8ff 70%,#2a2aff);-webkit-background-clip:text;color:transparent}
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.KAIRO_CHROME || undefined });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const p = await ctx.newPage();
async function shot(name: string, w: number, h: number, html: string, transparent = true) {
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(html, { waitUntil: 'load' });
  const loaded = await p.evaluate(async () => (await document.fonts.ready, [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family)));
  if (!loaded.includes('Inter')) throw new Error(`Inter did not load for ${name}`);
  await p.screenshot({ path: join(OUT, name), omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
}

// Label bar: 43 px over each 960-wide half (compose.sh scales each recording to 922×1037 under it).
const label = (name: string, who: string, color: string) =>
  `<div style="width:960px;height:43px;display:flex;align-items:center;justify-content:center;gap:10px;font-size:19px;font-weight:600;letter-spacing:.01em">
     <span style="width:11px;height:11px;border-radius:50%;background:${color}"></span>${name} <span style="color:#a1a1aa;font-weight:500">(${who})</span></div>`;
await shot('label.png', 1920, 43, page(`<div style="display:flex;background:#0b0b0c">${label('Viraj', 'A', '#18ff7a')}<div style="width:1px;background:#27272a"></div>${label('Sam', 'B', '#00c8ff')}</div>`, '#0b0b0c'), false);

// Captions: bottom-centred pill; failed scenes (draft only) are flagged in red.
const rows: string[] = [];
for (const m of markers.scenes) {
  if (m.scene === 1) continue; // the title card stands in for scene 1
  const failed = m.failed ? `<div style="font-size:18px;font-weight:600;color:#fecaca;margin-top:6px">Scene ${m.scene} failed (draft only): ${esc(m.failed.split('\n')[0].slice(0, 120))}</div>` : '';
  await shot(`cap-${m.scene}.png`, 1920, 150, page(`<div style="height:150px;display:flex;align-items:flex-end;justify-content:center">
    <div style="max-width:1500px;text-align:center;padding:16px 30px;border-radius:16px;background:${m.failed ? 'rgba(127,29,29,.92)' : 'rgba(9,9,11,.84)'};box-shadow:0 8px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08)">
      <div style="font-size:34px;font-weight:600;letter-spacing:-.01em">${esc(m.caption)}</div>${failed}</div></div>`));
  rows.push([m.scene, m.start.toFixed(3), m.end.toFixed(3), `cap-${m.scene}.png`, m.failed ? 'failed' : 'ok'].join('\t'));
}
writeFileSync(join(OUT, 'segments.tsv'), rows.join('\n') + '\n');
writeFileSync(join(OUT, 'offsets.env'), `OFF_A=${markers.videoStart.A.toFixed(3)}\nOFF_B=${markers.videoStart.B.toFixed(3)}\n`);

const card = (inner: string) =>
  page(`<div style="width:1920px;height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 35%,#18181b 0%,#09090b 70%)">${inner}</div>`, '#09090b');

const title = markers.scenes.find((m) => m.scene === 1)!.caption;
const [name, tagline] = title.split(' — ');
await shot('title.png', 1920, 1080, card(`
  <div class="logo" style="font-size:150px;font-weight:800;letter-spacing:-.04em;line-height:1">${esc(name)}</div>
  <div style="font-size:42px;font-weight:500;color:#d4d4d8;margin-top:28px;letter-spacing:-.01em">${esc(tagline ?? '')}</div>`), false);

await shot('end.png', 1920, 1080, card(`
  <div class="logo" style="font-size:110px;font-weight:800;letter-spacing:-.04em;line-height:1">Kairo</div>
  <div style="display:flex;gap:28px;margin:56px 0 18px">${highlights
    .map((h) => `<div style="width:420px;padding:30px 24px;border-radius:20px;background:#18181b;border:1px solid #27272a;text-align:center">
      <div style="font-size:72px;font-weight:700;letter-spacing:-.03em;color:#18ff7a">${esc(h.big)}</div>
      <div style="font-size:24px;color:#d4d4d8;margin-top:8px">${esc(h.small)}</div></div>`)
    .join('')}</div>
  <div style="font-size:18px;color:#71717a">${esc(provenance)}</div>
  ${github ? `<div style="font-family:Mono;font-size:34px;color:#f4f4f5;margin-top:54px">${esc(github)}</div>` : ''}
  <div style="font-size:30px;font-weight:600;color:#a1a1aa;margin-top:${github ? 18 : 54}px">Viraj Pawar</div>`), false);

await browser.close();
console.log(`[cards] ${rows.length} captions + title/end cards → ${OUT}`);
console.log(`[cards] end card: ${highlights.map((h) => `${h.big} ${h.small}`).join(' | ')}`);
