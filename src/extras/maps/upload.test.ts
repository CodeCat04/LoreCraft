import { refusalFor, sniffImageType, titleFromFileName } from './upload';

const text = (value: string) => new TextEncoder().encode(value);
const bytes = (...values: number[]) => new Uint8Array(values);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);

describe('sniffImageType', () => {
  it('recognizes what maps can use by their bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(text('GIF89a...'))).toBe('image/gif');
    expect(sniffImageType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(text('\0\0\0\x20ftypavif\0\0\0\0'))).toBe('image/avif');
  });

  it('recognizes what maps cannot use', () => {
    expect(sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffImageType(text('  <?xml version="1.0"?>\n<svg></svg>'))).toBe('image/svg+xml');
    expect(sniffImageType(text('BM\0\0\0\0'))).toBe('image/bmp');
    expect(sniffImageType(text('II*\0\0\0'))).toBe('image/tiff');
    expect(sniffImageType(text('\0\0\0\x20ftypheic\0\0\0\0'))).toBe('image/heic');
    expect(sniffImageType(text('just some words'))).toBeNull();
  });
});

describe('refusalFor', () => {
  it('accepts supported images', () => {
    expect(refusalFor(PNG)).toBeNull();
    expect(refusalFor(JPEG)).toBeNull();
  });

  it('says why anything else is refused', () => {
    expect(refusalFor(text('<svg></svg>'))).toContain('can carry scripts');
    expect(refusalFor(text('BM\0\0\0\0'))).toContain('BMP images are not supported');
    expect(refusalFor(text('hello'))).toContain('not an image');
    expect(refusalFor(new Uint8Array())).toContain('empty');
    expect(refusalFor(new Uint8Array(64 * 1024 * 1024 + 1))).toContain('64 MB');
  });

  it('goes by the bytes, so a renamed SVG is still an SVG', () => {
    // The file name is never consulted. These bytes could be called map.png.
    expect(refusalFor(text('<svg onload="alert(1)"></svg>'))).toContain('scripts');
  });
});

describe('titleFromFileName', () => {
  it('makes a readable name', () => {
    expect(titleFromFileName('the_northern-reaches.png')).toBe('the northern reaches');
    expect(titleFromFileName('Vale.v2.webp')).toBe('Vale.v2');
    expect(titleFromFileName('.png')).toBe('Untitled map');
  });
});
