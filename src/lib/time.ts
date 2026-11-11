/** Timeline times are integer frames; these helpers format them for display. */

export function formatClock(frame: number, fps: number): string {
  const s = Math.max(0, Math.floor(frame / fps));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatTimecode(frame: number, fps: number): string {
  const total = Math.max(0, frame) / fps;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000) % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
}

/** Short ruler labels: 25s, 1m, 1m 5s. */
export function formatRuler(frame: number, fps: number): string {
  const s = Math.round(frame / fps);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

const pad = (n: number) => String(n).padStart(2, '0');
