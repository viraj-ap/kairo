import { useState } from 'react';
import { GitBranch, LayoutGrid, Share2, ChevronDown, Cloud, CloudOff, Loader } from 'lucide-react';
import { navigate } from '../lib/router';
import { modKey } from '../lib/support';
import { setMeta } from '../model/doc';
import { ASPECTS, aspectOf, type Aspect } from '../model/schema';
import { useEditor } from '../model/store';
import { useSession } from './session';

export function TopBar() {
  const session = useSession();
  const meta = useEditor((s) => s.meta);
  const status = useEditor((s) => s.status);
  const peers = useEditor((s) => s.peers);
  const [editing, setEditing] = useState(false);
  const [aspectOpen, setAspectOpen] = useState(false);
  const aspect = aspectOf(meta.width, meta.height);

  return (
    <header className="topbar">
      <button className="logo-btn" onClick={() => navigate('/')} aria-label="Kairo home">
        <img src="/logo.png" alt="" />
      </button>
      <button className="tab" onClick={() => navigate('/')}>
        <LayoutGrid size={15} /> Dashboard
      </button>
      <div className="tab on" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
        <span className="swatch" />
        {editing ? (
          <input
            autoFocus
            defaultValue={meta.name}
            onBlur={(e) => {
              setMeta(session.doc, { name: e.target.value.trim() || meta.name });
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span className="name">{meta.name}</span>
        )}
      </div>
      <button
        className={`branch-chip ${session.branch === 'main' ? 'main' : ''}`}
        onClick={() => useEditor.setState({ rightTab: 'branches' })}
        title="Branches"
      >
        <GitBranch size={12} /> {session.branch}
      </button>
      <span className="status-dot" title="End-to-end encrypted sync">
        {status === 'connected' ? <Cloud size={14} /> : status === 'connecting' ? <Loader size={14} /> : <CloudOff size={14} />}
        {status === 'offline' && navigator.onLine
          ? "Can't reach sync server — edits saved locally"
          : { connected: 'Live · encrypted', connecting: 'Connecting', offline: 'Offline — edits saved locally', rejected: 'Wrong room key' }[status]}
      </span>

      <div className="grow" />

      <div className="avatars" style={{ marginRight: 6 }}>
        {peers.slice(0, 5).map((p) => (
          <span key={p.clientId} className="avatar" style={{ background: p.color }} title={p.me ? `${p.name} (you)` : p.name}>
            {p.name[0]?.toUpperCase()}
          </span>
        ))}
        {peers.length > 5 && <span className="avatar" style={{ background: '#333', color: '#fff' }}>+{peers.length - 5}</span>}
      </div>

      <div style={{ position: 'relative' }}>
        <button className="btn ghost sm" onClick={() => setAspectOpen(!aspectOpen)}>
          <span style={{ width: 14, height: 9, border: '1.5px solid currentColor', borderRadius: 2, display: 'inline-block' }} />
          {aspect} <ChevronDown size={13} />
        </button>
        {aspectOpen && (
          <div className="menu-pop" style={{ top: 32, right: 0 }} onMouseLeave={() => setAspectOpen(false)}>
            {(Object.keys(ASPECTS) as Aspect[]).map((a) => (
              <button
                key={a}
                onClick={() => {
                  setMeta(session.doc, ASPECTS[a]);
                  setAspectOpen(false);
                }}
              >
                {a} <span className="faint" style={{ marginLeft: 'auto' }}>{ASPECTS[a].width}×{ASPECTS[a].height}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="icon-btn" onClick={() => useEditor.setState({ dialog: 'share' })} aria-label="Share" title="Share room">
        <Share2 size={16} />
      </button>
      <button className="btn primary" onClick={() => useEditor.setState({ dialog: 'export' })}>
        Export <span className="kbd">{modKey}E</span>
      </button>
    </header>
  );
}
