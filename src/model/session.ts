import * as Y from 'yjs';
import { TimelineEngine, loadEngine } from '../engine';
import { loadIdentity, type Identity } from '../lib/identity';
import { upsertProject } from '../lib/projects';
import { importFile, DEMO_MEDIA, fetchAsFile } from '../media/import';
import { MediaSync } from '../media/transfer';
import { invalidateMedia, setFrameCacheCap } from '../media/decoderClient';
import { invalidateAudio } from '../media/audio/out';
import { createCompositor, type Compositor } from '../render';
import { Player } from '../render/player';
import { fetchIceServers, openRoom, type RoomConnection } from '../sync/room';
import { LOCAL, addClip, initDoc, maps, publishManifest, readBranches, readManifests, readMeta, readTimeline, registerAuthor, timelineHash } from './doc';
import { sortedTracks, type Clip, type MediaInfo } from './schema';
import { initialEditorState, toast, useEditor, type Peer } from './store';
import { trackKindFor } from '../lib/timelineMath';

interface AwarenessState {
  user?: Identity;
  playhead?: number;
  selection?: string[];
  cursor?: { frame: number; track: number } | null;
  hash?: string;
}

/**
 * Everything one open editor needs: the room, the engine, playback, media sync,
 * undo history and presence. The zustand store mirrors it for React.
 */
export class EditorSession {
  readonly room: RoomConnection;
  readonly doc: Y.Doc;
  readonly engine = new TimelineEngine();
  readonly identity = loadIdentity();
  readonly undo: Y.UndoManager;
  readonly media: MediaSync;
  player: Player | null = null;
  private compositor: Compositor | null = null;
  private disposers: (() => void)[] = [];
  private presenceTimer = 0;
  private pendingPresence: AwarenessState = {};
  private hashSeq = 0;
  private closed = false;

  constructor(
    readonly code: string,
    readonly branch: string,
    readonly projectKey: string,
  ) {
    useEditor.setState(initialEditorState());
    this.room = openRoom(code, branch, projectKey);
    this.doc = this.room.doc;
    const { tracks, clips, media } = maps(this.doc);
    this.undo = new Y.UndoManager([tracks, clips, media], { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
    this.media = new MediaSync(this.room.provider, {
      onChange: (mediaStatus, proxyStatus) => useEditor.setState({ mediaStatus, proxyStatus }),
      onStored: (hash) => {
        invalidateMedia(hash);
        invalidateAudio(hash);
        this.rerender();
      },
      publishManifest: (m) => publishManifest(this.doc, m),
      onPeerUnreachable: () =>
        toast("Can't connect to a collaborator directly, so their files can't transfer. Peer-to-peer media across networks or VPNs needs a TURN server (see README → Deploy).", 'error', 12_000),
    });
    this.media.useIce(() => fetchIceServers(this.room.provider));
    this.media.setPlayheadWindows((hash) => this.playheadWindows(hash));
    // Selective sync follows the playhead (throttled).
    let lastPlayhead = -1;
    let reprioritize = 0;
    this.disposers.push(
      useEditor.subscribe((st) => {
        if (st.playhead === lastPlayhead) return;
        lastPlayhead = st.playhead;
        clearTimeout(reprioritize);
        reprioritize = window.setTimeout(() => this.media.reprioritize(), 150);
      }),
    );

    const onUndo = () => useEditor.setState({ canUndo: this.undo.canUndo(), canRedo: this.undo.canRedo() });
    this.undo.on('stack-item-added', onUndo);
    this.undo.on('stack-item-popped', onUndo);
    this.disposers.push(() => this.undo.destroy());

    const aw = this.room.provider.awareness;
    aw.setLocalState({ user: this.identity, playhead: 0, selection: [], cursor: null, hash: '' } satisfies AwarenessState);
    const onAw = () => this.syncPeers();
    aw.on('change', onAw);
    this.disposers.push(() => aw.off('change', onAw));
    this.disposers.push(this.room.provider.onStatus((status) => useEditor.setState({ status })));
    useEditor.setState({ status: this.room.provider.status() });
  }

  /** Wait for the room and the WASM engine, initialize an empty room, start observing. */
  async start(opts: { name?: string; template?: string | null } = {}) {
    await Promise.all([this.room.ready, loadEngine()]);
    if (this.closed) return;
    // Low-memory devices get a smaller decoded-frame cache (frames are GPU memory).
    if (((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4) setFrameCacheCap(24);
    initDoc(this.doc, { projectId: this.code, branch: this.branch, name: opts.name });
    registerAuthor(this.doc, this.identity.name, this.identity.color);
    const onUpdate = () => this.refresh();
    this.doc.on('update', onUpdate);
    this.disposers.push(() => this.doc.off('update', onUpdate));
    this.refresh();
    useEditor.setState({ ready: true });
    if (opts.template === 'demo' && Object.keys(readTimeline(this.doc).clips).length === 0) {
      await this.loadDemo().catch((e) => toast(String(e.message ?? e), 'error'));
    }
  }

  private refresh() {
    const timeline = readTimeline(this.doc);
    const meta = readMeta(this.doc);
    this.engine.load(timeline);
    const duration = this.engine.duration();
    useEditor.setState({ timeline, meta, branches: readBranches(this.doc), duration });
    this.player?.setFps(meta.fps);
    this.player?.timelineChanged();
    this.media.sync(timeline.media, readManifests(this.doc));
    // Clips moved or added change where each file is needed first: re-rank pending chunks.
    this.media.reprioritize();
    const seq = ++this.hashSeq;
    void timelineHash(timeline).then((hash) => {
      if (seq !== this.hashSeq) return;
      useEditor.setState({ hash });
      this.presence({ hash });
    });
    if (this.branch === 'main') upsertProject({ code: this.code, name: meta.name, durationFrames: duration, fps: meta.fps });
    else upsertProject({ code: this.code, updatedAt: Date.now() });
  }

  async attachCanvas(canvas: HTMLCanvasElement) {
    this.compositor?.destroy();
    this.player?.destroy();
    this.compositor = await createCompositor(canvas);
    const meta = readMeta(this.doc);
    this.player = new Player(
      this.engine,
      this.compositor,
      meta.fps,
      (frame) => {
        useEditor.setState({ playhead: frame });
        this.presence({ playhead: frame });
      },
      (playing) => useEditor.setState({ playing }),
    );
    this.player.timelineChanged();
    this.player.seek(useEditor.getState().playhead);
    useEditor.setState({ compositor: this.compositor.kind });
  }

  /**
   * Where each media file is needed first, in its own seconds: the source time under the
   * playhead, or the in-point of clips starting within 10 s; nearest first.
   */
  private playheadWindows(hash: string): number[] {
    const { timeline, playhead } = useEditor.getState();
    const fps = timeline.fps;
    const out: { at: number; dist: number }[] = [];
    for (const c of Object.values(timeline.clips)) {
      if (c.mediaHash !== hash) continue;
      const end = c.start + (c.out - c.in);
      if (playhead >= c.start && playhead < end) out.push({ at: (c.in + playhead - c.start) / fps, dist: 0 });
      else if (c.start > playhead) out.push({ at: c.in / fps, dist: c.start - playhead });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.length ? out.map((o) => o.at) : [0];
  }

  rerender() {
    this.player?.requestRender(useEditor.getState().playhead);
  }

  seek(frame: number) {
    const f = Math.max(0, Math.round(frame));
    useEditor.setState({ playhead: f });
    this.player?.seek(f);
    this.presence({ playhead: f });
  }

  togglePlay() {
    this.player?.toggle();
  }

  select(ids: string[]) {
    useEditor.setState({ selection: ids });
    this.presence({ selection: ids });
  }

  setCursor(cursor: { frame: number; track: number } | null) {
    this.presence({ cursor });
  }

  /** Presence updates are throttled to 20 Hz. */
  private presence(patch: AwarenessState) {
    Object.assign(this.pendingPresence, patch);
    if (this.presenceTimer) return;
    this.presenceTimer = window.setTimeout(() => {
      this.presenceTimer = 0;
      const aw = this.room.provider.awareness;
      aw.setLocalState({ ...(aw.getLocalState() as AwarenessState), ...this.pendingPresence });
      this.pendingPresence = {};
    }, 50);
  }

  private syncPeers() {
    const aw = this.room.provider.awareness;
    const peers: Peer[] = [];
    aw.getStates().forEach((s: AwarenessState, clientId: number) => {
      if (!s.user) return;
      peers.push({
        clientId,
        name: s.user.name,
        color: s.user.color,
        playhead: s.playhead ?? 0,
        selection: s.selection ?? [],
        cursor: s.cursor ?? null,
        hash: s.hash ?? '',
        me: clientId === this.doc.clientID,
      });
    });
    peers.sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name));
    useEditor.setState({ peers });
  }

  updateIdentity(id: Identity) {
    Object.assign(this.identity, id);
    registerAuthor(this.doc, id.name, id.color);
    this.presence({ user: { ...id } });
  }

  // ---- media ------------------------------------------------------------

  async importFiles(files: File[], src?: string[]): Promise<{ hash: string; info: MediaInfo }[]> {
    const out = [];
    for (const [i, f] of files.entries()) {
      try {
        const r = await importFile(this.doc, f, src?.[i]);
        this.media.markReady(r.hash);
        this.media.sync(readTimeline(this.doc).media, readManifests(this.doc));
        out.push(r);
      } catch (e) {
        toast(String((e as Error).message ?? e), 'error');
      }
    }
    return out;
  }

  /** Put media on the timeline at `frame`, on `trackId` or the first compatible track. */
  addMediaClip(hash: string, frame = useEditor.getState().playhead, trackId?: string): string | null {
    const t = readTimeline(this.doc);
    const info = t.media[hash];
    if (!info) return null;
    const clip: Clip = { trackId: '', mediaHash: hash, start: frame, in: 0, out: Math.max(1, info.durationFrames) };
    const kind = trackKindFor(t, clip);
    const track = trackId && t.tracks[trackId]?.kind === kind ? trackId : this.trackFor(kind, clip.mediaHash);
    if (!track) return null;
    clip.trackId = track;
    return addClip(this.doc, clip);
  }

  private trackFor(kind: 'video' | 'audio', hash?: string): string | null {
    const t = readTimeline(this.doc);
    const tracks = sortedTracks(t).filter(([, tr]) => tr.kind === kind);
    if (!tracks.length) return null;
    // Prefer a track that isn't the titles track for media.
    const media = hash && kind === 'video' ? tracks.find(([id]) => id !== 'trk-titles') : null;
    return (media ?? tracks[0])[0];
  }

  addTextClip(text: string, style: Partial<Clip> = {}): string | null {
    const t = readTimeline(this.doc);
    const titles = t.tracks['trk-titles'] ? 'trk-titles' : this.trackFor('video');
    if (!titles) return null;
    const fps = t.fps;
    const start = useEditor.getState().playhead;
    const id = addClip(this.doc, { trackId: titles, text, start, in: 0, out: fps * 3, fontSize: 96, color: '#ffffff', ...style });
    this.select([id]);
    return id;
  }

  async loadDemo() {
    const files = await Promise.all(DEMO_MEDIA.map((d) => fetchAsFile(d.url, d.name)));
    const imported = await this.importFiles(files, DEMO_MEDIA.map((d) => d.url));
    const fps = readMeta(this.doc).fps;
    let at = 0;
    for (const { hash, info } of imported) {
      if (info.kind !== 'video') continue;
      const len = Math.min(info.durationFrames, fps * 4);
      const id = this.addMediaClip(hash, at, 'trk-video');
      if (id) this.doc.transact(() => maps(this.doc).clips.get(id)?.set('out', len), LOCAL);
      if (id && at > 0) this.doc.transact(() => maps(this.doc).clips.get(id)?.set('transitionIn', { kind: 'fade', duration: 12 }), LOCAL);
      at += len;
    }
    const drone = imported.find((m) => m.info.kind === 'audio');
    if (drone) {
      const id = this.addMediaClip(drone.hash, 0);
      if (id) this.doc.transact(() => maps(this.doc).clips.get(id)?.set('out', Math.min(at, drone.info.durationFrames)), LOCAL);
    }
    useEditor.setState({ playhead: 0 });
    this.addTextClip('Made with Kairo', { fontSize: 110, transitionIn: { kind: 'fade', duration: 15 } });
    this.select([]);
    this.undo.clear();
  }

  close() {
    this.closed = true;
    clearTimeout(this.presenceTimer);
    this.player?.destroy();
    this.compositor?.destroy();
    this.media.destroy();
    this.disposers.forEach((d) => d());
    this.room.close();
  }
}
