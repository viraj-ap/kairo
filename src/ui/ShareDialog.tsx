import { Link2 } from 'lucide-react';
import { useEditor, toast } from '../model/store';
import { inviteLink } from '../lib/keys';
import { useSession } from './session';

export function ShareDialog() {
  const session = useSession();
  const link = inviteLink(session.code, session.branch);
  const close = () => useEditor.setState({ dialog: null });
  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'ok');
  };
  return (
    <div className="scrim" onClick={close}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Share">
        <h2>Invite collaborators</h2>
        <p className="hint" style={{ marginTop: 0 }}>Anyone with this link can join and edit in real time. The part after #k= is the encryption key; it never reaches the server, so share the link privately.</p>
        <div className="col" style={{ marginTop: 14, gap: 10 }}>
          <div className="code-box">
            <span className="code">{session.code}</span>

          </div>
          <div className="row">
            <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button className="btn" onClick={() => copy(link, 'Link')}>
              <Link2 size={14} /> Copy
            </button>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            Edits and presence go through Kairo's sync server as AES-GCM ciphertext. Media files are sent directly between browsers over WebRTC.
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
