import type { TimelineEngine } from '../engine';
import { audioContext, getAudioBuffer, scheduleMix } from '../media/audio';
import { AudioOut, streamingSupported } from '../media/audio/out';
import type { Compositor } from './compositor';
import { gather } from './frame';

export interface PlaybackStats {
  presented: number;
  dropped: number;
  lastRenderMs: number;
  /** Time to gather + composite each presented frame (last 20k). */
  renderMs: number[];
  /** Timeline frames that were skipped (last 5k), to see where drops cluster. */
  droppedAt: number[];
}

/**
 * Preview playback. The clock is the AudioContext, so audio never drifts; video frames
 * that aren't ready in time for their slot are dropped rather than delaying playback.
 */
export class Player {
  playing = false;
  frame = 0;
  duration = 0;
  stats: PlaybackStats = { presented: 0, dropped: 0, lastRenderMs: 0, renderMs: [], droppedAt: [] };

  private rendering = false;
  private queued: number | null = null;
  private startTime = 0;
  private startFrame = 0;
  private nodes: AudioScheduledSourceNode[] = [];
  private master: GainNode | null = null;
  /** Streaming output (AudioDecoder → ring buffer → AudioWorklet); null on the fallback path. */
  audioOut: AudioOut | null = null;
  private raf = 0;
  private lastPresentAt = 0;
  private lastShown = -1;
  private rescheduleTimer = 0;
  private generation = 0;

  constructor(
    private engine: TimelineEngine,
    private compositor: Compositor,
    private fps: number,
    private onFrame: (frame: number) => void,
    private onPlayState: (playing: boolean) => void,
    /** Called with each frame actually put on screen (benchmarks). */
    private onPresent?: (frame: number) => void,
  ) {}

  setFps(fps: number) {
    this.fps = fps;
  }

  /** Call after engine.load() with a new timeline. */
  timelineChanged() {
    this.duration = this.engine.duration();
    if (this.playing) {
      clearTimeout(this.rescheduleTimer);
      this.rescheduleTimer = window.setTimeout(() => void this.restartAudio(), 80);
    } else {
      this.requestRender(this.frame);
    }
  }

  seek(frame: number) {
    this.frame = Math.max(0, Math.round(frame));
    if (this.playing) void this.restartAudio();
    else this.requestRender(this.frame);
  }

  /** Render `frame` now, coalescing requests that arrive while a render is in flight. */
  requestRender(frame: number) {
    if (this.rendering) {
      this.queued = frame;
      return;
    }
    void this.renderFrame(frame, false);
  }

  /**
   * The timeline frame being *heard* right now. `currentTime` is where audio rendering is,
   * which runs ahead of the speakers by the output latency; showing video against it put
   * pictures ~30 ms ahead of their sound. getOutputTimestamp() says what is playing out now.
   */
  private heardTime(): number {
    const ac = audioContext();
    const ts = ac.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return ac.currentTime - (ac.outputLatency || ac.baseLatency || 0);
  }

  private clockFrame() {
    return this.startFrame + Math.floor((this.heardTime() - this.startTime) * this.fps);
  }

  private async renderFrame(frame: number, live: boolean) {
    this.rendering = true;
    const t0 = performance.now();
    try {
      // Look 2 s ahead so upcoming clips can be warmed up gradually.
      const plan = this.engine.renderPlan(frame, live ? this.fps * 2 : 0);
      const g = await gather(plan, this.compositor.canvas.height, 'pv:');
      const late = live && this.playing && this.clockFrame() > frame + 1;
      const starving = performance.now() - this.lastPresentAt > 250;
      if (!late || starving) {
        await this.compositor.draw(g.items);
        this.stats.presented++;
        if (live) this.onPresent?.(frame);
        this.lastPresentAt = performance.now();
        if (live) {
          this.stats.renderMs.push(this.lastPresentAt - t0);
          if (this.stats.renderMs.length > 20_000) this.stats.renderMs.shift();
        }
      } else {
        this.stats.dropped++;
      }
      g.release();
    } catch (e) {
      console.warn('[render]', e);
    } finally {
      this.stats.lastRenderMs = performance.now() - t0;
      this.rendering = false;
      if (this.queued !== null) {
        const q = this.queued;
        this.queued = null;
        void this.renderFrame(q, false);
      }
    }
  }

  async play() {
    if (this.playing) return;
    if (this.frame >= this.duration - 1) this.frame = 0;
    this.playing = true;
    this.onPlayState(true);
    this.stats = { presented: 0, dropped: 0, lastRenderMs: 0, renderMs: [], droppedAt: [] };
    await this.restartAudio();
    this.lastShown = -1;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.generation++;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    this.onPlayState(false);
    this.requestRender(this.frame);
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  private stopAudio() {
    this.audioOut?.stop();
    this.nodes.forEach((n) => {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    });
    this.nodes = [];
  }

  private async restartAudio() {
    const gen = ++this.generation;
    const ac = audioContext();
    if (ac.state === 'suspended') await ac.resume();
    this.stopAudio();
    const segments = this.engine.audioPlan();
    const streaming = streamingSupported();
    // The fallback path needs every file fully decoded before it can schedule anything.
    if (!streaming) await Promise.all(segments.map((s) => getAudioBuffer(s.mediaHash)));
    if (gen !== this.generation || !this.playing) return;
    if (!this.master) {
      this.master = ac.createGain();
      this.master.connect(ac.destination);
    }
    // While playing, continue from the clock position rather than the last drawn frame.
    if (this.startTime && this.lastShown >= 0) this.frame = Math.max(this.frame, this.lastShown);
    this.startFrame = this.frame;
    this.startTime = ac.currentTime + 0.05;
    if (streaming) {
      this.audioOut ??= new AudioOut(ac, this.master);
      await this.audioOut.start(segments, this.fps, this.startFrame, this.startTime);
    } else {
      this.nodes = await scheduleMix(ac, this.master, segments, this.fps, this.startFrame, this.startTime);
    }
  }

  private tick = () => {
    if (!this.playing) return;
    const f = Math.max(this.startFrame, this.clockFrame());
    if (f >= this.duration) {
      this.frame = Math.max(0, this.duration - 1);
      this.onFrame(this.frame);
      this.pause();
      return;
    }
    if (f !== this.lastShown) {
      if (this.rendering) {
        this.stats.dropped += this.lastShown >= 0 ? Math.max(0, f - this.lastShown - 1) : 0;
        if (this.stats.droppedAt.length < 5000) this.stats.droppedAt.push(f);
      } else {
        void this.renderFrame(f, true);
      }
      this.lastShown = f;
      this.frame = f;
      this.onFrame(f);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  setVolume(v: number) {
    if (!this.master) {
      this.master = audioContext().createGain();
      this.master.connect(audioContext().destination);
    }
    this.master.gain.value = v;
  }

  destroy() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
  }
}
