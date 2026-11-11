import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { exportMp4 } from '../render/export';
import { download } from '../render/snapshot';
import { useEditor } from '../model/store';
import { formatClock } from '../lib/time';
import { useSession } from './session';

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function ExportDialog() {
  const session = useSession();
  const meta = useEditor((s) => s.meta);
  const clips = useEditor((s) => s.timeline.clips);
  const media = useEditor((s) => s.timeline.media);
  const status = useEditor((s) => s.mediaStatus);
  // Export renders from originals, never proxies.
  const missing = [...new Set(Object.values(clips).map((c) => c.mediaHash).filter((h): h is string => !!h))].filter(
    (h) => status[h] && status[h].state !== 'ready',
  );
  const [fetching, setFetching] = useState(false);
  const duration = useEditor((s) => s.duration);
  const [scale, setScale] = useState(1);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ blob: Blob; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const width = even(meta.width * scale);
  const height = even(meta.height * scale);
  const close = () => {
    abort.current?.abort();
    useEditor.setState({ dialog: null });
  };

  const run = async () => {
    setError(null);
    setResult(null);
    if (missing.length) {
      setFetching(true);
      await session.media.requestOriginals(missing);
      setFetching(false);
    }
    setProgress(0);
    abort.current = new AbortController();
    const t0 = performance.now();
    try {
      const blob = await exportMp4(useEditor.getState().timeline, {
        width,
        height,
        signal: abort.current.signal,
        onProgress: (d, t) => setProgress(d / t),
      });
      const seconds = (performance.now() - t0) / 1000;
      setResult({ blob, seconds });
      download(blob, `${meta.name}.mp4`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(String((e as Error).message ?? e));
    } finally {
      setProgress(null);
    }
  };

  const videoSeconds = duration / meta.fps;
  return (
    <div className="scrim" onClick={progress === null ? close : undefined}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Export">
        <h2>Export video</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Rendered and encoded on this device (WebCodecs H.264 + AAC). Nothing is uploaded.
        </p>
        <div className="col" style={{ marginTop: 14, gap: 12 }}>
          <div className="field">
            <label>Resolution</label>
            <div className="seg">
              {[1, 2 / 3, 0.5].map((s) => (
                <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)} disabled={progress !== null}>
                  {even(meta.height * s)}p
                </button>
              ))}
            </div>
          </div>
          <div className="kv"><span>Output</span><span>{width}×{height} · {meta.fps} fps · MP4</span></div>
          <div className="kv"><span>Length</span><span>{formatClock(duration, meta.fps)} ({duration} frames)</span></div>
          {missing.length > 0 && (
            <div className="col" style={{ gap: 6 }} data-testid="missing-originals">
              <span className="hint" style={{ color: 'var(--warn)' }}>
                {missing.length} original{missing.length > 1 ? 's are' : ' is'} not on this device yet (you're editing with proxies). They'll be fetched from
                collaborators first:
              </span>
              {missing.map((h) => (
                <div key={h} className="kv">
                  <span>{media[h]?.name ?? h.slice(0, 10)}</span>
                  <span className="mono">{status[h]?.state === 'fetching' ? `${Math.round((status[h]?.progress ?? 0) * 100)}%` : 'waiting'}</span>
                </div>
              ))}
            </div>
          )}
          {progress !== null && (
            <div className="col" style={{ gap: 6 }}>
              <div className="progress-bar"><div style={{ width: `${progress * 100}%` }} /></div>
              <span className="hint">Rendering frame {Math.round(progress * duration)} of {duration}…</span>
            </div>
          )}
          {result && (
            <div className="badge ok" style={{ height: 'auto', padding: '8px 10px', fontSize: 12 }}>
              Done in {result.seconds.toFixed(1)}s ({(videoSeconds / result.seconds).toFixed(2)}× real time) · {(result.blob.size / 1e6).toFixed(1)} MB
            </div>
          )}
          {error && <div className="badge danger" style={{ height: 'auto', padding: '8px 10px', fontSize: 12 }}>{error}</div>}
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={close}>{progress !== null ? 'Cancel' : 'Close'}</button>
          {result ? (
            <button className="btn primary" onClick={() => download(result.blob, `${meta.name}.mp4`)}>
              <Download size={14} /> Download again
            </button>
          ) : (
            <button className="btn primary" disabled={progress !== null || fetching || duration === 0} onClick={() => void run()}>
              {fetching ? 'Fetching originals…' : missing.length ? 'Fetch originals & export' : 'Export'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
