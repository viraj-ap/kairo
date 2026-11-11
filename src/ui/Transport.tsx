import { Camera, Magnet, Maximize, Minus, Pause, Play, Plus, Redo2, Scissors, SkipBack, SkipForward, Undo2, Scan } from 'lucide-react';
import { formatClock } from '../lib/time';
import { modKey } from '../lib/support';
import { clipEnd } from '../model/schema';
import { useEditor } from '../model/store';
import { download, snapshotPng } from '../render/snapshot';
import { splitAtPlayhead } from './Editor';
import { useSession } from './session';

const ZMIN = 0.05;
const ZMAX = 40;
const toSlider = (z: number) => Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN);
const fromSlider = (v: number) => ZMIN * Math.pow(ZMAX / ZMIN, v);

export function Transport() {
  const session = useSession();
  const playhead = useEditor((s) => s.playhead);
  const duration = useEditor((s) => s.duration);
  const playing = useEditor((s) => s.playing);
  const fps = useEditor((s) => s.meta.fps);
  const zoom = useEditor((s) => s.zoom);
  const snap = useEditor((s) => s.snap);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);

  const editPoints = () => {
    const t = useEditor.getState().timeline;
    const pts = new Set<number>([0]);
    Object.values(t.clips).forEach((c) => {
      pts.add(c.start);
      pts.add(clipEnd(c));
    });
    return [...pts].sort((a, b) => a - b);
  };
  const prev = () => session.seek([...editPoints()].reverse().find((p) => p < playhead) ?? 0);
  const next = () => session.seek(editPoints().find((p) => p > playhead) ?? playhead);

  const fit = () => {
    const el = document.querySelector('.timeline') as HTMLElement | null;
    const w = (el?.clientWidth ?? 800) - 200;
    useEditor.setState({ zoom: Math.min(ZMAX, Math.max(ZMIN, w / Math.max(fps * 5, duration))) });
  };

  const snapshot = async () => {
    const { meta } = useEditor.getState();
    const blob = await snapshotPng(session.engine, playhead, meta.width, meta.height);
    download(blob, `${meta.name} - frame ${playhead}.png`);
  };

  return (
    <div className="transport">
      <div className="row" style={{ gap: 2 }}>
        <span className="time">
          {formatClock(playhead, fps)} <span>/ {formatClock(duration, fps)}</span>
        </span>
        <button className="icon-btn" disabled={!canUndo} onClick={() => session.undo.undo()} title={`Undo (${modKey}Z)`} aria-label="Undo">
          <Undo2 size={15} />
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={() => session.undo.redo()} title={`Redo (${modKey}⇧Z)`} aria-label="Redo">
          <Redo2 size={15} />
        </button>
        <button className="icon-btn" onClick={() => splitAtPlayhead(session)} title="Split at playhead (S)" aria-label="Split">
          <Scissors size={15} />
        </button>
        <button
          className={`icon-btn ${snap ? 'on active-accent' : ''}`}
          onClick={() => useEditor.setState({ snap: !snap })}
          title={`Snapping ${snap ? 'on' : 'off'} (N)`}
          aria-label="Toggle snapping"
          aria-pressed={snap}
        >
          <Magnet size={15} />
        </button>
      </div>
      <div className="center">
        <button className="icon-btn" onClick={prev} title="Previous edit" aria-label="Previous edit">
          <SkipBack size={15} />
        </button>
        <button className="play" onClick={() => session.togglePlay()} title="Play/Pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <button className="icon-btn" onClick={next} title="Next edit" aria-label="Next edit">
          <SkipForward size={15} />
        </button>
      </div>
      <div className="right">
        <button className="icon-btn" onClick={() => useEditor.setState({ zoom: Math.max(ZMIN, zoom / 1.25) })} aria-label="Zoom out">
          <Minus size={14} />
        </button>
        <input
          className="zoom-slider"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={toSlider(zoom)}
          onChange={(e) => useEditor.setState({ zoom: fromSlider(+e.target.value) })}
          aria-label="Timeline zoom"
        />
        <button className="icon-btn" onClick={() => useEditor.setState({ zoom: Math.min(ZMAX, zoom * 1.25) })} aria-label="Zoom in">
          <Plus size={14} />
        </button>
        <button className="icon-btn" onClick={fit} title="Zoom to fit" aria-label="Zoom to fit">
          <Scan size={15} />
        </button>
        <button className="icon-btn" onClick={snapshot} title="Save frame as PNG" aria-label="Save frame">
          <Camera size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => document.querySelector('.stage canvas')?.requestFullscreen()}
          title="Fullscreen preview"
          aria-label="Fullscreen preview"
        >
          <Maximize size={15} />
        </button>
      </div>
    </div>
  );
}
