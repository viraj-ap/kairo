import { useEditor } from '../model/store';

export function Toast() {
  const t = useEditor((s) => s.toast);
  if (!t) return null;
  return (
    <div className={`toast ${t.tone ?? ''}`} role="status">
      {t.text}
    </div>
  );
}
