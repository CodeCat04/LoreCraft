import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { unpackedSize, unpacksTooLarge } from './zipLimits';

const limits = { maxUnpacked: 4 * 1024 * 1024, ratioFloor: 256 * 1024, maxRatio: 100 };

/** Bytes that do not pack, from a fixed seed so every run sees the same file. */
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    bytes[i] = seed >>> 24;
  }
  return bytes;
}

describe('checking a zip before unpacking it', () => {
  it('reads the unpacked size from the directory', () => {
    const zip = zipSync({ 'a.xml': new Uint8Array(1000), 'b.xml': new Uint8Array(500) });
    expect(unpackedSize(zip)).toBe(1500);
  });

  it('refuses a file that unpacks to far more than its size', () => {
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(1024 * 1024) }, { level: 9 });
    expect(bomb.length * limits.maxRatio).toBeLessThan(1024 * 1024);
    expect(unpacksTooLarge(bomb, limits)).toBe(true);
  });

  it('refuses a file over the size limit however it was packed', () => {
    const stored = zipSync({ 'word/media/big.bin': noise(5 * 1024 * 1024) }, { level: 0 });
    expect(unpacksTooLarge(stored, limits)).toBe(true);
  });

  it('accepts an ordinary file', () => {
    const ordinary = zipSync({ 'word/document.xml': noise(512 * 1024) });
    expect(unpacksTooLarge(ordinary, limits)).toBe(false);
  });

  it('accepts a small file that packs well, below the size where growth matters', () => {
    const small = zipSync({ 'word/document.xml': new Uint8Array(100 * 1024) }, { level: 9 });
    expect(unpacksTooLarge(small, limits)).toBe(false);
  });

  it('leaves a file that is not a zip to the reader, which reports it', () => {
    expect(unpacksTooLarge(new TextEncoder().encode('not a zip at all'), limits)).toBe(false);
  });
});
