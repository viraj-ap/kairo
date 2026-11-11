import { useEffect, useRef, useState } from 'react';
import { Blend, Clapperboard, Film, Image as ImageIcon, Music, PanelLeftClose, Plus, Sparkles, Type, Upload, Wand2 } from 'lucide-react';
import { relinkFile } from '../media/import';
import { getThumbnail } from '../media/thumbs';
import { updateClips } from '../model/doc';
import type { EffectKind, MediaInfo, TransitionKind } from '../model/schema';
import { useEditor, toast, type LeftPanel as Panel } from '../model/store';
import { formatClock } from '../lib/time';
import { useSession } from './session';

const RAIL: { id: Panel; icon: React.ReactNode; label: string }[] = [
  { id: 'media', icon: <Film size={18} />, label: 'Media' },
  { id: 'text', icon: <Type size={18} />, label: 'Text' },
  { id: 'transitions', icon: <Blend size={18} />, label: 'Transitions' },
  { id: 'effects', icon: <Wand2 size={18} />, label: 'Effects' },
];

export function Rail() {
  const panel = useEditor((s) => s.leftPanel);
  return (
    <nav className="rail" aria-label="Panels">
      {RAIL.map((r) => (
        <button
          key={r.id}
          className={`icon-btn ${panel === r.id ? 'on' : ''}`}
          title={r.label}
          aria-label={r.label}
          aria-pressed={panel === r.id}
          onClick={() => useEditor.setState({ leftPanel: panel === r.id ? null : r.id })}
        >
          {r.icon}
        </button>
      ))}
    </nav>
  );
}

export function LeftPanel({ panel }: { panel: Panel }) {
  const title = RAIL.find((r) => r.id === panel)!.label;
  return (
    <aside className="left-panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <button className="icon-btn" onClick={() => useEditor.setState({ leftPanel: null })} aria-label="Close panel">
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="panel-body">
        {panel === 'media' && <MediaPanel />}
        {panel === 'text' && <TextPanel />}
        {panel === 'transitions' && <TransitionsPanel />}
        {panel === 'effects' && <EffectsPanel />}
      </div>
    </aside>
  );
}

// ---- media ------------------------------------------------------------------

function MediaPanel() {
  const session = useSession();
  const media = useEditor((s) => s.timeline.media);
  const status = useEditor((s) => s.mediaStatus);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const importAll = async (files: File[]) => {
    setBusy(true);
    await session.importFiles(files);
    setBusy(false);
  };

  const entries = Object.entries(media);
  return (
    <>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void importAll([...e.dataTransfer.files]);
        }}
      >
        <Upload size={18} style={{ marginBottom: 6 }} />
        <div>Drop video, audio or images</div>
        <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
          <button className="btn sm primary" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Importing…' : 'Import files'}
          </button>
          <button
            className="btn sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await session.loadDemo().catch((e) => toast(String(e.message), 'error'));
              setBusy(false);
            }}
          >
            <Sparkles size={13} /> Demo
          </button>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept="video/mp4,video/quicktime,audio/*,image/*"
          hidden
          onChange={(e) => {
            void importAll([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      <p className="hint" style={{ margin: '8px 2px 0' }}>
        Files stay on this device (OPFS). Collaborators receive them peer-to-peer.
      </p>

      <div className="section-label">In this project · {entries.length}</div>
      {entries.length === 0 ? (
        <p className="hint">Nothing imported yet.</p>
      ) : (
        <div className="tiles two">
          {entries.map(([hash, info]) => (
            <MediaTile key={hash} hash={hash} info={info} state={status[hash]?.state ?? 'ready'} progress={status[hash]?.progress} />
          ))}
        </div>
      )}
    </>
  );
}

function MediaTile({ hash, info, state, progress }: { hash: string; info: MediaInfo; state: string; progress?: number }) {
  const session = useSession();
  const thumb = useThumb(hash, info, state === 'ready');
  const fps = useEditor((s) => s.meta.fps);
  const Icon = info.kind === 'audio' ? Music : info.kind === 'image' ? ImageIcon : Clapperboard;

  const onDrop = async (e: React.DragEvent) => {
    const f = e.dataTransfer.files[0];
    if (!f || state === 'ready') return;
    e.preventDefault();
    e.stopPropagation();
    const h = await relinkFile(f);
    if (h === hash) {
      session.media.markReady(hash);
      toast(`Relinked ${info.name}`, 'ok');
    } else toast(`${f.name} isn't the same file as ${info.name}`, 'error');
  };

  return (
    <div
      className="tile wide"
      draggable={state === 'ready'}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-kairo-media', hash);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDragOver={(e) => state !== 'ready' && e.preventDefault()}
      onDrop={onDrop}
      title={state === 'ready' ? `Drag to the timeline · ${info.name}` : 'Drop the original file here to relink'}
    >
      <div
        className="img"
        style={{
          background: thumb ? `url(${thumb}) center/cover` : info.kind === 'audio' ? 'linear-gradient(135deg,#0f3d28,#17603f)' : '#202020',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {!thumb && <Icon size={20} color="#9a9a9a" />}
        {state !== 'ready' && (
          <span className="corner badge warn">{state === 'fetching' ? `${Math.round((progress ?? 0) * 100)}%` : 'missing'}</span>
        )}
        {state === 'fetching' && <span className="progress" style={{ width: `${(progress ?? 0) * 100}%` }} />}
        {state === 'ready' && (
          <button className="add" onClick={() => session.addMediaClip(hash)} aria-label={`Add ${info.name} at playhead`}>
            <Plus size={14} />
          </button>
        )}
      </div>
      <div className="label">{info.name}</div>
      <div className="sub">
        {info.kind === 'image' ? `${info.width}×${info.height}` : formatClock(info.durationFrames, fps)}
        {info.kind === 'video' && ` · ${info.height}p`}
      </div>
    </div>
  );
}

function useThumb(hash: string, info: MediaInfo, ready: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void getThumbnail(hash, info).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [hash, info, ready]);
  return url;
}

// ---- text -------------------------------------------------------------------

const TEXT_PRESETS = [
  { label: 'Title', text: 'Your title', style: { fontSize: 128, fontWeight: 700 }, css: { fontSize: 22, fontWeight: 700 } },
  { label: 'Subtitle', text: 'A short subtitle', style: { fontSize: 64, fontWeight: 500, y: 0.12 }, css: { fontSize: 15, fontWeight: 500 } },
  {
    label: 'Lower third',
    text: 'Name Surname',
    style: { fontSize: 54, fontWeight: 600, x: -0.3, y: 0.36, background: '#111111cc' },
    css: { fontSize: 13, fontWeight: 600, background: '#111', display: 'inline-block', padding: '4px 8px', borderRadius: 4 },
  },
  {
    label: 'Caption',
    text: 'Caption text goes here',
    style: { fontSize: 52, fontWeight: 600, y: 0.4, color: '#ffffff', background: '#000000aa' },
    css: { fontSize: 12, fontWeight: 600, background: '#000', display: 'inline-block', padding: '3px 7px', borderRadius: 4 },
  },
  { label: 'Accent', text: 'KAIRO', style: { fontSize: 160, fontWeight: 700, color: '#18ff7a' }, css: { fontSize: 24, fontWeight: 700, color: '#18ff7a', letterSpacing: '0.04em' } },
];

function TextPanel() {
  const session = useSession();
  return (
    <>
      <div className="section-label">Click to add at the playhead</div>
      {TEXT_PRESETS.map((p) => (
        <button key={p.label} className="text-preset" onClick={() => session.addTextClip(p.text, p.style)}>
          <span style={p.css as React.CSSProperties}>{p.label}</span>
        </button>
      ))}
      <p className="hint">Edit the words, size and colors in the inspector on the right. Drag in the preview to position.</p>
    </>
  );
}

// ---- transitions -----------------------------------------------------------

const TRANSITIONS: { kind: TransitionKind | null; label: string; anim: string }[] = [
  { kind: 'fade', label: 'Fade in', anim: 'linear-gradient(90deg,#000 0%,#2c71b5 100%)' },
  { kind: 'wipe', label: 'Wipe', anim: 'linear-gradient(90deg,#2c71b5 50%,#000 50%)' },
  { kind: 'slide', label: 'Slide', anim: 'linear-gradient(90deg,#000 30%,#2c71b5 30%)' },
  { kind: 'zoom', label: 'Zoom', anim: 'radial-gradient(circle,#2c71b5 35%,#000 36%)' },
  { kind: null, label: 'None', anim: '#1c1c1c' },
];

function useSelectedVisual() {
  const selection = useEditor((s) => s.selection);
  const timeline = useEditor((s) => s.timeline);
  return selection.filter((id) => {
    const c = timeline.clips[id];
    return c && (c.text !== undefined || timeline.media[c.mediaHash ?? '']?.kind !== 'audio');
  });
}

function TransitionsPanel() {
  const session = useSession();
  const ids = useSelectedVisual();
  const clips = useEditor((s) => s.timeline.clips);
  const fps = useEditor((s) => s.meta.fps);
  const current = ids.length ? clips[ids[0]]?.transitionIn?.kind ?? null : undefined;
  const apply = (kind: TransitionKind | null) => {
    if (!ids.length) return toast('Select a clip on the timeline first');
    updateClips(session.doc, Object.fromEntries(ids.map((id) => [id, { transitionIn: kind ? { kind, duration: Math.round(fps / 2) } : undefined }])));
  };
  return (
    <>
      <div className="section-label">{ids.length ? `Applies to ${ids.length} selected clip${ids.length > 1 ? 's' : ''}` : 'Select a clip to apply'}</div>
      <div className="tiles">
        {TRANSITIONS.map((t) => (
          <button key={t.label} className={`tile ${current === t.kind ? 'on' : ''}`} onClick={() => apply(t.kind)}>
            <div className="img" style={{ background: t.anim }} />
            <div className="label">{t.label}</div>
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 12 }}>Transitions play at the start of a clip. Change the duration in the inspector.</p>
    </>
  );
}

// ---- effects ----------------------------------------------------------------

const EFFECT_GROUPS: { label: string; items: { id: EffectKind; label: string; css: string; overlay?: string }[] }[] = [
  {
    label: 'Texture & finish',
    items: [
      { id: 'vignette', label: 'Vignette', css: '', overlay: 'radial-gradient(circle, transparent 35%, rgba(0,0,0,.85) 80%)' },
      { id: 'scanlines', label: 'Scanlines', css: '', overlay: 'repeating-linear-gradient(0deg, rgba(0,0,0,.35) 0 2px, transparent 2px 4px)' },
    ],
  },
  {
    label: 'Stylize',
    items: [
      { id: 'grayscale', label: 'Mono', css: 'grayscale(1)' },
      { id: 'sepia', label: 'Sepia', css: 'sepia(1)' },
      { id: 'duotone', label: 'Duotone', css: 'grayscale(1) sepia(1) hue-rotate(110deg) saturate(3)' },
      { id: 'posterize', label: 'Posterize', css: 'contrast(1.6) saturate(1.4)' },
      { id: 'invert', label: 'Invert', css: 'invert(1)' },
      { id: 'none', label: 'None', css: '' },
    ],
  },
];

function EffectsPanel() {
  const session = useSession();
  const ids = useSelectedVisual();
  const timeline = useEditor((s) => s.timeline);
  const first = ids.length ? timeline.clips[ids[0]] : null;
  const [sample, setSample] = useState<string | null>(null);
  const sampleHash = first?.mediaHash ?? Object.keys(timeline.media).find((h) => timeline.media[h].kind === 'video');
  useEffect(() => {
    if (!sampleHash || !timeline.media[sampleHash]) return;
    void getThumbnail(sampleHash, timeline.media[sampleHash]).then(setSample);
  }, [sampleHash, timeline.media]);

  const apply = (effect: EffectKind) => {
    if (!ids.length) return toast('Select a clip on the timeline first');
    updateClips(session.doc, Object.fromEntries(ids.map((id) => [id, { effect: effect === 'none' ? undefined : effect }])));
  };
  const bg = sample ? `url(${sample}) center/cover` : 'linear-gradient(135deg,#9dffc9,#18ff7a 35%,#00c8ff 70%,#2a2aff)';
  return (
    <>
      {EFFECT_GROUPS.map((g) => (
        <div key={g.label}>
          <div className="section-label">{g.label}</div>
          <div className="tiles">
            {g.items.map((fx) => (
              <button key={fx.id} className={`tile ${(first?.effect ?? 'none') === fx.id && first ? 'on' : ''}`} onClick={() => apply(fx.id)}>
                <div className="img" style={{ background: bg, filter: fx.css || undefined }}>
                  {fx.overlay && <div style={{ position: 'absolute', inset: 0, background: fx.overlay }} />}
                </div>
                <div className="label">{fx.label}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="hint" style={{ marginTop: 12 }}>Effects run in the WebGPU compositor. Fine-tune brightness, contrast and saturation in the inspector.</p>
    </>
  );
}
