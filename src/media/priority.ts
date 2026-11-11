/**
 * Selective sync: in which order to fetch a file's chunks.
 *
 * Proxy chunks are ranked (lower = sooner):
 *   tier 0  the header (moov) — nothing plays without it
 *   tier 1  the 10 s after each playhead window, nearest first
 *   tier 2  the 10 s before each window, nearest first
 *   tier 3  everything else, in file order
 * Originals are background work: file order, after every proxy.
 */

export const WINDOW_SECONDS = 10;

/**
 * @param count     number of chunks
 * @param timeIndex per-second [firstChunk, lastChunk] pairs (proxies only)
 * @param windows   playhead positions in source seconds, most important first
 */
export function chunkScores(count: number, timeIndex: number[] | undefined, windows: number[], isProxy: boolean, headerChunks = 1): Float64Array {
  const score = new Float64Array(count);
  if (!isProxy || !timeIndex?.length) {
    for (let i = 0; i < count; i++) score[i] = 4e9 + i;
    return score;
  }
  for (let i = 0; i < count; i++) score[i] = 3e9 + i;
  const seconds = timeIndex.length / 2;
  const rank = (chunk: number, s: number) => {
    if (chunk >= 0 && chunk < count && s < score[chunk]) score[chunk] = s;
  };
  // Header: everything before the first media sample.
  for (let c = 0; c < Math.min(headerChunks, count); c++) rank(c, c);
  windows.forEach((w, wi) => {
    const at = Math.max(0, Math.min(seconds - 1, Math.floor(w)));
    for (let d = 0; d < WINDOW_SECONDS && at + d < seconds; d++) {
      for (let c = timeIndex[2 * (at + d)]; c <= timeIndex[2 * (at + d) + 1]; c++) rank(c, 1e9 + wi * 1e6 + d * 1e3 + c * 1e-3);
    }
    for (let d = 1; d <= WINDOW_SECONDS && at - d >= 0; d++) {
      for (let c = timeIndex[2 * (at - d)]; c <= timeIndex[2 * (at - d) + 1]; c++) rank(c, 2e9 + wi * 1e6 + d * 1e3 + c * 1e-3);
    }
  });
  return score;
}

/** Chunks needed to start playing at source second `w`: the header plus the next 10 s. */
export function chunksForPlayback(count: number, timeIndex: number[], w: number, headerChunks = 1): number[] {
  const seconds = timeIndex.length / 2;
  const need = new Set<number>();
  for (let c = 0; c < Math.min(headerChunks, count); c++) need.add(c);
  const at = Math.max(0, Math.min(seconds - 1, Math.floor(w)));
  for (let d = 0; d < WINDOW_SECONDS && at + d < seconds; d++) {
    for (let c = timeIndex[2 * (at + d)]; c <= timeIndex[2 * (at + d) + 1]; c++) need.add(c);
  }
  return [...need].filter((c) => c < count).sort((a, b) => a - b);
}

/** Lowest-scored chunk that's neither stored nor in flight, or -1. */
export function nextChunk(score: Float64Array, present: Set<number>, inflight: Set<number>): number {
  let best = -1;
  for (let i = 0; i < score.length; i++) {
    if (present.has(i) || inflight.has(i)) continue;
    if (best < 0 || score[i] < score[best]) best = i;
  }
  return best;
}
