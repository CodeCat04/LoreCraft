/**
 * Checks a zip-based file, such as a Word document, before anything unpacks it. A small file
 * can be made to unpack to gigabytes and fill the window's memory, so its directory is read
 * first and a file that would grow too far is refused.
 */

import { unzipSync } from 'fflate';

export interface ZipLimits {
  /** Refused above this many bytes once unpacked, however it was packed. */
  maxUnpacked: number;
  /** Above this many unpacked bytes, a file that grew more than `maxRatio` times is refused. */
  ratioFloor: number;
  maxRatio: number;
}

/** Far beyond any real manuscript, whose text packs to a tenth of its size at most. */
export const WORD_LIMITS: ZipLimits = {
  maxUnpacked: 512 * 1024 * 1024,
  ratioFloor: 64 * 1024 * 1024,
  maxRatio: 100,
};

/** What the zip's directory says its files add up to, without unpacking any of them. */
export function unpackedSize(bytes: Uint8Array): number {
  let total = 0;
  unzipSync(bytes, {
    filter(file) {
      total += file.originalSize;
      return false;
    },
  });
  return total;
}

/**
 * Whether a zip would unpack to more than is safe to read. A file whose directory cannot be
 * read is left to the reader, which reports it as damaged.
 */
export function unpacksTooLarge(bytes: Uint8Array, limits: ZipLimits = WORD_LIMITS): boolean {
  let total: number;
  try {
    total = unpackedSize(bytes);
  } catch {
    return false;
  }
  if (total > limits.maxUnpacked) return true;
  return total > limits.ratioFloor && total > bytes.length * limits.maxRatio;
}
