import { describe, expect, it } from 'vitest';
import { Sealer, deriveRoomKeys, generateProjectKey, fromB64url } from '../src/sync/crypto';
import { T } from '../src/sync/protocol';

const enc = new TextEncoder();

describe('room key derivation', () => {
  it('is deterministic per key + room and separates rooms', async () => {
    const k = generateProjectKey();
    const a1 = await deriveRoomKeys(k, 'kairo:KAI-AAAAA:main');
    const a2 = await deriveRoomKeys(k, 'kairo:KAI-AAAAA:main');
    const b = await deriveRoomKeys(k, 'kairo:KAI-AAAAA:alt');
    expect(a1.roomHash).toBe(a2.roomHash);
    expect(a1.token).toBe(a2.token);
    expect(b.roomHash).not.toBe(a1.roomHash);
    expect(b.token).not.toBe(a1.token);
    expect(a1.roomHash).toMatch(/^[0-9a-f]{64}$/);
    // The server-visible id and token reveal nothing about the room name or key.
    expect(a1.roomHash).not.toContain(Buffer.from('KAI-AAAAA').toString('hex'));
    expect(fromB64url(a1.token)).toHaveLength(32);
  });
});

describe('sealing', () => {
  it('round-trips', async () => {
    const s = new Sealer(await deriveRoomKeys(generateProjectKey(), 'r'));
    const msg = enc.encode('hello timeline');
    expect(new TextDecoder().decode(await s.open(T.UPDATE, await s.seal(T.UPDATE, msg)))).toBe('hello timeline');
  });

  it('a different key cannot decrypt', async () => {
    const a = new Sealer(await deriveRoomKeys(generateProjectKey(), 'r'));
    const b = new Sealer(await deriveRoomKeys(generateProjectKey(), 'r'));
    await expect(b.open(T.UPDATE, await a.seal(T.UPDATE, enc.encode('secret')))).rejects.toThrow();
  });

  it('rejects any flipped bit (IV, ciphertext or tag)', async () => {
    const s = new Sealer(await deriveRoomKeys(generateProjectKey(), 'r'));
    const sealed = await s.seal(T.UPDATE, enc.encode('clip: "Interview take 3"'));
    for (const i of [0, 11, 12, sealed.length - 17, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[i] ^= 0x01;
      await expect(s.open(T.UPDATE, bad)).rejects.toThrow();
    }
  });

  it('binds ciphertext to its message type and room (no cross-type or cross-room replay)', async () => {
    const key = generateProjectKey();
    const main = new Sealer(await deriveRoomKeys(key, 'kairo:KAI-AAAAA:main'));
    const alt = new Sealer(await deriveRoomKeys(key, 'kairo:KAI-AAAAA:alt'));
    const sealed = await main.seal(T.AWARENESS, enc.encode('{"user":"x"}'));
    await expect(main.open(T.UPDATE, sealed)).rejects.toThrow();
    await expect(alt.open(T.AWARENESS, sealed)).rejects.toThrow();
  });

  it('never reuses an IV within a session (10 000 messages)', async () => {
    const s = new Sealer(await deriveRoomKeys(generateProjectKey(), 'r'), true);
    for (let i = 0; i < 10_000; i++) await s.seal(T.UPDATE, enc.encode(String(i)));
    expect(new Set(s.ivs).size).toBe(10_000);
    // prefix constant within the session, counter strictly increasing
    const prefixes = new Set(s.ivs!.map((iv) => iv.slice(0, 16)));
    expect(prefixes.size).toBe(1);
    expect(s.ivs!.map((iv) => parseInt(iv.slice(16), 16))).toEqual([...Array(10_000).keys()]);
  });

  it('two sessions with the same key use different IV prefixes', async () => {
    const keys = await deriveRoomKeys(generateProjectKey(), 'r');
    const a = new Sealer(keys, true);
    const b = new Sealer(keys, true);
    await a.seal(T.UPDATE, enc.encode('a'));
    await b.seal(T.UPDATE, enc.encode('b'));
    expect(a.ivs![0].slice(0, 16)).not.toBe(b.ivs![0].slice(0, 16));
  });
});
