/**
 * The one place exporters read a stored picture or video, so a change to asset storage
 * changes only this.
 */

import { readAssetBase64 as readStoredBase64 } from '../lib/assets';

/** Larger videos stay out of exports entirely, since all of a file must fit in memory. */
export const LARGEST_VIDEO_TO_EMBED = 64 * 1024 * 1024;

/** The file's contents as base64, or null if it is gone. */
export async function readAssetBase64(id: string): Promise<string | null> {
  try {
    return await readStoredBase64(id);
  } catch {
    return null;
  }
}
