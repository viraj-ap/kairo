export const support = {
  webcodecs: typeof window !== 'undefined' && 'VideoDecoder' in window && 'VideoEncoder' in window,
  webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
  opfs: typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory,
};

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
