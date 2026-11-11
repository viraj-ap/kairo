import { createFile, DataStream, Endianness, MP4BoxBuffer, type Movie, type Sample } from 'mp4box';

export interface Demuxed {
  info: Movie;
  file: ReturnType<typeof createFile>;
}

/**
 * Parse an MP4/MOV's moov box from a File, reading only what the parser asks for,
 * so the sample tables are available without loading mdat into memory.
 */
export async function demux(blob: Blob): Promise<Demuxed> {
  const file = createFile();
  let info: Movie | null = null;
  let error: string | null = null;
  file.onReady = (i) => (info = i);
  file.onError = (_m: string, e: string) => (error = e);
  let pos = 0;
  const CHUNK = 4 << 20;
  while (!info && !error && pos < blob.size) {
    const buf = await blob.slice(pos, pos + CHUNK).arrayBuffer();
    const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, pos), pos + buf.byteLength >= blob.size);
    pos = next > pos ? next : pos + buf.byteLength;
  }
  if (!info) {
    file.flush();
  }
  if (!info) throw new Error(error ?? 'Not a playable MP4/MOV file');
  return { info, file };
}

/** avcC/hvcC/vpcC/av1C box payload for VideoDecoder.configure({ description }). */
export function codecDescription(d: Demuxed, trackId: number): Uint8Array | undefined {
  const trak = d.file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries as unknown as Record<string, { write(s: DataStream): void }>[]) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array((stream as unknown as { buffer: ArrayBuffer }).buffer, 8);
    }
  }
  return undefined;
}

export function samples(d: Demuxed, trackId: number): Sample[] {
  return d.file.getTrackSamplesInfo(trackId);
}

/** AAC AudioSpecificConfig for AudioDecoder.configure({ description }) / remuxing. */
export function audioDescription(d: Demuxed, trackId: number): Uint8Array | undefined {
  const trak = d.file.getTrackById(trackId);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as {
    esds?: { esd: { findDescriptor(tag: number): { findDescriptor(tag: number): { data: Uint8Array } | undefined } | undefined } };
  };
  return entry.esds?.esd.findDescriptor(4)?.findDescriptor(5)?.data;
}

/**
 * For each second of media, the [first, last] chunk holding its samples, flattened.
 * Video seconds start at the keyframe before them, so the range is decodable on its own.
 */
/** Chunks spanning everything before the first media sample (the moov box, for fast-start files). */
export function headerChunks(d: Demuxed, chunkSize: number): number {
  let first = Infinity;
  for (const t of d.info.tracks) for (const s of samples(d, t.id)) first = Math.min(first, s.offset);
  return Math.max(1, Math.ceil((first === Infinity ? 1 : first) / chunkSize));
}

export function timeIndex(d: Demuxed, chunkSize: number): number[] {
  const seconds = Math.ceil(d.info.duration / d.info.timescale) || 1;
  const lo = new Array<number>(seconds).fill(Infinity);
  const hi = new Array<number>(seconds).fill(-1);
  for (const track of d.info.tracks) {
    if (track.type !== 'video' && track.type !== 'audio') continue;
    let keyOffset = 0;
    for (const s of samples(d, track.id)) {
      if (s.is_sync) keyOffset = s.offset;
      const sec = Math.min(seconds - 1, Math.max(0, Math.floor(s.cts / s.timescale)));
      lo[sec] = Math.min(lo[sec], track.type === 'video' ? keyOffset : s.offset);
      hi[sec] = Math.max(hi[sec], s.offset + s.size - 1);
    }
  }
  const out: number[] = [];
  for (let s = 0; s < seconds; s++) {
    const a = lo[s] === Infinity ? 0 : Math.floor(lo[s] / chunkSize);
    const b = hi[s] < 0 ? a : Math.floor(hi[s] / chunkSize);
    out.push(a, b);
  }
  return out;
}
