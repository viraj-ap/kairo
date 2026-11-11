import { useEffect, useState } from 'react';
import { ArrowLeft, Copy, Play } from 'lucide-react';
import { navigate } from '../lib/router';
import { kairoBench, prepare, seekSuite, sequentialSuite, playbackSuite, exportSuite } from './suites';

/**
 * /bench — a quick single run in the page. The full report (3 runs, medians, soak,
 * collab latency across isolated browser contexts) comes from `npm run bench`,
 * which drives the same suites through window.kairoBench.
 */
export function Bench() {
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [running, setRunning] = useState(false);
  const say = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    (window as unknown as { kairoBench: typeof kairoBench }).kairoBench = kairoBench;
  }, []);

  const run = async () => {
    setRunning(true);
    setLog([]);
    setResult(null);
    const out: Record<string, unknown> = { date: new Date().toISOString(), userAgent: navigator.userAgent, crossOriginIsolated };
    try {
      say('Loading benchmark media…');
      const h = await prepare();
      say('Warm seeks (540p, GOP 30)…');
      out.seekWarm = await seekSuite(h.frames540, { n: 100, cold: false, far: false });
      say('Cold far seeks (1080p, GOP 60)…');
      out.seekColdG60 = await seekSuite(h.g60, { n: 20, cold: true, far: true });
      say('Cold far seeks (1080p, GOP 250)…');
      out.seekColdG250 = await seekSuite(h.g250, { n: 10, cold: true, far: true });
      say('Sequential decode (1080p)…');
      out.sequential = await sequentialSuite(h.g60);
      say('3-track 1080p playback (10 s)…');
      out.playback = await playbackSuite(h, 10);
      say('Export 1080p (5 s)…');
      out.export1080 = await exportSuite(h, { width: 1920, height: 1080, seconds: 5 });
      say('Done.');
    } catch (e) {
      out.error = String((e as Error).message ?? e);
      say(`Error: ${out.error}`);
    }
    setResult(out);
    setRunning(false);
  };

  return (
    <div className="bench">
      <button className="btn ghost sm" onClick={() => navigate('/')}>
        <ArrowLeft size={14} /> Dashboard
      </button>
      <h1 style={{ fontSize: 22, margin: '16px 0 4px' }}>Benchmarks</h1>
      <p className="muted" style={{ maxWidth: 680 }}>
        A quick single run. The frame-number test files encode each frame's index in their top-left pixels, so a seek only counts
        if the decoded frame is exactly the one requested. For the full report (3 runs, p50/p95/p99/max medians, 10-minute soak,
        collaboration latency) run <span className="mono">npm run bench</span>.
      </p>
      <button className="btn primary" onClick={() => void run()} disabled={running} style={{ margin: '10px 0 18px' }}>
        <Play size={14} /> {running ? 'Running…' : 'Run quick benchmarks'}
      </button>
      {log.length > 0 && (
        <table>
          <tbody>
            {log.map((l, i) => (
              <tr key={i}><td>{l}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {result && (
        <>
          <div className="row" style={{ margin: '18px 0 8px' }}>
            <b>Result</b>
            <button className="btn sm" onClick={() => void navigator.clipboard.writeText(JSON.stringify(result, null, 2))}>
              <Copy size={12} /> Copy JSON
            </button>
          </div>
          <pre id="bench-result">{JSON.stringify(result, null, 2)}</pre>
        </>
      )}
    </div>
  );
}
