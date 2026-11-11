import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { roomId as makeRoomId } from '../lib/ids';
import { deriveRoomKeys } from './crypto';
import { WsProvider } from './ws';

/** ws(s) origin of the Kairo sync server. Defaults to the page's own origin. */
export function syncUrl(): string {
  const configured = import.meta.env.VITE_SYNC_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}

/**
 * ICE servers for peer-to-peer media, from the sync server (Cloudflare TURN when configured,
 * else STUN). Only clients holding the room key get them: the room checks the same token.
 */
export async function fetchIceServers(provider: WsProvider): Promise<{ iceServers: RTCIceServer[]; ttl: number }> {
  await provider.whenSynced; // the room has recorded its token by now
  const keys = provider.keys;
  if (!keys) throw new Error('room keys not ready');
  const res = await fetch(`${syncUrl().replace(/^ws/, 'http')}/ice/${keys.roomHash}?t=${keys.token}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface RoomConnection {
  id: string;
  doc: Y.Doc;
  provider: WsProvider;
  /** Local state loaded and the server's history replayed (or timed out while offline). */
  ready: Promise<void>;
  close(): void;
}

/** Open a room: Yjs doc + IndexedDB persistence (offline edits) + encrypted WebSocket sync. */
export function openRoom(code: string, branch: string, projectKey: string): RoomConnection {
  const id = makeRoomId(code, branch);
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(id, doc);
  const provider = new WsProvider(doc, { url: syncUrl(), keys: deriveRoomKeys(projectKey, id) });
  const ready = Promise.all([persistence.whenSynced, provider.whenSynced]).then(() => undefined);
  return {
    id,
    doc,
    provider,
    ready,
    close() {
      provider.destroy();
      void persistence.destroy();
      doc.destroy();
    },
  };
}

/** Give in-flight writes time to reach IndexedDB and the server. */
export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
