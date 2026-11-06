import { CARD_KINDS, mightBeMedia, refusalFor, reportedKind, sniffMedia } from './sniff';

/** The same cases as `sniffing_recognizes_each_allowed_type_and_nothing_else` in rpc/media.rs. */
const bytes = (...parts: (string | number[])[]) => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(...[...part].map((c) => c.charCodeAt(0)));
    else out.push(...part);
  }
  return new Uint8Array(out);
};

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], 'IHDR');
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm', [0, 0, 0]);
const ftyp = (major: string, compatible: string) =>
  bytes([0, 0, 0, 24], 'ftyp', major, [0, 0, 0, 0], compatible, 'isom', [0, 0, 0, 0, 0, 0, 0, 0]);

const mime = (input: Uint8Array) => sniffMedia(input)?.mime ?? null;

describe('sniffMedia', () => {
  it('recognizes every allowed type from its leading bytes', () => {
    expect(mime(PNG)).toBe('image/png');
    expect(mime(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(mime(bytes('GIF89a.....'))).toBe('image/gif');
    expect(mime(bytes('GIF87a.....'))).toBe('image/gif');
    expect(mime(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(mime(ftyp('avif', 'mif1'))).toBe('image/avif');
    expect(mime(ftyp('mif1', 'avif'))).toBe('image/avif');
    expect(mime(ftyp('isom', 'mp42'))).toBe('video/mp4');
    expect(mime(ftyp('mp42', 'isom'))).toBe('video/mp4');
    expect(mime(ftyp('qt  ', 'qt  '))).toBe('video/quicktime');
    expect(mime(bytes([0, 0, 0, 8], 'wide', [0, 0, 0, 0], 'mdat'))).toBe('video/quicktime');
    expect(mime(WEBM)).toBe('video/webm');
    expect(mime(bytes('OggS', [0, 2, 0, 0, 0, 0]))).toBe('video/ogg');
  });

  it('says which kind it found', () => {
    expect(sniffMedia(PNG)?.kind).toBe('image');
    expect(sniffMedia(WEBM)?.kind).toBe('video');
  });

  it('refuses everything else, including things that can carry scripts', () => {
    expect(mime(ftyp('heic', 'mif1'))).toBeNull();
    expect(mime(ftyp('mif1', 'heic'))).toBeNull();
    expect(mime(ftyp('M4P ', 'isom'))).toBeNull();
    expect(mime(ftyp('3gp4', 'isom'))).toBeNull();
    expect(mime(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], 'matroska'))).toBeNull();
    expect(mime(bytes('<!DOCTYPE html><html>'))).toBeNull();
    expect(mime(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(mime(bytes('MThd', [0, 0, 0, 6]))).toBeNull();
    expect(mime(bytes('MZ'))).toBeNull();
    expect(mime(bytes(''))).toBeNull();
    expect(mime(bytes([0x89, 0x50, 0x4e]))).toBeNull();
  });

  it('copes with a view into a larger buffer', () => {
    const buffer = new Uint8Array(64);
    buffer.set(ftyp('qt  ', 'qt  '), 10);
    expect(mime(buffer.subarray(10))).toBe('video/quicktime');
  });
});

describe('what the browser reports', () => {
  it('sorts reported types', () => {
    expect(reportedKind('image/png')).toBe('image');
    expect(reportedKind('VIDEO/MP4; codecs="avc1"')).toBe('video');
    expect(reportedKind('audio/ogg')).toBeNull();
    expect(reportedKind('audio/mpeg')).toBe('audio');
    expect(reportedKind('application/pdf')).toBe('pdf');
    expect(reportedKind('')).toBeNull();
    expect(reportedKind('application/octet-stream')).toBeNull();
    expect(reportedKind('image/svg+xml')).toBe('refused');
    expect(reportedKind('text/html')).toBe('refused');
    expect(reportedKind('video/x-matroska')).toBe('refused');
  });

  it('lets through only what might be media', () => {
    expect(mightBeMedia({ type: 'image/png' })).toBe(true);
    expect(mightBeMedia({ type: '' })).toBe(true);
    expect(mightBeMedia({ type: 'application/pdf' })).toBe(false);
  });

  it('needs both the type and the bytes to agree', () => {
    expect(refusalFor('a.png', 'image/png', PNG)).toBeNull();
    expect(refusalFor('a', '', PNG)).toBeNull();
    // A misnamed file of another allowed picture type is fine: it is stored as what it is.
    expect(refusalFor('a.jpg', 'image/jpeg', PNG)).toBeNull();

    expect(refusalFor('a.svg', 'image/svg+xml', PNG)).toMatch(/a\.svg cannot be embedded/);
    expect(refusalFor('a.png', 'image/png', bytes('<html>'))).toMatch(/contents of a\.png are not a supported type/);
    expect(refusalFor('a.png', 'image/png', WEBM)).toMatch(/says it is a picture but its contents are a video/);
    expect(refusalFor('a.mp4', 'video/mp4', PNG)).toMatch(/says it is a video but its contents are a picture/);
  });
});

describe('sound files and PDFs', () => {
  it('are recognized like rpc/media.rs does', () => {
    const kind = (input: Uint8Array) => {
      const found = sniffMedia(input);
      return found && `${found.kind} ${found.mime}`;
    };
    expect(kind(bytes('%PDF-1.7\n'))).toBe('pdf application/pdf');
    expect(kind(bytes('ID3', [4, 0, 0, 0, 0, 0, 0]))).toBe('audio audio/mpeg');
    expect(kind(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe('audio audio/mpeg');
    expect(kind(bytes([0xff, 0xf1, 0x50, 0x80]))).toBe('audio audio/aac');
    expect(kind(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '))).toBe('audio audio/wav');
    expect(kind(bytes('fLaC', [0, 0, 0, 0x22]))).toBe('audio audio/flac');
    expect(kind(bytes('OggS', [0, 2, 0, 0, 0, 0, 0, 0, 0, 0], 'OpusHead'))).toBe('audio audio/ogg');
    expect(kind(bytes('OggS', [0, 2, 0, 0, 1], 'vorbis'))).toBe('audio audio/ogg');
    expect(kind(bytes('OggS', [0, 2, 0, 0, 0x80], 'theora', [1], 'vorbis'))).toBe('video video/ogg');
    expect(kind(bytes([0, 0, 0, 20], 'ftypM4A ', [0, 0, 0, 0], 'isom'))).toBe('audio audio/mp4');
    expect(kind(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image image/jpeg');
  });

  it('are refused in pages and accepted on cards', () => {
    const pdf = bytes('%PDF-1.7\n');
    const mp3 = bytes('ID3', [4, 0, 0, 0, 0, 0, 0]);
    expect(mightBeMedia({ type: 'application/pdf' })).toBe(false);
    expect(mightBeMedia({ type: 'application/pdf' }, CARD_KINDS)).toBe(true);
    expect(refusalFor('a.pdf', 'application/pdf', pdf)).toMatch(/a\.pdf cannot be embedded/);
    expect(refusalFor('a.pdf', '', pdf)).toMatch(/contents of a\.pdf are not a supported type/);
    expect(refusalFor('a.pdf', 'application/pdf', pdf, CARD_KINDS)).toBeNull();
    expect(refusalFor('a.mp3', 'audio/mpeg', mp3, CARD_KINDS)).toBeNull();
    expect(refusalFor('a.mp3', 'audio/mpeg', pdf, CARD_KINDS)).toMatch(/says it is a sound file but its contents are a PDF/);
    expect(refusalFor('a.svg', 'image/svg+xml', PNG, CARD_KINDS)).toMatch(/cannot be embedded/);
  });
});
