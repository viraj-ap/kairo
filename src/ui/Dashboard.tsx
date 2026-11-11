import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, ArrowUpRight, Clapperboard, Clock3, Copy, FolderOpen, Gauge, GitBranch, LayoutGrid, MoreVertical,
  Plus, Search, Settings, Sparkles, Trash2, Users,
} from 'lucide-react';
import { loadIdentity, PEER_COLORS, saveIdentity, type Identity } from '../lib/identity';
import { isRoomCode, newRoomCode } from '../lib/ids';
import { createProjectKey, getProjectKey, inviteLink, parseInvite, setProjectKey } from '../lib/keys';
import { listProjects, removeProject, upsertProject, type ProjectEntry } from '../lib/projects';
import { editorPath, navigate } from '../lib/router';
import { formatClock, timeAgo } from '../lib/time';
import { isMac } from '../lib/support';
import { toast } from '../model/store';

function createProject(template?: 'demo') {
  const code = newRoomCode();
  createProjectKey(code);
  const name = template === 'demo' ? 'Demo reel' : 'Untitled project';
  upsertProject({ code, name });
  navigate(`${editorPath(code)}?name=${encodeURIComponent(name)}${template ? `&template=${template}` : ''}`);
}

export function Dashboard({ view }: { view: 'dashboard' | 'projects' }) {
  const [projects, setProjects] = useState<ProjectEntry[]>(listProjects);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'templates' | 'projects'>('projects');
  const [settings, setSettings] = useState(false);
  const [identity, setIdentity] = useState<Identity>(loadIdentity);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const filtered = useMemo(
    () => projects.filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.code.includes(query.toUpperCase())),
    [projects, query],
  );

  const refresh = () => setProjects(listProjects());

  return (
    <div className="dash">
      <aside className="dash-side">
        <div className="brand">
          <img src="/logo.png" alt="" />
          Kairo
        </div>
        <label className="search">
          <Search size={15} />
          <input
            ref={searchRef}
            placeholder="Search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (view !== 'projects') navigate('/projects');
            }}
          />
          <span className="kbd">{isMac ? '⌘F' : 'Ctrl F'}</span>
        </label>
        <button className={`nav-item ${view === 'dashboard' ? 'on' : ''}`} onClick={() => navigate('/')}>
          <LayoutGrid size={16} /> Dashboard
        </button>
        <button className={`nav-item ${view === 'projects' ? 'on' : ''}`} onClick={() => navigate('/projects')}>
          <FolderOpen size={16} /> Projects
        </button>
        <div className="nav-sep" />
        <button className="nav-item" onClick={() => navigate('/bench')}>
          <Gauge size={16} /> Benchmarks
        </button>
        <div className="grow" />
        <div className="whats-new">
          <header>
            What's new <ArrowUpRight size={14} className="muted" />
          </header>
          <div className="art">
            <img src="/logo.png" alt="" />
          </div>
          <p>Branches &amp; visual merge, P2P media sharing</p>
        </div>
        <button className="nav-item" onClick={() => setSettings(true)}>
          <Settings size={16} /> Settings
        </button>
        <button className="nav-item" onClick={() => setSettings(true)}>
          <span className="avatar" style={{ background: identity.color, width: 20, height: 20, fontSize: 10 }}>
            {identity.name[0]?.toUpperCase()}
          </span>
          {identity.name}
        </button>
      </aside>

      <main className="dash-main">
        <div className="dash-panel">
          {view === 'dashboard' ? (
            <Home projects={projects} onChange={refresh} />
          ) : (
            <>
              <div className="seg" style={{ marginBottom: 22 }}>
                <button className={tab === 'templates' ? 'on' : ''} onClick={() => setTab('templates')}>
                  Templates
                </button>
                <button className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>
                  Your projects
                </button>
              </div>
              {tab === 'projects' ? <ProjectGrid projects={filtered} onChange={refresh} /> : <Templates />}
            </>
          )}
        </div>
      </main>

      {settings && (
        <SettingsDialog
          identity={identity}
          onClose={() => setSettings(false)}
          onSave={(id) => {
            saveIdentity(id);
            setIdentity(id);
            setSettings(false);
          }}
        />
      )}
    </div>
  );
}

function Home({ projects, onChange }: { projects: ProjectEntry[]; onChange: () => void }) {
  const [code, setCode] = useState('');
  const join = () => {
    const inv = parseInvite(code);
    if (inv) {
      setProjectKey(inv.code, inv.key);
      upsertProject({ code: inv.code, name: 'Shared project' });
      return navigate(editorPath(inv.code, inv.branch));
    }
    const c = code.trim().toUpperCase();
    if (isRoomCode(c) && getProjectKey(c)) return navigate(editorPath(c));
    toast('Paste the full invite link — it carries the encryption key', 'error');
  };
  return (
    <>
      <div className="hero">
        {/* <img className="mark" src="/logo.png" alt="" /> */}
        <h1>Edit together, right in the browser</h1>
        <p>
          Kairo decodes and renders video on your own GPU, syncs only your edits, and lets you branch a cut, try
          something, and merge it back.
        </p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary lg" onClick={() => createProject()}>
            <Plus size={16} /> New project
          </button>
          <button className="btn lg" onClick={() => createProject('demo')}>
            <Sparkles size={16} /> Open demo reel
          </button>
          <div className="join">
            <input
              className="input mono"
              style={{ height: 38 }}
              placeholder="Paste invite link"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              aria-label="Invite link"
            />
            <button className="btn lg" onClick={join}>
              Join <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </div>

      <h2>Recent</h2>
      <ProjectGrid projects={projects.slice(0, 8)} onChange={onChange} />

      <h2>How it works</h2>
      <div className="grid">
        <Feature icon={<Clapperboard size={18} />} title="Native-speed preview" text="WebCodecs decodes on your hardware; WebGPU composites every layer." />
        <Feature icon={<Users size={18} />} title="Real-time co-editing" text="Encrypted Yjs edits converge on every client. Share the invite link." />
        <Feature icon={<GitBranch size={18} />} title="Branch & merge" text="Cut a branch, edit in isolation, review a visual diff, merge selectively." />
      </div>
      <p className="hint" style={{ marginTop: 22 }}>
        Sync runs through Kairo's own server and is end-to-end encrypted: the server relays and stores only ciphertext.
      </p>
    </>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, gap: 6 }}>
      <div className="row" style={{ color: 'var(--k-green)' }}>{icon}</div>
      <div className="title">{title}</div>
      <div className="sub" style={{ lineHeight: 1.45 }}>{text}</div>
    </div>
  );
}

function ProjectGrid({ projects, onChange }: { projects: ProjectEntry[]; onChange: () => void }) {
  return (
    <div className="grid">
      <button className="card" onClick={() => createProject()}>
        <div className="thumb">
          <Plus size={22} />
        </div>
        <div className="title">New project</div>
        <div className="sub">Start empty</div>
      </button>
      {projects.map((p) => (
        <ProjectCard key={p.code} p={p} onChange={onChange} />
      ))}
    </div>
  );
}

function ProjectCard({ p, onChange }: { p: ProjectEntry; onChange: () => void }) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    addEventListener('click', close);
    return () => removeEventListener('click', close);
  }, [menu]);
  return (
    <div className="card">
      <button className="thumb project" onClick={() => navigate(editorPath(p.code))} aria-label={`Open ${p.name}`}>
        <Clapperboard size={22} />
      </button>
      <button
        className={`icon-btn sm menu ${menu ? 'open' : ''}`}
        aria-label="Project menu"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(!menu);
        }}
      >
        <MoreVertical size={14} />
      </button>
      {menu && (
        <div className="menu-pop" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink(p.code));
              toast('Invite link copied', 'ok');
              setMenu(false);
            }}
          >
            <Copy size={14} /> Copy invite link
          </button>
          <button
            className="danger"
            onClick={() => {
              removeProject(p.code);
              onChange();
            }}
          >
            <Trash2 size={14} /> Remove from list
          </button>
        </div>
      )}
      <button className="title" style={{ textAlign: 'left' }} onClick={() => navigate(editorPath(p.code))}>
        {p.name}
      </button>
      <div className="sub">
        {timeAgo(p.updatedAt)} · <Clock3 size={11} /> {formatClock(p.durationFrames, p.fps || 30)}
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5 }}>{p.code}</span>
      </div>
    </div>
  );
}

function Templates() {
  return (
    <div className="grid">
      <button className="card" onClick={() => createProject()}>
        <div className="thumb">
          <Plus size={22} />
        </div>
        <div className="title">Blank</div>
        <div className="sub">Titles, video and audio tracks</div>
      </button>
      <button className="card" onClick={() => createProject('demo')}>
        <div className="thumb dark-grad">
          <Sparkles size={22} />
        </div>
        <div className="title">Demo reel</div>
        <div className="sub">Three clips, music, a title</div>
      </button>
      <button className="card" onClick={() => navigate('/bench')}>
        <div className="thumb gradient">
          <Gauge size={22} />
        </div>
        <div className="title">Frame-accuracy bench</div>
        <div className="sub">Seek, playback and export metrics</div>
      </button>
    </div>
  );
}

function SettingsDialog({ identity, onClose, onSave }: { identity: Identity; onClose: () => void; onSave: (i: Identity) => void }) {
  const [name, setName] = useState(identity.name);
  const [color, setColor] = useState(identity.color);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <p className="hint" style={{ marginTop: 0 }}>How collaborators see you. There are no accounts; this stays in this browser.</p>
        <div className="col" style={{ marginTop: 14, gap: 12 }}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          </div>
          <div className="field">
            <label>Color</label>
            <div className="row" style={{ gap: 6 }}>
              {PEER_COLORS.map((c) => (
                <button
                  key={c}
                  aria-label={c}
                  onClick={() => setColor(c)}
                  style={{ width: 22, height: 22, borderRadius: '50%', background: c, boxShadow: c === color ? '0 0 0 2px var(--bg), 0 0 0 4px #fff' : 'none' }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave({ name: name.trim() || identity.name, color })}>Save</button>
        </div>
      </div>
    </div>
  );
}
