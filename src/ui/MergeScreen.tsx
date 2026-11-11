import { useEffect, useMemo, useRef, useState } from 'react';
import { GitMerge, X, AlertTriangle, ChevronRight, ChevronDown, Repeat } from 'lucide-react';
import type * as Y from 'yjs';
import { diffGrouped, merge, TimelineEngine, type Change, type ChangeGroup, type Conflict } from '../engine';
import { applyMerge, baseOf } from '../model/branches';
import { describeConflict, describeShift, shortTime } from '../model/conflicts';
import { fieldAuthor, readMeta, readTimeline } from '../model/doc';
import { clipEnd, clipKind, sortedTracks, timelineDuration, type Clip, type Timeline } from '../model/schema';
import { toast, useEditor } from '../model/store';
import { createCompositor, type Compositor } from '../render';
import { gather } from '../render/frame';
import { openRoom, settle, type RoomConnection } from '../sync/room';
import { editorPath, navigate } from '../lib/router';
import { formatTimecode } from '../lib/time';
import { canonicalJson } from '../lib/hash';
import { useSession } from './session';

interface Loaded {
  base: Timeline;
  main: Timeline;
  branch: Timeline;
  mainDoc: Y.Doc;
  branchDoc: Y.Doc;
}

/**
 * Review a branch against main: visual diff, pick changes, resolve conflicts with
 * side-by-side previews, then apply the result to main as one Yjs transaction.
 */
export function MergeScreen() {
  const session = useSession();
  const slug = useEditor((s) => s.mergeBranch)!;
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [resolutions, setResolutions] = useState<Record<string, 'main' | 'branch'>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useEditor.setState({ dialog: null, mergeBranch: null });

  // Load the other side: main if we're on the branch, the branch if we're on main.
  useEffect(() => {
    let conn: RoomConnection | null = null;
    let cancelled = false;
    (async () => {
      const onBranch = session.branch === slug;
      conn = openRoom(session.code, onBranch ? 'main' : slug, session.projectKey);
      await conn.ready;
      if (cancelled) return;
      const branchDoc = onBranch ? session.doc : conn.doc;
      const mainDoc = onBranch ? conn.doc : session.doc;
      const base = baseOf(readMeta(branchDoc).baseSnapshot);
      if (!base) throw new Error(`Branch "${slug}" has no base snapshot`);
      const loaded = { base, main: readTimeline(mainDoc), branch: readTimeline(branchDoc), mainDoc, branchDoc };
      setData(loaded);
      setPicked(new Set(diffGrouped(loaded.base, loaded.main, loaded.branch).changes.map((c) => c.id)));
    })().catch((e) => setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
      // Keep the connection open briefly so a just-applied merge reaches the network.
      const c = conn;
      if (c && c.doc !== session.doc) void settle(800).then(() => c.close());
    };
  }, [session, slug]);

  const grouped = useMemo(() => (data ? diffGrouped(data.base, data.main, data.branch) : { changes: [] as Change[], groups: [] as ChangeGroup[] }), [data]);
  const changes = grouped.changes;
  const groupOf = useMemo(() => {
    const m = new Map<string, ChangeGroup>();
    grouped.groups.forEach((g) => g.members.forEach((id) => m.set(id, g)));
    return m;
  }, [grouped]);

  /** "You", a collaborator's name, or a fallback, for whoever last wrote this field on a side. */
  const authorOf = (side: 'main' | 'branch', clipKey: string, field: string): string => {
    if (!data) return '';
    const doc = side === 'main' ? data.mainDoc : data.branchDoc;
    const who = fieldAuthor(doc, clipKey, field);
    if (who && who === session.identity.name) return 'You';
    return who ?? (side === 'main' ? 'Someone on main' : `Someone on ${slug}`);
  };
  const outcome = useMemo(
    () => (data ? merge(data.base, data.main, data.branch, { changes: [...picked], resolutions }) : null),
    [data, picked, resolutions],
  );
  const conflictsBy = useMemo(() => {
    const m = new Map<string, Conflict[]>();
    outcome?.conflicts.forEach((c) => m.set(c.changeId, [...(m.get(c.changeId) ?? []), c]));
    return m;
  }, [outcome]);
  const unresolved = outcome?.conflicts.filter((c) => !c.resolution).length ?? 0;

  const apply = async () => {
    if (!data || !outcome) return;
    setBusy(true);
    applyMerge(data.base, data.mainDoc, data.branchDoc, slug, { changes: [...picked], resolutions });
    await settle(700);
    toast(`Merged ${picked.size} change${picked.size === 1 ? '' : 's'} from ${slug} into main`, 'ok');
    close();
    if (session.branch !== 'main') navigate(editorPath(session.code));
  };

  const focusClip = focus ? focus.split(':')[1] : null;
  const previewFrame = useMemo(() => {
    if (!data || !focusClip) return 0;
    const c = data.branch.clips[focusClip] ?? data.main.clips[focusClip] ?? data.base.clips[focusClip];
    return c ? c.start + Math.floor((c.out - c.in) / 2) : 0;
  }, [data, focusClip]);
  const [frame, setFrame] = useState(0);
  useEffect(() => setFrame(previewFrame), [previewFrame]);

  const total = data ? Math.max(timelineDuration(data.main), timelineDuration(data.branch), timelineDuration(data.base), 1) : 1;

  return (
    <div className="merge" role="dialog" aria-label="Merge branch">
      <header>
        <GitMerge size={17} color="var(--k-cyan)" />
        <h2>
          Merge <span className="branch-chip">{slug}</span> → <span className="branch-chip main">main</span>
        </h2>
        <div className="grow" />
        {outcome && (
          <span className="muted" style={{ fontSize: 12 }}>
            {picked.size}/{changes.length} changes selected
            {outcome.conflicts.length > 0 && ` · ${outcome.conflicts.length - unresolved}/${outcome.conflicts.length} conflicts resolved`}
          </span>
        )}
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn accent" disabled={!data || busy || picked.size === 0} onClick={() => void apply()}>
          <GitMerge size={14} /> {busy ? 'Merging…' : unresolved ? `Merge (keep main for ${unresolved})` : 'Merge into main'}
        </button>
        <button className="icon-btn" onClick={close} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      {error ? (
        <div className="center-screen"><p>{error}</p></div>
      ) : !data || !outcome ? (
        <div className="center-screen"><div className="spinner" /></div>
      ) : (
        <div className="merge-body">
          <div className="merge-list">
            {changes.length === 0 && <p className="hint" style={{ padding: 8 }}>No changes on this branch since it was created.</p>}
            {changes.length > 0 && (
              <label className="row" style={{ padding: '2px 4px 6px', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={picked.size === changes.length}
                  onChange={(e) => setPicked(new Set(e.target.checked ? changes.map((c) => c.id) : []))}
                />
                Select all
              </label>
            )}
            {grouped.groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                data={data}
                picked={g.members.every((id) => picked.has(id))}
                onToggle={(on) => {
                  const n = new Set(picked);
                  g.members.forEach((id) => (on ? n.add(id) : n.delete(id)));
                  setPicked(n);
                }}
                onFocus={(id) => setFocus(id)}
              />
            ))}
            {changes
              .filter((c) => !groupOf.has(c.id))
              .map((c) => (
                <ChangeRow
                  key={c.id}
                  change={c}
                  data={data}
                  picked={picked.has(c.id)}
                  focused={focus === c.id}
                  conflicts={conflictsBy.get(c.id) ?? []}
                  authorOf={authorOf}
                  onToggle={() => {
                    const n = new Set(picked);
                    if (n.has(c.id)) n.delete(c.id);
                    else n.add(c.id);
                    setPicked(n);
                  }}
                  onFocus={() => setFocus(c.id)}
                  onResolve={(id, side) => setResolutions({ ...resolutions, [id]: side })}
                />
              ))}
          </div>

          <div className="merge-main">
            {focusClip && (conflictsBy.get(focus!)?.length ?? 0) > 0 && (
              <LoopPlayer main={data.main} branch={data.branch} result={outcome.result} clipKey={focusClip} />
            )}
            <div className="compare">
              <Still label="Main now" timeline={data.main} frame={frame} slot="mm:" />
              <Still label={`Branch ${slug}`} timeline={data.branch} frame={frame} slot="mb:" />
              <Still label="Merge result" timeline={outcome.result} frame={frame} slot="mr:" accent />
            </div>
            <div className="row">
              <span className="mono muted" style={{ fontSize: 11.5, width: 96 }}>{formatTimecode(frame, data.main.fps)}</span>
              <input type="range" min={0} max={total - 1} value={frame} onChange={(e) => setFrame(+e.target.value)} className="grow" aria-label="Preview frame" />
            </div>

            <div>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <b style={{ fontSize: 13 }}>Visual diff</b>
                <div className="legend">
                  <span><i style={{ background: 'rgba(24,255,122,0.5)' }} />added</span>
                  <span><i style={{ background: 'rgba(0,200,255,0.5)' }} />moved / trimmed / edited</span>
                  <span><i style={{ background: 'rgba(255,90,90,0.6)' }} />removed</span>
                  <span><i style={{ background: 'rgba(255,181,71,0.6)' }} />conflict</span>
                </div>
              </div>
              <DiffTimeline title="Main" timeline={data.main} base={data.base} total={total} changes={changes} side="main" onPick={setFocus} frame={frame} highlight={focusClip} />
              <div style={{ height: 10 }} />
              <DiffTimeline title={slug} timeline={data.branch} base={data.base} total={total} changes={changes} side="branch" onPick={setFocus} frame={frame} highlight={focusClip} />
              <div style={{ height: 10 }} />
              <DiffTimeline title="Result" timeline={outcome.result} base={data.main} total={total} changes={changes} side="result" onPick={setFocus} frame={frame} highlight={focusClip} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<Change['kind'], string> = { added: 'Added', removed: 'Removed', moved: 'Moved', trimmed: 'Trimmed', props: 'Edited' };

function describe(t: Timeline, entity: string, key: string): string {
  if (entity === 'track') return `Track “${t.tracks[key]?.name ?? key}”`;
  const c = t.clips[key];
  if (!c) return key;
  return clipKind(t, c) === 'text' ? `Text “${c.text}”` : t.media[c.mediaHash ?? '']?.name ?? key;
}

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? (v as { kind?: string }).kind ?? 'clip' : String(v));

function ChangeRow(props: {
  change: Change;
  data: Loaded;
  picked: boolean;
  focused: boolean;
  conflicts: Conflict[];
  authorOf: (side: 'main' | 'branch', clipKey: string, field: string) => string;
  onToggle: () => void;
  onFocus: () => void;
  onResolve: (id: string, side: 'main' | 'branch') => void;
}) {
  const { change: c, data } = props;
  const name = describe(c.kind === 'removed' ? data.base : data.branch, c.entity, c.key);
  const plainName = clipName(data, c.key);
  return (
    <div className={`change ${c.conflict ? 'conflict' : ''} ${props.focused ? 'focus' : ''}`} onClick={props.onFocus}>
      <div className="top">
        <input type="checkbox" checked={props.picked} onChange={props.onToggle} onClick={(e) => e.stopPropagation()} aria-label={`Include ${name}`} />
        <span className={`badge ${c.kind === 'added' ? 'ok' : c.kind === 'removed' ? 'danger' : 'info'}`}>{KIND_LABEL[c.kind]}</span>
        <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{name}</span>
        {c.conflict && <AlertTriangle size={14} color="var(--warn)" />}
      </div>
      {c.kind !== 'added' && c.kind !== 'removed' && <div className="fields">{c.fields.join(', ')}</div>}
      {props.picked &&
        props.conflicts.map((k) => {
          // For delete-vs-edit, attribute the edit to whoever last wrote one of its changed fields.
          const f = k.field === '*' ? (c.fields[0] ?? 'start') : k.field;
          const words = describeConflict(k, {
            name: plainName,
            fps: data.main.fps,
            trackName: (id) => data.branch.tracks[id]?.name ?? data.main.tracks[id]?.name ?? id,
            mainAuthor: props.authorOf('main', c.key, f),
            branchAuthor: props.authorOf('branch', c.key, f),
          });
          return (
          <div key={k.id} className="col" style={{ gap: 6 }}>
            <div className="conflict-line" data-testid="conflict-line">{words.line}</div>
            <div className="conflict-thumbs">
              <ConflictThumb label={words.main} timeline={data.main} clipKey={c.key} slot="ct-m:" />
              <ConflictThumb label={words.branch} timeline={data.branch} clipKey={c.key} slot="ct-b:" />
            </div>
            <div className="resolve">
              <button className={k.resolution !== 'branch' ? 'on' : ''} onClick={(e) => (e.stopPropagation(), props.onResolve(k.id, 'main'))}>
                <small>Keep main</small>
                {k.field === '*' ? (k.main === null ? 'deleted' : 'keep clip') : show(k.main)}
              </button>
              <button className={k.resolution === 'branch' ? 'on' : ''} onClick={(e) => (e.stopPropagation(), props.onResolve(k.id, 'branch'))}>
                <small>Take branch</small>
                {k.field === '*' ? (k.branch === null ? 'delete' : 'restore clip') : show(k.branch)}
              </button>
            </div>
          </div>
          );
        })}
    </div>
  );
}

function DiffTimeline(props: {
  title: string;
  timeline: Timeline;
  base: Timeline;
  total: number;
  changes: Change[];
  side: 'main' | 'branch' | 'result';
  frame: number;
  highlight?: string | null;
  onPick: (id: string) => void;
}) {
  const { timeline: t, base, total } = props;
  const hl = (id: string) => (props.highlight === id ? ' highlight' : '');
  const byId = new Map(props.changes.map((c) => [c.key, c]));
  const tracks = sortedTracks(t);
  const pct = (f: number) => `${(f / total) * 100}%`;
  const statusOf = (id: string, c: Clip): string => {
    const ch = byId.get(id);
    if (props.side === 'branch' && ch) return ch.conflict ? 'conflict' : ch.kind === 'added' ? 'added' : 'changed';
    if (props.side === 'main') return ch?.conflict ? 'conflict' : 'same';
    const b = base.clips[id];
    if (!b) return 'added';
    return canonicalJson(b) === canonicalJson(c) ? 'same' : 'changed';
  };
  // Clips that existed in base but are gone on this side.
  const ghosts = props.side !== 'main' ? Object.entries(base.clips).filter(([id]) => !t.clips[id]) : [];
  return (
    <div className="diff-tl">
      <div style={{ padding: '6px 10px', fontSize: 11.5, fontWeight: 600, borderBottom: '1px solid var(--border)', color: 'var(--text-2)' }}>{props.title}</div>
      {tracks.map(([tid, tr]) => (
        <div key={tid} className="row">
          <span className="lane-name">{tr.name}</span>
          <div className="lane">
            {Object.entries(t.clips)
              .filter(([, c]) => c.trackId === tid)
              .map(([id, c]) => (
                <div key={id} className={`diff-clip ${statusOf(id, c)}${hl(id)}`} style={{ left: pct(c.start), width: pct(clipEnd(c) - c.start) }} onClick={() => props.onPick(`clip:${id}`)} title={describe(t, 'clip', id)}>
                  {describe(t, 'clip', id)}
                </div>
              ))}
            {ghosts
              .filter(([, c]) => c.trackId === tid)
              .map(([id, c]) => (
                <div key={id} className={`diff-clip removed${hl(id)}`} style={{ left: pct(c.start), width: pct(clipEnd(c) - c.start) }} onClick={() => props.onPick(`clip:${id}`)}>
                  {describe(base, 'clip', id)}
                </div>
              ))}
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: pct(props.frame), width: 1, background: '#fff', opacity: 0.6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One composited frame of a timeline, rendered with the same engine + compositor as the editor. */
export function Still({ label, timeline, frame, slot, accent, width = 640, live: continuous }: { label: string; timeline: Timeline; frame: number; slot: string; accent?: boolean; width?: number; live?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const comp = useRef<Promise<Compositor> | null>(null);
  const busy = useRef(false);
  const engine = useMemo(() => new TimelineEngine(), []);
  const meta = useEditor((s) => s.meta);

  useEffect(() => {
    const c = ref.current!;
    c.width = width;
    c.height = Math.round((width * meta.height) / meta.width);
    comp.current = createCompositor(c);
    return () => void comp.current?.then((x) => x.destroy());
  }, [meta.width, meta.height, width]);

  useEffect(() => {
    let live = true;
    engine.load(timeline);
    // A looping preview drops frames while one is still rendering rather than queueing them.
    if (continuous && busy.current) return;
    busy.current = true;
    void (async () => {
      const c = await comp.current!;
      const g = await gather(engine.renderPlan(frame, 0), c.canvas.height, slot);
      if (live || continuous) await c.draw(g.items);
      g.release();
      busy.current = false;
    })();
    return () => {
      live = false;
    };
  }, [engine, timeline, frame, slot]);

  return (
    <figure>
      {label && (
        <figcaption>
          <span className="dot" style={{ background: accent ? 'var(--k-green)' : '#666' }} />
          {label}
        </figcaption>
      )}
      <canvas ref={ref} />
    </figure>
  );
}

/** Clip name in plain words: the title text, or the media file name. */
function clipName(data: Loaded, key: string): string {
  const t = data.branch.clips[key] ? data.branch : data.main.clips[key] ? data.main : data.base;
  const c = t.clips[key];
  if (!c) return key;
  return clipKind(t, c) === 'text' ? String(c.text) : (t.media[c.mediaHash ?? '']?.name ?? key);
}

/** A ripple or multi-select move, shown as one change that expands to its clips. */
function GroupRow(props: { group: ChangeGroup; data: Loaded; picked: boolean; onToggle: (on: boolean) => void; onFocus: (id: string) => void }) {
  const { group: g, data } = props;
  const [open, setOpen] = useState(false);
  const tracks = g.tracks.map((id) => data.branch.tracks[id]?.name ?? id);
  return (
    <div className="change group" data-testid="change-group">
      <div className="top">
        <input type="checkbox" checked={props.picked} onChange={(e) => props.onToggle(e.target.checked)} aria-label="Include group" />
        <span className="badge info">Moved</span>
        <span className="grow" style={{ fontWeight: 500 }}>{describeShift(g.members.length, g.delta, data.main.fps, tracks)}</span>
        <button className="icon-btn sm" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
      {open && (
        <ul className="group-items">
          {g.members.map((id) => {
            const key = id.split(':')[1];
            const c = data.branch.clips[key];
            return (
              <li key={id} onClick={() => props.onFocus(id)}>
                {clipName(data, key)} <span className="faint">→ {c ? shortTime(c.start, data.main.fps) : ''}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Small still of one side at the middle of the conflicting clip. */
function ConflictThumb({ label, timeline, clipKey, slot }: { label: string; timeline: Timeline; clipKey: string; slot: string }) {
  const c = timeline.clips[clipKey];
  const frame = c ? c.start + Math.floor((c.out - c.in) / 2) : 0;
  return (
    <div className="conflict-thumb">
      <Still label="" timeline={timeline} frame={frame} slot={slot} width={240} />
      <span>{label}</span>
    </div>
  );
}

/** Loops just the range a conflict affects, on main, the branch or the merge result. */
function LoopPlayer({ main, branch, result, clipKey }: { main: Timeline; branch: Timeline; result: Timeline; clipKey: string }) {
  const [side, setSide] = useState<'main' | 'branch' | 'result'>('branch');
  const ranges = [main, branch].map((t) => t.clips[clipKey]).filter(Boolean) as Clip[];
  const from = Math.max(0, Math.min(...ranges.map((c) => c.start)) - 15);
  const to = Math.min(from + 10 * main.fps, Math.max(...ranges.map((c) => clipEnd(c))) + 15);
  const timeline = side === 'main' ? main : side === 'branch' ? branch : result;
  const [frame, setFrame] = useState(from);
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      setFrame(from + (Math.floor(((performance.now() - t0) / 1000) * main.fps) % Math.max(1, to - from)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [from, to, main.fps]);
  return (
    <div className="loop-player" data-testid="loop-player">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b style={{ fontSize: 13 }}>
          <Repeat size={13} style={{ verticalAlign: -2 }} /> Affected range {shortTime(from, main.fps)}–{shortTime(to, main.fps)}
        </b>
        <div className="seg">
          {(['main', 'branch', 'result'] as const).map((s) => (
            <button key={s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>
              {s === 'main' ? 'Main' : s === 'branch' ? 'Branch' : 'Result'}
            </button>
          ))}
        </div>
      </div>
      <Still label="" timeline={timeline} frame={frame} slot="loop:" width={480} live />
    </div>
  );
}
