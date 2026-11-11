import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import * as Y from 'yjs';
import { PORT } from '../playwright.config';
import { addClip, initDoc, readTimeline, setMeta, timelineHash, maps } from '../src/model/doc';
import { Sealer, deriveRoomKeys, generateProjectKey, type RoomKeys } from '../src/sync/crypto';
import { T, c2s, IV_BYTES } from '../src/sync/protocol';
import { WsProvider } from '../src/sync/ws';

// These run the real client sync code (WsProvider) in Node against `wrangler dev`, then
// inspect what the server actually stored and relayed via the debug endpoint and the
// Durable Object's SQLite files on disk.

const URL_WS = `ws://localhost:${PORT}`;
const URL_HTTP = `http://localhost:${PORT}`;
const enc = new TextEncoder();

async function waitFor(cond: () => boolean | Promise<boolean>, label = 'condition', ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function client(keys: RoomKeys | Promise<RoomKeys>) {
  const doc = new Y.Doc();
  const p = new WsProvider(doc, { url: URL_WS, keys, trackIvs: true, syncTimeoutMs: 8000 });
  return { doc, p };
}

async function dump(roomHash: string) {
  const r = await fetch(`${URL_HTTP}/debug/room/${roomHash}`);
  expect(r.ok).toBe(true);
  const j = (await r.json()) as { stored: { data: string }[]; frames: { conn: number; data: string }[]; meta: { k: string; v: string }[] };
  return {
    meta: j.meta,
    stored: j.stored.map((s) => Buffer.from(s.data, 'base64')),
    frames: j.frames.map((f) => Buffer.from(f.data, 'base64')),
  };
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? filesUnder(p) : [p];
    });
  } catch {
    return [];
  }
}

async function newRoom() {
  const key = generateProjectKey();
  const name = `kairo:KAI-SEC${Math.random().toString(36).slice(2, 4).toUpperCase()}:main`;
  return { key, name, keys: await deriveRoomKeys(key, name) };
}

test('(1) server storage, relayed bytes and logs contain no plaintext', async () => {
  const { key, name, keys } = await newRoom();
  const canaries = {
    project: 'CANARY-PROJECT-Quarterly-Launch-Film',
    text: 'CANARY-TEXT-the-secret-tagline',
    file: 'CANARY-FILE-interview-ceo-take3.mp4',
    user: 'CANARY-USER-Alice-Liddell',
    signal: 'CANARY-SIGNAL-sdp-offer',
  };
  const A = client(deriveRoomKeys(key, name));
  const B = client(deriveRoomKeys(key, name));
  await Promise.all([A.p.whenSynced, B.p.whenSynced]);
  await waitFor(() => A.p.status() === 'connected' && B.p.status() === 'connected');

  initDoc(A.doc, { projectId: 'KAI-SEC', name: canaries.project });
  setMeta(A.doc, { name: canaries.project });
  maps(A.doc).media.set('ab'.repeat(32), { kind: 'video', name: canaries.file, durationFrames: 90, width: 1920, height: 1080, fps: 30, hasAudio: true });
  addClip(A.doc, { trackId: 'trk-titles', text: canaries.text, start: 0, in: 0, out: 90 });
  A.p.awareness.setLocalState({ user: { name: canaries.user, color: '#fff' } });
  const got: unknown[] = [];
  B.p.onBroadcast((m) => got.push(m));
  A.p.broadcast({ k: 'test', sdp: canaries.signal });

  await waitFor(() => readTimeline(B.doc).clips && Object.values(readTimeline(B.doc).clips).some((c) => c.text === canaries.text));
  await waitFor(() => [...B.p.awareness.getStates().values()].some((s) => s.user?.name === canaries.user));
  await waitFor(() => got.length === 1);

  // Plaintext reached the other client (the test is not vacuous)…
  expect(readTimeline(B.doc).media['ab'.repeat(32)].name).toBe(canaries.file);

  // …but none of it is in what the server stored or relayed.
  const d = await dump(keys.roomHash);
  expect(d.stored.length).toBeGreaterThan(0);
  expect(d.frames.length).toBeGreaterThan(3);
  const needles = [...Object.values(canaries), name, 'KAI-SEC', key].map((s) => Buffer.from(s));
  for (const blob of [...d.stored, ...d.frames, Buffer.from(JSON.stringify(d.meta))]) {
    for (const n of needles) expect(blob.includes(n), `server bytes contain "${n}"`).toBe(false);
  }

  // Nor on the server's disk (Durable Object SQLite) or in its log.
  await new Promise((r) => setTimeout(r, 500));
  const files = filesUnder('e2e/.out/state');
  expect(files.length).toBeGreaterThan(0);
  for (const f of [...files, 'e2e/.out/wrangler.log']) {
    const bytes = readFileSync(f);
    for (const n of needles) expect(bytes.includes(n), `${f} contains "${n}"`).toBe(false);
  }
  A.p.destroy();
  B.p.destroy();
});

test('(2) a client with the wrong key can neither join nor decrypt', async () => {
  const { key, name, keys } = await newRoom();
  const A = client(deriveRoomKeys(key, name));
  await A.p.whenSynced;
  initDoc(A.doc, { name: 'secret project' });
  addClip(A.doc, { trackId: 'trk-titles', text: 'secret text', start: 0, in: 0, out: 30 });
  await new Promise((r) => setTimeout(r, 400));

  // Same room id (e.g. learned from server logs), different key.
  const wrong = await deriveRoomKeys(generateProjectKey(), name);
  const W = client({ ...wrong, roomHash: keys.roomHash, roomHashBytes: keys.roomHashBytes });
  await waitFor(() => W.p.status() === 'rejected');
  expect(Object.keys(readTimeline(W.doc).clips)).toHaveLength(0);
  expect(W.p.stats.received).toBe(0);

  // And with the captured ciphertext, the wrong key decrypts nothing.
  const d = await dump(keys.roomHash);
  const wrongSealer = new Sealer({ ...wrong, roomHash: keys.roomHash, roomHashBytes: keys.roomHashBytes });
  let opened = 0;
  for (const blob of d.stored) await wrongSealer.open(T.UPDATE, blob).then(() => opened++, () => undefined);
  expect(d.stored.length).toBeGreaterThan(0);
  expect(opened).toBe(0);

  // Control: the right key still joins.
  const R = client(deriveRoomKeys(key, name));
  await waitFor(() => Object.values(readTimeline(R.doc).clips).some((c) => c.text === 'secret text'));
  [A, W, R].forEach((c) => c.p.destroy());
});

test('(3) tampered or misdirected messages are rejected', async () => {
  const { key, name, keys } = await newRoom();
  const B = client(deriveRoomKeys(key, name));
  await waitFor(() => B.p.status() === 'connected');

  // An attacker on the wire (or a malicious server) with valid framing but modified ciphertext.
  const raw = new WebSocket(`${URL_WS}/sync/${keys.roomHash}?t=${keys.token}`);
  raw.binaryType = 'arraybuffer';
  await new Promise((r) => (raw.onopen = r));
  const source = new Y.Doc();
  initDoc(source, {});
  addClip(source, { trackId: 'trk-titles', text: 'INJECTED', start: 0, in: 0, out: 30 }, 'evil');
  const sealer = new Sealer(keys);
  const good = await sealer.seal(T.UPDATE, Y.encodeStateAsUpdate(source));

  const flipped = good.slice();
  flipped[IV_BYTES + 5] ^= 0xff;
  raw.send(c2s(T.UPDATE, flipped)); // ciphertext bit flip
  const badIv = good.slice();
  badIv[0] ^= 0x01;
  raw.send(c2s(T.UPDATE, badIv)); // IV modified
  raw.send(c2s(T.UPDATE, (await sealer.seal(T.AWARENESS, Y.encodeStateAsUpdate(source))))); // replayed as another type
  const other = new Sealer(await deriveRoomKeys(key, `${name}-other`));
  raw.send(c2s(T.UPDATE, await other.seal(T.UPDATE, Y.encodeStateAsUpdate(source)))); // from another room

  await waitFor(() => B.p.stats.rejected >= 4);
  expect(B.p.stats.rejected).toBe(4);
  expect(readTimeline(B.doc).clips.evil).toBeUndefined();

  // Control: the untampered message is accepted.
  raw.send(c2s(T.UPDATE, good));
  await waitFor(() => !!readTimeline(B.doc).clips.evil);
  expect(B.p.stats.rejected).toBe(4);
  raw.close();
  B.p.destroy();
});

test('(4) no IV is ever reused within a session, across reconnects and compaction', async () => {
  const { key, name, keys } = await newRoom();
  const A = client(deriveRoomKeys(key, name));
  const B = client(deriveRoomKeys(key, name));
  await waitFor(() => A.p.status() === 'connected' && B.p.status() === 'connected', 'A+B connected');
  initDoc(A.doc, {});
  const id = addClip(A.doc, { trackId: 'trk-video', start: 0, in: 0, out: 30 });
  // 260 separate updates crosses the server's 200-update compaction threshold.
  for (let i = 0; i < 130; i++) {
    maps(A.doc).clips.get(id)!.set('start', i);
    maps(B.doc).clips.get(id)?.set('opacity', (i % 10) / 10);
    if (i === 60) {
      A.p.disconnect();
      await new Promise((r) => setTimeout(r, 200));
      A.p.reconnect();
      await waitFor(() => A.p.status() === 'connected', 'A reconnected');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await waitFor(async () => (await timelineHash(readTimeline(A.doc))) === (await timelineHash(readTimeline(B.doc))), 'A/B convergence').catch((e) => {
    console.log('DIAG A', A.p.status(), A.p.stats, JSON.stringify(readTimeline(A.doc).clips));
    console.log('DIAG B', B.p.status(), B.p.stats, JSON.stringify(readTimeline(B.doc).clips));
    throw e;
  });

  const ivsA = A.p.sealer!.ivs!;
  const ivsB = B.p.sealer!.ivs!;
  expect(ivsA.length).toBeGreaterThan(100);
  expect(new Set(ivsA).size).toBe(ivsA.length);
  expect(new Set(ivsB).size).toBe(ivsB.length);
  expect(new Set([...ivsA, ...ivsB]).size).toBe(ivsA.length + ivsB.length);

  // The same, seen from the server side: every relayed or stored ciphertext has a distinct IV.
  const d = await dump(keys.roomHash);
  const serverIvs = d.frames.map((f) => (f[0] === T.SNAPSHOT ? f.subarray(5, 5 + IV_BYTES) : f.subarray(1, 1 + IV_BYTES)).toString('hex'));
  expect(serverIvs.length).toBeGreaterThan(200);
  expect(new Set(serverIvs).size).toBe(serverIvs.length);
  expect(d.frames.some((f) => f[0] === T.SNAPSHOT)).toBe(true); // compaction happened

  // A late joiner rebuilds the same timeline from the compacted log.
  const C = client(deriveRoomKeys(key, name));
  await waitFor(() => C.p.status() === 'connected', 'late joiner connected');
  expect(await timelineHash(readTimeline(C.doc))).toBe(await timelineHash(readTimeline(A.doc)));
  expect(d.stored.length).toBeLessThan(200);
  [A, B, C].forEach((c) => c.p.destroy());
});
