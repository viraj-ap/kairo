import type { MediaInfo, MediaKind } from '../model/schema';
import { demux, samples as trackSamples } from './mp4';

/** Clockwise rotation encoded in a track's 3×3 display matrix (16.16 fixed point). */
export function matrixRotation(m: ArrayLike<number> | undefined): 0 | 90 | 180 | 270 {
  if (!m || m.length < 4) return 0;
  const a = m[0] / 65536;
  const b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90;
  return (((deg % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

export function kindOf(file: { name: string; type: string }): MediaKind | null {
  const t = file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  if (t.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (t.startsWith('video/') || ['mp4', 'mov', 'm4v'].includes(ext)) return 'video';
  return null;
}

/** Read duration, size and tracks. Durations are converted to frames at the project fps. */
export async function probe(file: File, projectFps: number): Promise<MediaInfo> {
  const kind = kindOf(file);
  const base = { name: file.name, size: file.size, fps: projectFps, width: 0, height: 0, hasAudio: false, durationFrames: 0 };
  if (kind === 'image') {
    const bmp = await createImageBitmap(file);
    const info: MediaInfo = { ...base, kind, width: bmp.width, height: bmp.height, durationFrames: projectFps * 5 };
    bmp.close();
    return info;
  }
  if (kind === 'audio') {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    return { ...base, kind, hasAudio: true, durationFrames: Math.floor(buf.duration * projectFps) };
  }
  if (kind === 'video') {
    const { info } = await demux(file);
    const v = info.videoTracks[0];
    if (!v) throw new Error(`${file.name} has no video track`);
    const support = await VideoDecoder.isConfigSupported({ codec: v.codec, codedWidth: v.video!.width, codedHeight: v.video!.height });
    if (!support.supported) throw new Error(`${file.name}: codec ${v.codec} isn't supported by this browser`);
    const seconds = v.duration / v.timescale || info.duration / info.timescale;
    const rotation = matrixRotation(v.matrix as ArrayLike<number>);
    const quarter = rotation === 90 || rotation === 270;
    // Variable frame rate: frame durations differ by more than 10 % of the typical one.
    const durs = trackSamples(await demux(file), v.id).map((s) => s.duration).sort((x, y) => x - y);
    const typical = durs[Math.floor(durs.length / 2)] || 1;
    const vfr = durs.length > 2 && (durs[0] < typical * 0.9 || durs[durs.length - 1] > typical * 1.1);
    return {
      ...base,
      kind,
      codec: v.codec,
      width: quarter ? v.video!.height : v.video!.width,
      height: quarter ? v.video!.width : v.video!.height,
      ...(rotation ? { rotation } : {}),
      ...(vfr ? { vfr } : {}),
      fps: Math.round((v.nb_samples / seconds) * 100) / 100,
      hasAudio: info.audioTracks.length > 0,
      durationFrames: Math.floor(seconds * projectFps),
    };
  }
  throw new Error(`${file.name}: unsupported file type`);
}
