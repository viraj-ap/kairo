import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getTextBitmap } from '../media/bitmaps';
import { relinkFile } from '../media/import';
import { updateClip } from '../model/doc';
import type { Clip } from '../model/schema';
import { toast, useEditor } from '../model/store';
import { layerRect } from '../render/compositor';
import { useSession } from './session';

export function Preview() {
  const session = useSession();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useEditor((s) => s.meta.width);
  const height = useEditor((s) => s.meta.height);
  const compositor = useEditor((s) => s.compositor);
  const playing = useEditor((s) => s.playing);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    void session.attachCanvas(canvasRef.current!);
  }, [session]);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el);
      const aw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ah = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const s = Math.min(aw / width, ah / height);
      setBox({ w: Math.max(1, Math.floor(width * s)), h: Math.max(1, Math.floor(height * s)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  // Render at display resolution (capped at the project size) to keep preview cheap.
  useEffect(() => {
    const c = canvasRef.current!;
    const dpr = devicePixelRatio || 1;
    const scale = Math.min(1, (box.w * dpr) / width);
    c.width = Math.max(2, Math.round(width * scale));
    c.height = Math.max(2, Math.round(height * scale));
    session.rerender();
  }, [box, width, height, session]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    const hash = e.dataTransfer.getData('application/x-kairo-media');
    if (hash) {
      session.addMediaClip(hash);
      return;
    }
    if (!files.length) return;
    const missing = missingHashes();
    for (const f of files) {
      // A file whose hash is already on the timeline but missing here is a relink.
      if (missing.size) {
        const h = await relinkFile(f);
        if (missing.has(h)) {
          session.media.markReady(h);
          toast(`Relinked ${f.name}`, 'ok');
          session.rerender();
          continue;
        }
      }
      const [r] = await session.importFiles([f]);
      if (r) session.addMediaClip(r.hash);
    }
  };

  // Click selects the topmost layer under the pointer; dragging moves it.
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const py = ((e.clientY - r.top) / r.height) * height;
    const st = useEditor.getState();
    const plan = session.engine.renderPlan(st.playhead, 0);
    const hit = [...plan.layers].reverse().find((l) => {
      const info = l.mediaHash ? st.timeline.media[l.mediaHash] : null;
      const src = l.kind === 'text' ? getTextBitmap(l, height) : ({ width: info?.width || width, height: info?.height || height } as ImageBitmap);
      const rect = layerRect(l, src, width, height);
      return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
    });
    if (!hit) {
      session.select([]);
      return;
    }
    session.select([hit.clipId]);
    const clip = st.timeline.clips[hit.clipId] as Clip;
    if (st.timeline.tracks[clip.trackId]?.locked) return;
    const x0 = clip.x ?? 0;
    const y0 = clip.y ?? 0;
    const sx = e.clientX;
    const sy = e.clientY;
    session.undo.stopCapturing();
    canvas.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      let x = x0 + (ev.clientX - sx) / r.width;
      let y = y0 + (ev.clientY - sy) / r.height;
      // Snap to center.
      if (Math.abs(x) < 0.01) x = 0;
      if (Math.abs(y) < 0.01) y = 0;
      updateClip(session.doc, hit.clipId, { x: round(x), y: round(y) });
    };
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  };

  return (
    <section
      className="stage"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="overlay-tag">
        {compositor && <span className="badge">{compositor === 'webgpu' ? 'WebGPU' : 'Canvas 2D'}</span>}
        {playing && <PlaybackStats />}
      </div>
      <div className="stage-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} onPointerDown={onPointerDown} aria-label="Preview" />
      </div>
      <MissingBanner />
      {dragOver && <div className="drop-hint">Drop to add at the playhead (or relink missing media)</div>}
    </section>
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function missingHashes(): Set<string> {
  const st = useEditor.getState();
  const used = new Set(Object.values(st.timeline.clips).map((c) => c.mediaHash).filter(Boolean) as string[]);
  return new Set([...used].filter((h) => st.mediaStatus[h] && st.mediaStatus[h].state !== 'ready'));
}

function PlaybackStats() {
  const session = useSession();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  const s = session.player?.stats;
  if (!s) return null;
  return (
    <span className={`badge ${s.dropped ? 'warn' : 'ok'}`}>
      {s.presented} shown · {s.dropped} dropped
    </span>
  );
}

function MissingBanner() {
  const status = useEditor((s) => s.mediaStatus);
  const proxies = useEditor((s) => s.proxyStatus);
  const clips = useEditor((s) => s.timeline.clips);
  const used = new Set(Object.values(clips).map((c) => c.mediaHash).filter(Boolean) as string[]);
  // Media that can't play at all: neither the original nor a playable proxy is here.
  const missing = [...used].filter((h) => status[h] && status[h].state !== 'ready' && !(proxies[h]?.state === 'ready' || proxies[h]?.playable));
  if (!missing.length) return null;
  const fetching = missing.filter((h) => status[h].state === 'fetching' || proxies[h]?.state === 'partial');
  return (
    <div className="missing-banner">
      <span className="dot" style={{ background: fetching.length ? 'var(--k-cyan)' : 'var(--warn)' }} />
      {fetching.length
        ? `Receiving ${fetching.length} file${fetching.length > 1 ? 's' : ''} from a collaborator…`
        : `${missing.length} media file${missing.length > 1 ? 's' : ''} unavailable — waiting for a peer, or drop the file here to relink`}
    </div>
  );
}
