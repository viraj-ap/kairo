/**
 * Shared ring buffer between the audio worker (writer) and the AudioWorklet (reader).
 * Stereo, interleaved float32. Positions are absolute frame counts since playback started;
 * the reader's position comes from the AudioContext clock, so audio stays locked to it.
 */
export const RING_FRAMES = 48000 * 4; // 4 s at 48 kHz
export const CTRL = { WRITE: 0, READ: 1, SESSION: 2, START_FRAME_LO: 3, START_FRAME_HI: 4, UNDERRUNS: 5, MEASURE: 6 } as const;
export const CTRL_SLOTS = 8;

export interface Ring {
  ctrl: Int32Array;
  data: Float32Array;
}

export function createRing(): { ring: Ring; buffers: { ctrl: SharedArrayBuffer; data: SharedArrayBuffer } } {
  const ctrl = new SharedArrayBuffer(CTRL_SLOTS * 4);
  const data = new SharedArrayBuffer(RING_FRAMES * 2 * 4);
  return { ring: { ctrl: new Int32Array(ctrl), data: new Float32Array(data) }, buffers: { ctrl, data } };
}

export function attachRing(b: { ctrl: SharedArrayBuffer; data: SharedArrayBuffer }): Ring {
  return { ctrl: new Int32Array(b.ctrl), data: new Float32Array(b.data) };
}
