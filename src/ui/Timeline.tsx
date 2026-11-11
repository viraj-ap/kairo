import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Film, Lock, LockOpen, Music, Plus, Type, X } from 'lucide-react';
import { getPeaks, PEAKS_PER_SECOND } from '../media/audio';
import { getThumbnail } from '../media/thumbs';
import { addTrack, deleteTrack, updateClips, updateTrack } from '../model/doc';
import { clipKind, clipLength, sortedTracks, type Clip, type Timeline as TL, type Track } from '../model/schema';
import { useEditor, type Peer } from '../model/store';
import { formatRuler, formatTimecode } from '../lib/time';
import { moveStart, rulerStep, snapTargets, trackKindFor, trimLeft, trimRight, snap as snapTo } from '../lib/timelineMath';
import { useSession } from './session';

const HEAD = 168;
const RULER = 30;
const rowHeight = (t: Track) => (t.kind === 'audio' ? 44 : 38);

export function Timeline() {
  const session = useSession();
  const timeline = useEditor((s) => s.timeline);
  const zoom = useEditor((s) => s.zoom);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const duration = useEditor((s) => s.duration);
  const fps = useEditor((s) => s.meta.fps);
  const peers = useEditor((s) => s.peers);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1200 });
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);

  const tracks = useMemo(() => sortedTracks(timeline), [timeline]);
  const offsets = useMemo(() => {
    const o: number[] = [];
    let y = 0;
    for (const [, t] of tracks) {
      o.push(y);
      y += rowHeight(t);
    }
    o.push(y);
    return o;
  }, [tracks]);

  const contentFrames = Math.max(duration + fps * 10, Math.ceil(view.width / zoom));
  const contentW = contentFrames * zoom;

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ left: el.scrollLeft, width: el.clientWidth - HEAD }));
    };
    update();
    el.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  // Ctrl/⌘ + wheel zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const z = useEditor.getState().zoom;
      const x = e.clientX - el.getBoundingClientRect().left - HEAD + el.scrollLeft;
      const frame = x / z;
      const nz = Math.min(40, Math.max(0.05, z * Math.exp(-e.deltaY * 0.01)));
      useEditor.setState({ zoom: nz });
      requestAnimationFrame(() => (el.scrollLeft = frame * nz - (x - el.scrollLeft)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the playhead in view while playing.
  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current!;
    const x = playhead * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - HEAD - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [playhead, playing, zoom]);

  const frameAt = (clientX: number) => {
    const el = scrollRef.current!;
    return Math.max(0, Math.round((clientX - el.getBoundingClientRect().left - HEAD + el.scrollLeft) / zoom));
  };

  const trackAtY = (clientY: number): { index: number; frac: number } => {
    const el = scrollRef.current!;
    const y = clientY - el.getBoundingClientRect().top - RULER + el.scrollTop;
    for (let i = 0; i < tracks.length; i++) {
      if (y < offsets[i + 1]) return { index: i, frac: Math.max(0, (y - offsets[i]) / (offsets[i + 1] - offsets[i])) };
    }
    return { index: tracks.length - 1, frac: 1 };
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    session.seek(frameAt(e.clientX));
    const move = (ev: PointerEvent) => session.seek(frameAt(ev.clientX));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { index, frac } = trackAtY(e.clientY);
    session.setCursor({ frame: frameAt(e.clientX), track: index + frac });
  };

  // ---- clip drag / trim -------------------------------------------------

  const startClipDrag = (e: React.PointerEvent, id: string, mode: 'move' | 'left' | 'right') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = useEditor.getState();
    const t = st.timeline;
    const clip = t.clips[id];
    if (!clip || t.tracks[clip.trackId]?.locked) return;

    let selection = st.selection;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      selection = selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
      session.select(selection);
      return;
    }
    if (!selection.includes(id)) {
      selection = [id];
      session.select(selection);
    }
    const moving = mode === 'move' ? selection.filter((s) => t.clips[s] && !t.tracks[t.clips[s].trackId]?.locked) : [id];
    const orig: Record<string, Clip> = Object.fromEntries(moving.map((s) => [s, { ...t.clips[s] }]));
    const targets = snapTargets(t, new Set(moving), st.playhead);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    session.undo.stopCapturing();

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!started && mode === 'move' && Math.abs(dx) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      started = true;
      const z = useEditor.getState().zoom;
      const threshold = useEditor.getState().snap ? 8 / z : 0;
      const delta = Math.round(dx / z);
      const patches: Record<string, Partial<Clip>> = {};
      let snapped: number | null = null;

      if (mode === 'move') {
        const primary = orig[id];
        const m = moveStart(primary, delta, targets, threshold);
        snapped = m.snapped;
        const d = m.start - primary.start;
        const minStart = Math.min(...Object.values(orig).map((c) => c.start));
        const dd = Math.max(d, -minStart);
        for (const [cid, c] of Object.entries(orig)) patches[cid] = { start: c.start + dd };
        // A single clip can change tracks (same kind, unlocked).
        if (moving.length === 1) {
          const { index } = trackAtY(ev.clientY);
          const [tid, tr] = tracks[index] ?? [];
          if (tid && tr && !tr.locked && tr.kind === trackKindFor(t, primary)) patches[id].trackId = tid;
        }
      } else {
        const c = orig[id];
        const at = c.start + (mode === 'left' ? 0 : clipLength(c)) + delta;
        const s = snapTo(at, targets, threshold);
        snapped = s.snapped;
        patches[id] = mode === 'left' ? trimLeft(t, c, s.frame) : trimRight(t, c, s.frame);
      }
      setSnapLine(snapped);
      updateClips(session.doc, patches);
    };
    const up = () => {
      setSnapLine(null);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  // Stable identity so memoized clips don't re-render on every parent render.
  const dragRef = useRef(startClipDrag);
  dragRef.current = startClipDrag;
  const onClipPointerDown = useCallback((e: React.PointerEvent, id: string, mode: 'move' | 'left' | 'right') => dragRef.current(e, id, mode), []);

  // ---- drop media -------------------------------------------------------

  const onLaneDrop = async (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTrack(null);
    const frame = frameAt(e.clientX);
    const hash = e.dataTransfer.getData('application/x-kairo-media');
    if (hash) {
      const id = session.addMediaClip(hash, frame, trackId);
      if (id) session.select([id]);
      return;
    }
    let at = frame;
    for (const r of await session.importFiles([...e.dataTransfer.files])) {
      session.addMediaClip(r.hash, at, trackId);
      at += r.info.durationFrames;
    }
  };

  // ---- ruler ------------------------------------------------------------

  const step = rulerStep(zoom, fps);
  const stepFrames = step * fps;
  const firstTick = Math.floor(view.left / zoom / stepFrames) * stepFrames;
  const lastFrame = (view.left + view.width) / zoom;
  const ticks: number[] = [];
  for (let f = firstTick; f <= lastFrame + stepFrames; f += stepFrames) ticks.push(Math.round(f));
  const minorFrames = stepFrames / 5;

  const others = useMemo(() => peers.filter((p) => !p.me), [peers]);
  const peerSel = useMemo(() => {
    const m = new Map<string, Peer[]>();
    for (const p of others) for (const id of p.selection) m.set(id, [...(m.get(id) ?? []), p]);
    return m;
  }, [others]);

  return (
    <div
      className="timeline"
      ref={scrollRef}
      onPointerMove={onPointerMove}
      onPointerLeave={() => session.setCursor(null)}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="tl-inner" style={{ width: HEAD + contentW }}>
        <div className="tl-ruler-row">
          <div className="tl-corner">{formatTimecode(playhead, fps)}</div>
          <div className="tl-ruler" onPointerDown={scrub}>
            {ticks.map((f) => (
              <div key={f}>
                <div className="tl-tick" style={{ left: f * zoom, height: 9 }} />
                <div className="tl-label" style={{ left: f * zoom }}>
                  {stepFrames < fps ? `${formatRuler(f, fps)}${f % fps ? `+${f % fps}f` : ''}` : formatRuler(f, fps)}
                </div>
                {minorFrames * zoom >= 8 &&
                  [1, 2, 3, 4].map((k) => <div key={k} className="tl-tick" style={{ left: (f + k * minorFrames) * zoom, height: 4 }} />)}
              </div>
            ))}
            <div className="playhead" style={{ left: playhead * zoom, zIndex: 2 }}>
              <div className="knob" onPointerDown={scrub} />
            </div>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          {tracks.map(([tid, track]) => (
            <div key={tid} className={`tl-track ${track.kind}`}>
              <TrackHeader id={tid} track={track} clipCount={Object.values(timeline.clips).filter((c) => c.trackId === tid).length} />
              <div
                className={`tl-lane ${dropTrack === tid ? 'drop' : ''}`}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  session.select([]);
                  scrub(e);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTrack(tid);
                }}
                onDragLeave={() => setDropTrack(null)}
                onDrop={(e) => void onLaneDrop(e, tid)}
              >
                {Object.entries(timeline.clips)
                  .filter(([, c]) => c.trackId === tid)
                  .map(([cid, c]) => (
                    <ClipView
                      key={cid}
                      id={cid}
                      clip={c}
                      timeline={timeline}
                      zoom={zoom}
                      locked={!!track.locked}
                      peers={peerSel.get(cid)}
                      onPointerDown={onClipPointerDown}
                    />
                  ))}
              </div>
            </div>
          ))}

          <div className="playhead" style={{ left: HEAD + playhead * zoom, zIndex: 3 }} />
          {others.map((p) => (
            <div key={p.clientId} className="peer-playhead" style={{ left: HEAD + p.playhead * zoom, background: p.color }}>
              <span style={{ background: p.color }}>{p.name}</span>
            </div>
          ))}
          {snapLine !== null && <div className="snap-line" style={{ left: HEAD + snapLine * zoom }} />}
          {others
            .filter((p) => p.cursor)
            .map((p) => {
              const i = Math.min(tracks.length - 1, Math.floor(p.cursor!.track));
              const y = i < 0 ? 0 : offsets[i] + (p.cursor!.track - i) * (offsets[i + 1] - offsets[i]);
              return (
                <div key={p.clientId} className="peer-cursor" style={{ left: HEAD + p.cursor!.frame * zoom, top: y }}>
                  <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden>
                    <path d="M1 1l11 6.5-5 1.2-2.4 5.3z" fill={p.color} stroke="#000" strokeWidth="1" />
                  </svg>
                  <span style={{ background: p.color }}>{p.name}</span>
                </div>
              );
            })}
        </div>

        <div className="tl-add-track">
          <button className="btn ghost sm" onClick={() => addTrack(session.doc, 'video')}>
            <Plus size={12} /> Video track
          </button>
          <button className="btn ghost sm" onClick={() => addTrack(session.doc, 'audio')}>
            <Plus size={12} /> Audio
          </button>
        </div>
      </div>
    </div>
  );
}

function TrackHeader({ id, track, clipCount }: { id: string; track: Track; clipCount: number }) {
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const Icon = track.kind === 'audio' ? Music : id === 'trk-titles' ? Type : Film;
  return (
    <div className="tl-head">
      <Icon size={13} className="muted" style={{ flex: 'none' }} />
      {editing ? (
        <input
          autoFocus
          defaultValue={track.name}
          onBlur={(e) => {
            updateTrack(session.doc, id, { name: e.target.value.trim() || track.name });
            setEditing(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <span className="tname" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {track.name}
        </span>
      )}
      <button
        className={`mute ${track.muted ? 'on' : ''}`}
        onClick={() => updateTrack(session.doc, id, { muted: !track.muted || undefined })}
        title={track.muted ? 'Unmute' : 'Mute'}
        aria-pressed={!!track.muted}
      >
        M
      </button>
      {track.kind === 'video' && (
        <button className="icon-btn sm" onClick={() => updateTrack(session.doc, id, { hidden: !track.hidden || undefined })} title={track.hidden ? 'Show' : 'Hide'}>
          {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      )}
      <button className="icon-btn sm" onClick={() => updateTrack(session.doc, id, { locked: !track.locked || undefined })} title={track.locked ? 'Unlock' : 'Lock'}>
        {track.locked ? <Lock size={12} /> : <LockOpen size={12} />}
      </button>
      <button
        className="icon-btn sm del"
        title="Delete track"
        onClick={() => {
          if (clipCount && !confirm(`Delete "${track.name}" and its ${clipCount} clip${clipCount > 1 ? 's' : ''}?`)) return;
          deleteTrack(session.doc, id);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

interface ClipViewProps {
  id: string;
  clip: Clip;
  timeline: TL;
  zoom: number;
  locked: boolean;
  peers?: Peer[];
  onPointerDown: (e: React.PointerEvent, id: string, mode: 'move' | 'left' | 'right') => void;
}

const ClipView = memo(function ClipView({ id, clip, timeline, zoom, locked, peers, onPointerDown }: ClipViewProps) {
  const selected = useEditor((s) => s.selection.includes(id));
  const status = useEditor((s) => (clip.mediaHash ? s.mediaStatus[clip.mediaHash]?.state : 'ready'));
  const proxy = useEditor((s) => (clip.mediaHash ? s.proxyStatus[clip.mediaHash] : undefined));
  // Original not here, but its proxy can play: show the proxy badge instead of "unavailable".
  const onProxy = status !== 'ready' && !!proxy && (proxy.state === 'ready' || proxy.playable);
  const kind = clipKind(timeline, clip);
  const info = clip.mediaHash ? timeline.media[clip.mediaHash] : undefined;
  const len = clipLength(clip);
  const width = Math.max(2, len * zoom);
  const missing = kind !== 'text' && status !== undefined && status !== 'ready' && !onProxy;
  const label = kind === 'text' ? clip.text : info?.name ?? 'Media';
  const peer = peers?.[0];

  return (
    <div
      className={`clip ${kind} ${selected ? 'sel' : ''} ${missing ? 'missing' : ''} ${locked ? 'locked' : ''}`}
      style={{ left: clip.start * zoom, width }}
      onPointerDown={(e) => onPointerDown(e, id, 'move')}
      data-clip={id}
      title={label}
    >
      {kind === 'video' && info && status === 'ready' && <Thumbs hash={clip.mediaHash!} />}
      {(kind === 'audio' || (kind === 'video' && info?.hasAudio)) && status === 'ready' && (
        <Waveform hash={clip.mediaHash!} inFrame={clip.in} outFrame={clip.out} fps={timeline.fps} width={width} faint={kind === 'video'} />
      )}
      {clip.transitionIn && <div className="trans" style={{ width: Math.min(width, clip.transitionIn.duration * zoom) }} />}
      <div className="label">
        {kind === 'text' && <Type size={11} />}
        {label}
        {missing && <span style={{ opacity: 0.7 }}>· {status === 'fetching' || proxy?.state === 'partial' ? 'receiving…' : 'unavailable'}</span>}
        {onProxy && (
          <span className="proxy-badge" title="Playing the 540p proxy; the original is still on its way (needed for export)">
            Proxy
          </span>
        )}
      </div>
      {peers?.map((p) => <div key={p.clientId} className="peer-sel" style={{ boxShadow: `inset 0 0 0 2px ${p.color}` }} />)}
      {peer && (
        <span className="peer-tag" style={{ background: peer.color }}>
          {peer.name.split(' ')[0]}
        </span>
      )}
      {!locked && (
        <>
          <div className="handle l" onPointerDown={(e) => onPointerDown(e, id, 'left')} />
          <div className="handle r" onPointerDown={(e) => onPointerDown(e, id, 'right')} />
        </>
      )}
    </div>
  );
});

function Thumbs({ hash }: { hash: string }) {
  const info = useEditor((s) => s.timeline.media[hash]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (info) void getThumbnail(hash, info).then(setUrl);
  }, [hash, info]);
  return url ? <div className="thumbs" style={{ backgroundImage: `url(${url})` }} /> : null;
}

function Waveform({ hash, inFrame, outFrame, fps, width, faint }: { hash: string; inFrame: number; outFrame: number; fps: number; width: number; faint?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    void getPeaks(hash).then(setPeaks);
  }, [hash]);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const w = Math.min(4096, Math.ceil(width));
    const h = c.clientHeight * devicePixelRatio || 40;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = faint ? 'rgba(255,255,255,0.35)' : '#4ff59a';
    const a = (inFrame / fps) * PEAKS_PER_SECOND;
    const b = (outFrame / fps) * PEAKS_PER_SECOND;
    const per = (b - a) / w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const s = Math.floor(a + x * per);
      const e = Math.max(s + 1, Math.floor(a + (x + 1) * per));
      for (let i = s; i < e && i < peaks.length; i++) m = Math.max(m, peaks[i]);
      const bar = Math.max(1, Math.min(1, m * 1.6) * h * 0.9);
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [peaks, inFrame, outFrame, fps, width, faint]);
  return <canvas ref={ref} className="wave" />;
}
