/**
 * Which files can be embedded, judged by their leading bytes as well as what the browser
 * reports. The native side checks again with `sniff` in `rpc/media.rs`, and the two must
 * agree. Checking here too means a refused file fails at once, before any upload.
 *
 * Pages and scenes take pictures and videos (`FIGURE_KINDS`). Canvas cards and the media
 * library take sound files and PDFs as well (`CARD_KINDS`).
 */

import { t } from '../lib/i18n';

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

export const FIGURE_KINDS: readonly MediaKind[] = ['image', 'video'];
export const CARD_KINDS: readonly MediaKind[] = ['image', 'video', 'audio', 'pdf'];

export interface SniffedType {
  mime: string;
  kind: MediaKind;
}

/** How much of a file the check needs. */
export const SNIFF_BYTES = 4096;

export const SUPPORTED_TEXT =
  'LoreCraft can embed PNG, JPEG, GIF, WebP and AVIF pictures, and MP4, WebM, MOV and Ogg videos.';

const image = (mime: string): SniffedType => ({ mime, kind: 'image' });
const video = (mime: string): SniffedType => ({ mime, kind: 'video' });
const audio = (mime: string): SniffedType => ({ mime, kind: 'audio' });

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((value, i) => bytes[offset + i] === value);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

function isoMedia(bytes: Uint8Array): SniffedType | null {
  const declared = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  const end = Math.min(Math.max(declared, 16), bytes.length);
  const major = ascii(bytes, 8, 12);
  const brands: string[] = [];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, i + 4));
  const has = (brand: string) => major === brand || brands.includes(brand);
  if (has('avif') || has('avis')) return image('image/avif');
  if (major === 'qt  ') return video('video/quicktime');
  if (major === 'M4A ' || major === 'M4B ') return audio('audio/mp4');
  const refused = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'M4P ', 'crx '];
  if (major.startsWith('3g') || refused.includes(major)) return null;
  return video('video/mp4');
}

/** What a file really is. Null if it is not something we accept. */
export function sniffMedia(input: Uint8Array): SniffedType | null {
  const bytes = input.subarray(0, SNIFF_BYTES);
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return image('image/png');
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return image('image/jpeg');
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return image('image/gif');
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return image('image/webp');
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML, which is also Matroska. The document type says which.
    return ascii(bytes, 0, bytes.length).includes('webm') ? video('video/webm') : null;
  }
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'pdf' };
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS') {
    // Ogg holds sound or pictures. A Theora stream makes it a video.
    const all = ascii(bytes, 0, bytes.length);
    const sound = ['OpusHead', '\x01vorbis', '\x7fFLAC'].some((marker) => all.includes(marker));
    return sound && !all.includes('\x80theora') ? audio('audio/ogg') : video('video/ogg');
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'fLaC') return audio('audio/flac');
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return audio('audio/wav');
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') return audio('audio/mpeg');
  if (bytes.length >= 2 && bytes[0] === 0xff) {
    // MPEG audio frame sync. Layer III is MP3; layer bits 00 with this sync is AAC (ADTS).
    const b = bytes[1];
    if ((b & 0xf6) === 0xf0) return audio('audio/aac');
    if ((b & 0xe0) === 0xe0 && (b & 0x18) !== 0x08 && (b & 0x06) === 0x02) return audio('audio/mpeg');
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') return isoMedia(bytes);
  // QuickTime files older than the `ftyp` box start straight with one of these.
  if (bytes.length >= 8 && ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(ascii(bytes, 4, 8))) {
    return video('video/quicktime');
  }
  return null;
}

const REPORTED: Record<string, MediaKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  'video/x-m4v': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'video/ogg': 'video',
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/m4a': 'audio',
  'audio/aac': 'audio',
  'audio/x-aac': 'audio',
  'audio/aacp': 'audio',
  'audio/opus': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/wave': 'audio',
  'audio/vnd.wave': 'audio',
  'audio/flac': 'audio',
  'audio/x-flac': 'audio',
  'application/pdf': 'pdf',
};

/** Browsers call any `.ogg` sound, whatever it holds, so for these the bytes decide. */
const SAYS_NOTHING = new Set(['', 'application/octet-stream', 'audio/ogg', 'application/ogg']);

function reportedName(reported: string): string {
  return reported.split(';')[0].trim().toLowerCase();
}

/** The kind the browser's type implies. Null when it says nothing useful. */
export function reportedKind(reported: string): MediaKind | 'refused' | null {
  const name = reportedName(reported);
  if (SAYS_NOTHING.has(name)) return null;
  return REPORTED[name] ?? 'refused';
}

/** True if a file might be acceptable, judged only by what the browser reports. */
export function mightBeMedia(file: { type: string }, kinds: readonly MediaKind[] = FIGURE_KINDS): boolean {
  const said = reportedKind(file.type);
  return said === null || (said !== 'refused' && kinds.includes(said));
}

function supported(kinds: readonly MediaKind[]): string {
  return kinds.includes('audio') || kinds.includes('pdf')
    ? t('LoreCraft can show PNG, JPEG, GIF, WebP and AVIF pictures, MP4, WebM, MOV and Ogg videos, MP3, M4A, AAC, Ogg, Opus, WAV and FLAC sounds, and PDF files.')
    : t('LoreCraft can embed PNG, JPEG, GIF, WebP and AVIF pictures, and MP4, WebM, MOV and Ogg videos.');
}

function kindName(kind: MediaKind): string {
  switch (kind) {
    case 'image':
      return t('a picture');
    case 'video':
      return t('a video');
    case 'audio':
      return t('a sound file');
    case 'pdf':
      return t('a PDF');
  }
}

/** Why a file is refused, in words for the writer, or null if it is fine. */
export function refusalFor(
  name: string,
  reported: string,
  bytes: Uint8Array,
  kinds: readonly MediaKind[] = FIGURE_KINDS,
): string | null {
  const said = reportedKind(reported);
  if (said === 'refused' || (said && !kinds.includes(said))) {
    return `${t('{name} cannot be embedded.', { name })} ${supported(kinds)}`;
  }
  const found = sniffMedia(bytes);
  if (!found || !kinds.includes(found.kind)) {
    return `${t('The contents of {name} are not a supported type.', { name })} ${supported(kinds)}`;
  }
  if (said && said !== found.kind) {
    if (said === 'image' && found.kind === 'video') return t('{name} says it is a picture but its contents are a video.', { name });
    if (said === 'video' && found.kind === 'image') return t('{name} says it is a video but its contents are a picture.', { name });
    return t('{name} says it is {said} but its contents are {found}.', { name, said: kindName(said), found: kindName(found.kind) });
  }
  return null;
}
