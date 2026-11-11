import { useEffect, useState } from 'react';
import { History as HistoryIcon, RotateCcw, Save } from 'lucide-react';
import { listVersions, restoreVersion, saveVersion, versionTimeline } from '../model/versions';
import { maps } from '../model/doc';
import { timelineDuration } from '../model/schema';
import { formatClock } from '../lib/time';
import { Still } from './MergeScreen';
import type { Timeline } from '../model/schema';
import { Check, GitBranch, GitMerge, Link2, Trash2, ArrowLeft, Users, AlertTriangle } from 'lucide-react';
import { createBranch } from '../model/branches';
import { deleteClips, setMeta, updateClips } from '../model/doc';
import { clipKind, clipLength, type Clip, type EffectKind, type TransitionKind } from '../model/schema';
import { toast, useEditor } from '../model/store';
import { editorPath, navigate } from '../lib/router';
import { formatTimecode, timeAgo } from '../lib/time';
import { inviteLink } from '../lib/keys';
import { useSession } from './session';

export function RightPanel() {
  const tab = useEditor((s) => s.rightTab);
  const peers = useEditor((s) => s.peers.length);
  return (
    <aside className="right-panel">
      <div className="right-tabs" role="tablist">
        {(
          [
            ['inspect', 'Inspector'],
            ['collab', `People${peers > 1 ? ` · ${peers}` : ''}`],
            ['branches', 'Branches'],
            ['history', 'History'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => useEditor.setState({ rightTab: id })}>
            {label}
          </button>
        ))}
      </div>
      <div className="right-body">
        {tab === 'inspect' && <Inspector />}
        {tab === 'collab' && <Collaborate />}
        {tab === 'branches' && <Branches />}
        {tab === 'history' && <History />}
      </div>
    </aside>
  );
}

// ---- inspector ----------------------------------------------------------------

function Slider(props: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <div className="slider-row">
      <label>{props.label}</label>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(+e.target.value)} aria-label={props.label} />
      <span className="val">{props.fmt ? props.fmt(props.value) : props.value.toFixed(2)}</span>
    </div>
  );
}

function Inspector() {
  const session = useSession();
  const selection = useEditor((s) => s.selection);
  const timeline = useEditor((s) => s.timeline);
  const meta = useEditor((s) => s.meta);
  const duration = useEditor((s) => s.duration);
  const ids = selection.filter((id) => timeline.clips[id]);

  if (!ids.length) {
    return (
      <>
        <div className="group">
          <h4>Project</h4>
          <div className="field">
            <label htmlFor="pname">Name</label>
            <input id="pname" className="input" defaultValue={meta.name} key={meta.name} onBlur={(e) => setMeta(session.doc, { name: e.target.value.trim() || meta.name })} />
          </div>
          <div className="kv"><span>Resolution</span><span>{meta.width}×{meta.height}</span></div>
          <div className="kv"><span>Frame rate</span><span>{meta.fps} fps</span></div>
          <div className="kv"><span>Duration</span><span className="mono">{formatTimecode(duration, meta.fps)}</span></div>
          <div className="kv"><span>Clips</span><span>{Object.keys(timeline.clips).length}</span></div>
          <div className="kv"><span>Media files</span><span>{Object.keys(timeline.media).length}</span></div>
        </div>
        <div className="group">
          <h4>Tips</h4>
          <p className="hint" style={{ margin: 0 }}>
            Click a clip to edit it here. <b>S</b> splits at the playhead, <b>Space</b> plays, <b>⌫</b> deletes, <b>⌥←/→</b> nudges, <b>N</b>{' '}
            toggles snapping, <b>⌘/Ctrl + scroll</b> zooms the timeline.
          </p>
        </div>
      </>
    );
  }

  const clip = timeline.clips[ids[0]];
  const kind = clipKind(timeline, clip);
  const visual = kind !== 'audio';
  const audible = kind === 'audio' || (kind === 'video' && timeline.media[clip.mediaHash ?? '']?.hasAudio);
  const set = (patch: Partial<Clip>) => updateClips(session.doc, Object.fromEntries(ids.map((id) => [id, patch])));
  const info = clip.mediaHash ? timeline.media[clip.mediaHash] : null;
  const fps = meta.fps;

  return (
    <>
      <div className="group">
        <h4>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ids.length > 1 ? `${ids.length} clips` : kind === 'text' ? 'Text' : info?.name}
          </span>
          <button
            className="icon-btn sm"
            onClick={() => {
              deleteClips(session.doc, ids);
              session.select([]);
            }}
            aria-label="Delete clip"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </h4>
        <div className="field">
          <label>Start</label>
          <input className="input mono" type="number" min={0} value={clip.start} onChange={(e) => set({ start: Math.max(0, Math.round(+e.target.value)) })} />
        </div>
        <div className="field">
          <label>Length</label>
          <input
            className="input mono"
            type="number"
            min={1}
            value={clipLength(clip)}
            onChange={(e) => {
              const len = Math.max(1, Math.round(+e.target.value));
              const max = kind === 'video' || kind === 'audio' ? (info?.durationFrames ?? Infinity) : Infinity;
              set({ out: Math.min(clip.in + len, max) });
            }}
          />
        </div>
        <div className="hint">
          {formatTimecode(clip.start, fps)} → {formatTimecode(clip.start + clipLength(clip), fps)} · frames at {fps} fps
        </div>
      </div>

      {kind === 'text' && (
        <div className="group">
          <h4>Text</h4>
          <textarea className="input" value={clip.text} onChange={(e) => set({ text: e.target.value })} aria-label="Text" />
          <Slider label="Size" min={16} max={300} step={1} value={clip.fontSize ?? 96} onChange={(v) => set({ fontSize: v })} fmt={(v) => `${v}px`} />
          <div className="field">
            <label>Weight</label>
            <select className="input" value={clip.fontWeight ?? 700} onChange={(e) => set({ fontWeight: +e.target.value })}>
              <option value={400}>Regular</option>
              <option value={500}>Medium</option>
              <option value={600}>Semibold</option>
              <option value={700}>Bold</option>
            </select>
          </div>
          <div className="field">
            <label>Colors</label>
            <div className="row">
              <input type="color" value={clip.color ?? '#ffffff'} onChange={(e) => set({ color: e.target.value })} aria-label="Text color" />
              <input type="color" value={(clip.background ?? '#000000').slice(0, 7)} onChange={(e) => set({ background: `${e.target.value}cc` })} aria-label="Background color" />
              {clip.background && (
                <button className="btn ghost sm" onClick={() => set({ background: undefined })}>
                  No background
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {visual && (
        <div className="group">
          <h4>
            Transform
            <button className="btn ghost sm" onClick={() => set({ x: undefined, y: undefined, scale: undefined, opacity: undefined })}>
              Reset
            </button>
          </h4>
          <Slider label="Position X" min={-1} max={1} step={0.005} value={clip.x ?? 0} onChange={(v) => set({ x: v })} />
          <Slider label="Position Y" min={-1} max={1} step={0.005} value={clip.y ?? 0} onChange={(v) => set({ y: v })} />
          <Slider label="Scale" min={0.1} max={3} step={0.01} value={clip.scale ?? 1} onChange={(v) => set({ scale: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Opacity" min={0} max={1} step={0.01} value={clip.opacity ?? 1} onChange={(v) => set({ opacity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
        </div>
      )}

      {visual && kind !== 'text' && (
        <div className="group">
          <h4>
            Color
            <button className="btn ghost sm" onClick={() => set({ brightness: undefined, contrast: undefined, saturation: undefined, effect: undefined })}>
              Reset
            </button>
          </h4>
          <Slider label="Brightness" min={-0.5} max={0.5} step={0.01} value={clip.brightness ?? 0} onChange={(v) => set({ brightness: v || undefined })} />
          <Slider label="Contrast" min={0.3} max={2} step={0.01} value={clip.contrast ?? 1} onChange={(v) => set({ contrast: v === 1 ? undefined : v })} />
          <Slider label="Saturation" min={0} max={2} step={0.01} value={clip.saturation ?? 1} onChange={(v) => set({ saturation: v === 1 ? undefined : v })} />
          <div className="field">
            <label>Effect</label>
            <select className="input" value={clip.effect ?? 'none'} onChange={(e) => set({ effect: e.target.value === 'none' ? undefined : (e.target.value as EffectKind) })}>
              {['none', 'grayscale', 'sepia', 'invert', 'duotone', 'vignette', 'posterize', 'scanlines'].map((x) => (
                <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {visual && (
        <div className="group">
          <h4>Transition in</h4>
          <div className="field">
            <label>Type</label>
            <select
              className="input"
              value={clip.transitionIn?.kind ?? 'none'}
              onChange={(e) => set({ transitionIn: e.target.value === 'none' ? undefined : { kind: e.target.value as TransitionKind, duration: clip.transitionIn?.duration ?? Math.round(fps / 2) } })}
            >
              <option value="none">None</option>
              <option value="fade">Fade</option>
              <option value="wipe">Wipe</option>
              <option value="slide">Slide</option>
              <option value="zoom">Zoom</option>
            </select>
          </div>
          {clip.transitionIn && (
            <Slider
              label="Duration"
              min={2}
              max={fps * 3}
              step={1}
              value={clip.transitionIn.duration}
              onChange={(v) => set({ transitionIn: { ...clip.transitionIn!, duration: v } })}
              fmt={(v) => `${(v / fps).toFixed(1)}s`}
            />
          )}
        </div>
      )}

      {audible && (
        <div className="group">
          <h4>Audio</h4>
          <Slider label="Volume" min={0} max={2} step={0.01} value={clip.volume ?? 1} onChange={(v) => set({ volume: v === 1 ? undefined : v })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <label className="row" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={!!clip.muted} onChange={(e) => set({ muted: e.target.checked || undefined })} /> Mute this clip
          </label>
        </div>
      )}

      {info && (
        <div className="group">
          <h4>Source</h4>
          <div className="kv"><span>File</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170, whiteSpace: 'nowrap' }}>{info.name}</span></div>
          {info.kind !== 'audio' && <div className="kv"><span>Size</span><span>{info.width}×{info.height}</span></div>}
          {info.codec && <div className="kv"><span>Codec</span><span className="mono">{info.codec}</span></div>}
          <div className="kv"><span>SHA-256</span><span className="mono" title={clip.mediaHash}>{clip.mediaHash?.slice(0, 12)}…</span></div>
        </div>
      )}
    </>
  );
}

// ---- collaborate ------------------------------------------------------------

function Collaborate() {
  const session = useSession();
  const peers = useEditor((s) => s.peers);
  const hash = useEditor((s) => s.hash);
  const status = useEditor((s) => s.mediaStatus);
  const media = useEditor((s) => s.timeline.media);
  const others = peers.filter((p) => !p.me);
  const converged = others.length > 0 && others.every((p) => p.hash === hash);
  const transfers = Object.entries(status).filter(([, s]) => s.state !== 'ready');

  return (
    <>
      <div className="group">
        <h4>Room</h4>
        <div className="code-box">
          <span className="code">{session.code}</span>
          <span className="badge ok">end-to-end encrypted</span>
        </div>
        <button
          className="btn block"
          onClick={() => {
            void navigator.clipboard.writeText(inviteLink(session.code, session.branch));
            toast('Link copied', 'ok');
          }}
        >
          <Link2 size={14} /> Copy invite link
        </button>
        <p className="hint" style={{ margin: 0 }}>
          The invite link carries the room key after #k=. The server only relays and stores ciphertext; only edits and cursors travel, never media.
        </p>
      </div>

      <div className="group">
        <h4>
          <span className="row" style={{ gap: 6 }}><Users size={13} /> In this room · {peers.length}</span>
        </h4>
        {peers.map((p) => (
          <div key={p.clientId} className="person">
            <span className="avatar" style={{ background: p.color }}>{p.name[0]?.toUpperCase()}</span>
            <div className="grow">
              <div style={{ fontWeight: 500 }}>
                {p.name} {p.me && <span className="faint">(you)</span>}
              </div>
              <div className="faint mono" style={{ fontSize: 10.5 }}>
                @ {formatTimecode(p.playhead, useEditor.getState().meta.fps)}
                {p.selection.length > 0 && ` · ${p.selection.length} selected`}
              </div>
            </div>
            {!p.me && p.hash && (p.hash === hash ? <Check size={14} color="var(--k-green)" /> : <span className="badge warn">syncing</span>)}
          </div>
        ))}
      </div>

      <div className="group">
        <h4>
          Timeline hash
          {others.length > 0 && <span className={`badge ${converged ? 'ok' : 'warn'}`}>{converged ? 'all converged' : 'converging'}</span>}
        </h4>
        <div className="hash-box" title="SHA-256 of the canonical timeline JSON">{hash || '…'}</div>
        <p className="hint" style={{ margin: 0 }}>Every client computes this from its own copy. Matching hashes prove the CRDT converged.</p>
      </div>

      {transfers.length > 0 && (
        <div className="group">
          <h4>Media transfers</h4>
          {transfers.map(([h, s]) => (
            <div key={h} className="col" style={{ gap: 4 }}>
              <div className="kv">
                <span>{media[h]?.name ?? h.slice(0, 10)}</span>
                <span className={`badge ${s.state === 'fetching' ? 'info' : 'warn'}`}>
                  {s.state === 'fetching' ? `${s.via === 'url' ? 'downloading' : 'from peer'} ${s.progress != null ? Math.round(s.progress * 100) + '%' : ''}` : s.state}
                </span>
              </div>
              {s.state === 'fetching' && (
                <div className="progress-bar">
                  <div style={{ width: `${(s.progress ?? 0) * 100}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- branches -----------------------------------------------------------------

function Branches() {
  const session = useSession();
  const branches = useEditor((s) => s.branches);
  const meta = useEditor((s) => s.meta);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const onMain = session.branch === 'main';

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const slug = await createBranch(session, name);
      setName('');
      toast(`Created branch ${slug}`, 'ok');
      navigate(editorPath(session.code, slug));
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally {
      setBusy(false);
    }
  };

  const review = (slug: string) => useEditor.setState({ dialog: 'merge', mergeBranch: slug });

  if (!onMain) {
    return (
      <>
        <div className="group">
          <h4>Current branch</h4>
          <div className="branch-item">
            <GitBranch size={14} color="var(--k-cyan)" />
            <div className="grow">
              <div className="name">{session.branch}</div>
              <div className="faint" style={{ fontSize: 11 }}>from {meta.parent ?? 'main'} · {timeAgo(meta.createdAt)}</div>
            </div>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            This branch is its own live room: collaborators here see each other, but nothing reaches main until you merge.
          </p>
          <button className="btn accent block" onClick={() => review(session.branch)}>
            <GitMerge size={14} /> Review &amp; merge into main
          </button>
          <button className="btn block" onClick={() => navigate(editorPath(session.code))}>
            <ArrowLeft size={14} /> Back to main
          </button>
        </div>
      </>
    );
  }

  const list = Object.entries(branches).sort((a, b) => b[1].createdAt - a[1].createdAt);
  return (
    <>
      <div className="group">
        <h4>New branch</h4>
        <p className="hint" style={{ margin: 0 }}>Snapshot main, try an alternative cut in isolation, then merge back only the changes you want.</p>
        <div className="row">
          <input
            className="input"
            placeholder="e.g. faster-intro"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            aria-label="Branch name"
          />
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            Create
          </button>
        </div>
      </div>
      <div className="group">
        <h4>Branches · {list.length}</h4>
        <div className="branch-item">
          <GitBranch size={14} />
          <div className="grow">
            <div className="name">main</div>
            <div className="faint" style={{ fontSize: 11 }}>you are here</div>
          </div>
        </div>
        {list.length === 0 && <p className="hint">No branches yet.</p>}
        {list.map(([slug, b]) => (
          <div key={slug} className="branch-item" style={{ flexWrap: 'wrap' }}>
            <GitBranch size={14} color="var(--k-cyan)" />
            <div className="grow">
              <div className="name">{slug}</div>
              <div className="faint" style={{ fontSize: 11 }}>
                {b.createdBy} · {timeAgo(b.createdAt)}
                {b.mergedAt && ` · merged ${timeAgo(b.mergedAt)}`}
              </div>
            </div>
            {b.mergedAt && <span className="badge ok">merged</span>}
            <div className="row" style={{ width: '100%', paddingLeft: 22 }}>
              <button className="btn sm" onClick={() => navigate(editorPath(session.code, slug))}>
                Open
              </button>
              <button className="btn sm" onClick={() => review(slug)}>
                <GitMerge size={12} /> Review &amp; merge
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="group">
        <p className="hint" style={{ margin: 0, display: 'flex', gap: 6 }}>
          <AlertTriangle size={13} style={{ flex: 'none', marginTop: 1 }} />
          Same-field edits by two people at once resolve last-writer-wins. Use a branch for larger divergent work.
        </p>
      </div>
    </>
  );
}

// ---- history ------------------------------------------------------------------

function History() {
  const session = useSession();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    const versions = maps(session.doc).versions;
    const on = () => bump((x) => x + 1);
    versions.observe(on);
    return () => versions.unobserve(on);
  }, [session]);
  const versions = listVersions(session.doc);
  const fps = useEditor((s) => s.meta.fps);
  const preview = selected ? versionTimeline(session.doc, selected) : null;

  return (
    <>
      <div className="group">
        <h4>Save a version</h4>
        <p className="hint" style={{ margin: 0 }}>A named snapshot of the whole timeline, stored encrypted in this room. Restoring is one undoable step.</p>
        <div className="row">
          <input
            className="input"
            placeholder="e.g. Rough cut v1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                saveVersion(session.doc, name, session.identity.name);
                setName('');
              }
            }}
            aria-label="Version name"
          />
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => {
              saveVersion(session.doc, name, session.identity.name);
              setName('');
              toast('Version saved', 'ok');
            }}
          >
            <Save size={13} /> Save version
          </button>
        </div>
      </div>
      <div className="group">
        <h4>
          <span className="row" style={{ gap: 6 }}><HistoryIcon size={13} /> Versions · {versions.length}</span>
        </h4>
        {versions.length === 0 && <p className="hint">No saved versions yet.</p>}
        {versions.map((v) => (
          <div key={v.id} className={`branch-item version ${selected === v.id ? 'on' : ''}`} onClick={() => setSelected(selected === v.id ? null : v.id)} data-testid="version">
            <div className="grow">
              <div className="name">{v.name}</div>
              <div className="faint" style={{ fontSize: 11 }}>
                {v.createdBy} · {timeAgo(v.createdAt)}
              </div>
            </div>
          </div>
        ))}
        {preview && selected && (
          <div className="col" style={{ gap: 8 }}>
            <div className="kv"><span>Clips</span><span>{Object.keys(preview.clips).length}</span></div>
            <div className="kv"><span>Duration</span><span className="mono">{formatClock(timelineDuration(preview), fps)}</span></div>
            <VersionStill timeline={preview} />
            <button
              className="btn block"
              onClick={() => {
                restoreVersion(session.doc, session.undo, selected);
                toast('Version restored — undo with ⌘Z', 'ok');
              }}
            >
              <RotateCcw size={13} /> Restore this version
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** What the version looked like at the current playhead. */
function VersionStill({ timeline }: { timeline: Timeline }) {
  const playhead = useEditor((s) => s.playhead);
  return <Still label="" timeline={timeline} frame={playhead} slot="ver:" width={280} />;
}
