/** Reads pictures for formats that embed them. */

import type { AssetMeta, ExportInput } from '../types';
import { base64ToBytes } from '../util';

export interface LoadedImage {
  bytes: Uint8Array;
  /** What Word can embed. */
  type: 'png' | 'jpg' | 'gif';
  width: number;
  height: number;
}

/** Pixel size from the file itself, for images stored without one. */
function sizeFromHeader(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length > 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/gif' && bytes.length > 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      // SOF0 to SOF15, leaving out the markers that share the range but hold no size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}

/** Word cannot hold WebP or AVIF, so the browser engine turns them into PNG where it can. */
async function convertToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    const copy = new Uint8Array(bytes);
    const bitmap = await createImageBitmap(new Blob([copy], { type: mime }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

export async function loadImage(asset: AssetMeta | undefined, input: ExportInput): Promise<LoadedImage | null> {
  const data = asset ? input.assetData.get(asset.id) : undefined;
  if (!asset || data === undefined) return null;
  let bytes = base64ToBytes(data);
  let mime = asset.mime;
  if (mime === 'image/webp' || mime === 'image/avif') {
    const png = await convertToPng(bytes, mime);
    if (!png) return null;
    bytes = png;
    mime = 'image/png';
  }
  const type = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : null;
  if (!type) return null;
  const header = sizeFromHeader(bytes, mime);
  return {
    bytes,
    type,
    width: asset.width ?? header?.width ?? 800,
    height: asset.height ?? header?.height ?? 600,
  };
}
