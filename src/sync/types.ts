import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

/** `rejected`: the server refused our room key. */
export type SyncStatus = 'connecting' | 'connected' | 'offline' | 'rejected';

/** Transport for one room: Yjs updates, awareness, and ad-hoc broadcast messages (WebRTC signaling). */
export interface SyncProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly mode: 'server';
  /** Resolves once the server's state has been replayed (or the sync timeout passed while offline). */
  readonly whenSynced: Promise<void>;
  status(): SyncStatus;
  onStatus(cb: (s: SyncStatus) => void): () => void;
  broadcast(msg: unknown): void;
  onBroadcast(cb: (msg: unknown) => void): () => void;
  destroy(): void;
}
