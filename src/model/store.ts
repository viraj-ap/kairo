import { create } from 'zustand';
import type { MediaStatus, ProxyStatus } from '../media/transfer';
import type { SyncStatus } from '../sync/types';
import type { BranchInfo, Meta, Timeline } from './schema';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  playhead: number;
  selection: string[];
  cursor: { frame: number; track: number } | null;
  hash: string;
  me: boolean;
}

export type LeftPanel = 'media' | 'text' | 'transitions' | 'effects';
export type RightTab = 'inspect' | 'collab' | 'branches' | 'history';

export interface EditorState {
  ready: boolean;
  status: SyncStatus;
  timeline: Timeline;
  meta: Meta;
  branches: Record<string, BranchInfo>;
  hash: string;
  duration: number;
  playhead: number;
  playing: boolean;
  selection: string[];
  zoom: number;
  snap: boolean;
  leftPanel: LeftPanel | null;
  rightTab: RightTab;
  peers: Peer[];
  mediaStatus: Record<string, MediaStatus>;
  proxyStatus: Record<string, ProxyStatus>;
  canUndo: boolean;
  canRedo: boolean;
  compositor: 'webgpu' | 'canvas2d' | null;
  dialog: null | 'export' | 'share' | 'merge';
  /** Branch being reviewed in the merge screen. */
  mergeBranch: string | null;
  toast: { id: number; text: string; tone?: 'error' | 'ok' } | null;
}

const emptyTimeline: Timeline = { fps: 30, media: {}, tracks: {}, clips: {} };

export const initialEditorState = (): EditorState => ({
  ready: false,
  status: 'connecting',
  timeline: emptyTimeline,
  meta: { projectId: '', name: 'Untitled project', branch: 'main', createdAt: 0, fps: 30, width: 1920, height: 1080 },
  branches: {},
  hash: '',
  duration: 0,
  playhead: 0,
  playing: false,
  selection: [],
  zoom: 4,
  snap: true,
  leftPanel: 'media',
  rightTab: 'inspect',
  peers: [],
  mediaStatus: {},
  proxyStatus: {},
  canUndo: false,
  canRedo: false,
  compositor: null,
  dialog: null,
  mergeBranch: null,
  toast: null,
});

export const useEditor = create<EditorState>(() => initialEditorState());

let toastId = 0;
export function toast(text: string, tone?: 'error' | 'ok', ms = 3200) {
  const id = ++toastId;
  useEditor.setState({ toast: { id, text, tone } });
  setTimeout(() => useEditor.getState().toast?.id === id && useEditor.setState({ toast: null }), ms);
}
