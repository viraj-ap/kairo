import { expect, test } from '@playwright/test';
import { closeAll, twoUsers } from './helpers';

type W = { __kairo: { media: { snapshot(): Record<string, { state: string; via?: string }> }; room: { provider: { keys: { roomHash: string; token: string } } } } };

// What a deployment without TURN looks like when the two browsers have no direct route
// (VPNs, strict NATs): every WebRTC connection fails. Media with a public URL (the demo reel)
// must still arrive, and the user must be told why their own files can't.
const NO_ROUTE = `(() => {
  const P = RTCPeerConnection;
  window.RTCPeerConnection = function (c) { return new P({ ...c, iceServers: [], iceTransportPolicy: 'relay' }); };
  window.RTCPeerConnection.prototype = P.prototype;
})();`;

test('without a peer route, demo media falls back to its URL and the user is told why', async ({ browser }) => {
  const { a, b, ctxA, ctxB } = await twoUsers(browser, 'demo', { initScript: NO_ROUTE });
  await expect(a.locator('.clip')).toHaveCount(5, { timeout: 30_000 });
  await expect
    .poll(() => b.evaluate(() => Object.values((window as unknown as W).__kairo.media.snapshot())), { timeout: 45_000 })
    .toEqual(Array(4).fill({ state: 'ready', via: 'url' }));
  await expect(b.getByText("Can't connect to a collaborator directly")).toBeVisible({ timeout: 30_000 });
  await closeAll(ctxA, ctxB);
});

test('/ice hands out ICE servers only to clients holding the room key', async ({ browser, request }) => {
  const { a, ctxA, ctxB } = await twoUsers(browser);
  const keys = await a.evaluate(() => (window as unknown as W).__kairo.room.provider.keys);
  const ok = await request.get(`/ice/${keys.roomHash}?t=${keys.token}`);
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.iceServers.length).toBeGreaterThan(0);
  expect(body.ttl).toBeGreaterThan(0);
  expect((await request.get(`/ice/${keys.roomHash}?t=${'x'.repeat(43)}`)).status()).toBe(403);
  expect((await request.get(`/ice/${'0'.repeat(64)}?t=${keys.token}`)).status()).toBe(403); // a room that doesn't exist
  await closeAll(ctxA, ctxB);
});
