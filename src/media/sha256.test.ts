// @vitest-environment node

import { hashBlob, Sha256 } from './sha256';

const text = (value: string) => new TextEncoder().encode(value);

/** Bytes that do not repeat, the same on every run. */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** The platform's answer, for one buffer at a time. */
async function platform(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice()));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Sha256', () => {
  it('matches the published test vectors', () => {
    expect(new Sha256().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(text('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(
      new Sha256().update(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).hex(),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('agrees with the platform at every length around the block boundaries', async () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000]) {
      const data = noise(length);
      expect(new Sha256().update(data).hex()).toBe(await platform(data));
    }
  });

  it('gives the same answer however the input is divided', async () => {
    const data = noise(10_000);
    const expected = await platform(data);
    for (const piece of [1, 7, 63, 64, 65, 1000, 4096]) {
      const hash = new Sha256();
      for (let at = 0; at < data.length; at += piece) hash.update(data.subarray(at, at + piece));
      expect(hash.hex()).toBe(expected);
    }
  });

  it('handles lengths past the 32-bit bit count', async () => {
    // 600 MiB is past 2^32 bits, where a careless length field would go wrong.
    const block = noise(1024 * 1024);
    const whole = new Uint8Array(600 * 1024 * 1024);
    const ours = new Sha256();
    for (let i = 0; i < 600; i += 1) {
      whole.set(block, i * block.length);
      ours.update(block);
    }
    expect(ours.hex()).toBe(await platform(whole));
  }, 30_000);
});

describe('hashBlob', () => {
  it('hashes a blob read in pieces', async () => {
    const data = noise(100_000);
    const hash = await hashBlob(new Blob([data.slice()]), 7000);
    expect(hash).toBe(await platform(data));
  });

  it('hashes an empty blob', async () => {
    expect(await hashBlob(new Blob([]))).toBe(new Sha256().hex());
  });
});
