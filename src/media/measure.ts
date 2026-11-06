import type { MediaKind } from './sniff';

/** Finds the pixel size and length of media. All of it is optional, so failures just give nothing. */

export interface Measure {
  width?: number;
  height?: number;
  duration?: number;
}

const TIMEOUT_MS = 8000;

function measureImage(src: string): Promise<Measure> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => resolve({}), TIMEOUT_MS);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      resolve({});
    };
    image.src = src;
  });
}

function measureVideo(src: string): Promise<Measure> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const finish = (value: Measure) => {
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish({}), TIMEOUT_MS);
    video.onloadedmetadata = () => {
      finish({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
      });
    };
    video.onerror = () => finish({});
    video.src = src;
  });
}

/** Measures media from any URL the web view can load. */
export function measureUrl(src: string, kind: MediaKind): Promise<Measure> {
  // A video element reads a sound file's length too. A PDF has nothing to measure here.
  if (kind === 'pdf') return Promise.resolve({});
  return kind === 'image' ? measureImage(src) : measureVideo(src);
}

/** Measures a file the web view has in hand. */
export async function measureFile(file: Blob, kind: MediaKind): Promise<Measure> {
  const url = URL.createObjectURL(file);
  try {
    return await measureUrl(url, kind);
  } finally {
    URL.revokeObjectURL(url);
  }
}
