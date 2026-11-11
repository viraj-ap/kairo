import { useEffect, useState } from 'react';
import { Loading } from '../App';
import { getProjectKey, keyFromHash, parseInvite, setProjectKey } from '../lib/keys';
import { navigate } from '../lib/router';
import { deleteClips, splitClip, updateClips } from '../model/doc';
import { EditorSession } from '../model/session';
import { clipEnd, clipKind } from '../model/schema';
import { useEditor } from '../model/store';
import { ExportDialog } from './ExportDialog';
import { LeftPanel, Rail } from './LeftPanel';
import { MergeScreen } from './MergeScreen';
import { Preview } from './Preview';
import { RightPanel } from './RightPanel';
import { SessionContext } from './session';
import { ShareDialog } from './ShareDialog';
import { Timeline } from './Timeline';
import { TopBar } from './TopBar';
import { Transport } from './Transport';

export function Editor({ code, branch }: { code: string; branch: string }) {
  const [session, setSession] = useState<EditorSession | null>(null);
  // The key arrives in an invite link's #fragment, or was saved when this browser created/joined the project.
  const [key, setKey] = useState<string | null>(() => {
    const fromLink = keyFromHash();
    if (fromLink) setProjectKey(code, fromLink);
    return fromLink ?? getProjectKey(code);
  });

  useEffect(() => {
    if (!key) return;
    const s = new EditorSession(code, branch, key);
    setSession(s);
    (window as unknown as { __kairo?: EditorSession }).__kairo = s;
    const params = new URLSearchParams(location.search);
    void s.start({ name: params.get('name') ?? undefined, template: params.get('template') });
    if (location.search) history.replaceState(null, '', location.pathname);
    return () => s.close();
  }, [code, branch, key]);

  const ready = useEditor((st) => st.ready);
  if (!key) return <MissingKey code={code} onKey={(k) => (setProjectKey(code, k), setKey(k))} />;
  if (!session || !ready) return <Loading label={`Joining ${code}${branch !== 'main' ? ` · ${branch}` : ''}`} />;
  return (
    <SessionContext.Provider value={session}>
      <EditorLayout session={session} />
    </SessionContext.Provider>
  );
}

function EditorLayout({ session }: { session: EditorSession }) {
  const leftPanel = useEditor((s) => s.leftPanel);
  const dialog = useEditor((s) => s.dialog);
  const [timelineH, setTimelineH] = useState(250);
  useShortcuts(session);

  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = timelineH;
    const move = (ev: PointerEvent) => setTimelineH(Math.min(Math.max(150, h0 - (ev.clientY - y0)), innerHeight - 260));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  return (
    <div className="editor">
      <TopBar />
      <div className="workspace" style={{ gridTemplateRows: `minmax(200px, 1fr) ${timelineH}px` }}>
        <div className={`upper ${leftPanel ? '' : 'no-left'}`}>
          <Rail />
          {leftPanel ? <LeftPanel panel={leftPanel} /> : <div />}
          <Preview />
          <RightPanel />
        </div>
        <div className="bottom">
          <div className="resize-handle" onPointerDown={startResize} />
          <Transport />
          <Timeline />
        </div>
      </div>
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'share' && <ShareDialog />}
      {dialog === 'merge' && <MergeScreen />}
    </div>
  );
}

function useShortcuts(session: EditorSession) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const st = useEditor.getState();
      const fps = st.meta.fps;
      const key = e.key.toLowerCase();
      if (st.dialog && key !== 'escape') return;

      if (key === ' ') {
        e.preventDefault();
        session.togglePlay();
      } else if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) session.undo.redo();
        else session.undo.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        session.undo.redo();
      } else if (mod && key === 'e') {
        e.preventDefault();
        useEditor.setState({ dialog: 'export' });
      } else if (mod && key === 'a') {
        e.preventDefault();
        session.select(Object.keys(st.timeline.clips));
      } else if ((mod && key === 'b') || (!mod && key === 's')) {
        e.preventDefault();
        splitAtPlayhead(session);
      } else if (key === 'delete' || key === 'backspace') {
        if (!st.selection.length) return;
        e.preventDefault();
        const locked = new Set(Object.entries(st.timeline.tracks).filter(([, t]) => t.locked).map(([id]) => id));
        deleteClips(session.doc, st.selection.filter((id) => !locked.has(st.timeline.clips[id]?.trackId)));
        session.select([]);
      } else if (key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault();
        const step = (e.shiftKey ? fps : 1) * (key === 'arrowleft' ? -1 : 1);
        if (e.altKey && st.selection.length) {
          const patch: Record<string, { start: number }> = {};
          st.selection.forEach((id) => {
            const c = st.timeline.clips[id];
            if (c) patch[id] = { start: Math.max(0, c.start + step) };
          });
          updateClips(session.doc, patch);
        } else session.seek(st.playhead + step);
      } else if (key === 'home') {
        session.seek(0);
      } else if (key === 'end') {
        session.seek(Math.max(0, st.duration - 1));
      } else if (key === '=' || key === '+') {
        useEditor.setState({ zoom: Math.min(40, st.zoom * 1.25) });
      } else if (key === '-') {
        useEditor.setState({ zoom: Math.max(0.05, st.zoom / 1.25) });
      } else if (key === 'escape') {
        if (st.dialog) useEditor.setState({ dialog: null });
        else session.select([]);
      } else if (key === 'n') {
        useEditor.setState({ snap: !st.snap });
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [session]);
}

/** Split selected clips under the playhead, or every clip under it if nothing is selected. */
export function splitAtPlayhead(session: EditorSession) {
  const st = useEditor.getState();
  const at = st.playhead;
  const under = Object.entries(st.timeline.clips)
    .filter(([id, c]) => c.start < at && clipEnd(c) > at && (!st.selection.length || st.selection.includes(id)))
    .filter(([, c]) => !st.timeline.tracks[c.trackId]?.locked)
    .map(([id]) => id);
  const created = under.map((id) => splitClip(session.doc, id, at)).filter((x): x is string => !!x);
  if (created.length) session.select(created);
}

export const isVisual = (t: ReturnType<typeof useEditor.getState>['timeline'], id: string) => {
  const c = t.clips[id];
  return !!c && clipKind(t, c) !== 'audio';
};

/** Opened a project link without its key (e.g. typed the URL): ask for the invite link. */
function MissingKey({ code, onKey }: { code: string; onKey: (key: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const submit = () => {
    const inv = parseInvite(text);
    if (!inv || inv.code !== code) return setError(`That isn't an invite link for ${code}.`);
    onKey(inv.key);
  };
  return (
    <div className="center-screen">
      <img src="/logo.png" alt="" />
      <h1>This project is end-to-end encrypted</h1>
      <p>
        {code} can only be opened with its invite link: the part after <span className="mono">#k=</span> is the key, and it never
        reaches the server. Paste the full link you were sent.
      </p>
      <div className="row" style={{ width: 'min(560px, 100%)' }}>
        <input className="input" autoFocus placeholder="https://…/p/KAI-…#k=…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} aria-label="Invite link" />
        <button className="btn primary" onClick={submit}>Open</button>
      </div>
      {error && <p style={{ color: '#ff8a8a' }}>{error}</p>}
      <button className="btn ghost" onClick={() => navigate('/')}>Back to dashboard</button>
    </div>
  );
}
