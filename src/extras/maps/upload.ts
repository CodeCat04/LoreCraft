/** Choosing a map image. The bytes decide what a file is, not its name. */

import { addAsset } from '../../lib/assets';
import { t } from '../../lib/i18n';

const MAX_BYTES = 64 * 1024 * 1024;

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** What the file really is, as a media type, or null for anything unrecognized. */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand.startsWith('hei') || brand.startsWith('hev')) return 'image/heic';
  }
  if (ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (ascii(bytes, 0, 4) === 'II*\0' || ascii(bytes, 0, 4) === 'MM\0*') return 'image/tiff';
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

const TYPE_NAMES: Record<string, string> = {
  'image/heic': 'HEIC',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
};

/** Why these bytes cannot be a map, or null if they can. */
export function refusalFor(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return t('That file is empty.');
  if (bytes.length > MAX_BYTES) return t('That image is larger than 64 MB.');
  const type = sniffImageType(bytes);
  if (type && SUPPORTED_TYPES.has(type)) return null;
  // SVG is refused on purpose: it can carry scripts.
  if (type === 'image/svg+xml') {
    return t(
      'SVG images are not supported, because they can carry scripts. Export it as a PNG first. Use PNG, JPEG, GIF, WebP or AVIF.',
    );
  }
  if (type) {
    return t('{type} images are not supported. Use PNG, JPEG, GIF, WebP or AVIF.', { type: TYPE_NAMES[type] ?? type });
  }
  return t('That file is not an image LoreCraft can use. Use PNG, JPEG, GIF, WebP or AVIF.');
}

/** A name for a new map, from its file name. */
export function titleFromFileName(name: string): string {
  const bare = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return bare || t('Untitled map');
}

export class ImageRefused extends Error {}

/** Must be called from a click or key press, which browsers require to open this dialog. */
function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.jpg,.jpeg,.gif,.webp,.avif';
    input.hidden = true;
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    // In the document, so nothing can collect it while the dialog is open.
    document.body.append(input);
    input.click();
  });
}

/**
 * Asks for an image and stores it in the project. Returns null if the dialog was
 * cancelled, and throws `ImageRefused`, whose message says why, for an unusable file.
 */
export async function pickAndStoreImage(): Promise<{ assetId: string; name: string } | null> {
  const file = await chooseFile();
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const refusal = refusalFor(bytes);
  if (refusal) throw new ImageRefused(refusal);
  // Stored under what the bytes say, since a file's own type comes from its extension.
  const assetId = await addAsset(new File([bytes], file.name, { type: sniffImageType(bytes) ?? '' }));
  return { assetId, name: file.name };
}
