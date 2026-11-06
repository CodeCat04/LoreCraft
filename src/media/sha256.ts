/**
 * SHA-256 that takes its input in pieces. `crypto.subtle` can only hash one whole buffer,
 * which would mean holding a large video in memory. Integrity checking only, not security.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK = 64;

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(BLOCK);
  private readonly words = new Int32Array(64);
  private buffered = 0;
  private length = 0;

  update(data: Uint8Array): this {
    this.length += data.length;
    let offset = 0;
    if (this.buffered > 0) {
      const take = Math.min(BLOCK - this.buffered, data.length);
      this.buffer.set(data.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered < BLOCK) return this;
      this.compress(this.buffer, 0);
      this.buffered = 0;
    }
    for (; offset + BLOCK <= data.length; offset += BLOCK) this.compress(data, offset);
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset));
      this.buffered = data.length - offset;
    }
    return this;
  }

  /** Finishes the hash. The object cannot be used after this. */
  hex(): string {
    const totalBits = this.length * 8;
    const padding = new Uint8Array((this.buffered < 56 ? 56 : 120) - this.buffered + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(totalBits / 2 ** 32));
    view.setUint32(padding.length - 4, totalBits >>> 0);
    this.update(padding);
    let out = '';
    for (const word of this.state) out += word.toString(16).padStart(8, '0');
    return out;
  }

  private compress(data: Uint8Array, at: number) {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const j = at + i * 4;
      w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const s = this.state;
    let a = s[0] | 0;
    let b = s[1] | 0;
    let c = s[2] | 0;
    let d = s[3] | 0;
    let e = s[4] | 0;
    let f = s[5] | 0;
    let g = s[6] | 0;
    let h = s[7] | 0;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    s[0] += a;
    s[1] += b;
    s[2] += c;
    s[3] += d;
    s[4] += e;
    s[5] += f;
    s[6] += g;
    s[7] += h;
  }
}

/** Reads a blob a piece at a time and hashes it. Used by the worker and as its fallback. */
export async function hashBlob(blob: Blob, pieceBytes = 4 * 1024 * 1024): Promise<string> {
  const hash = new Sha256();
  for (let offset = 0; offset < blob.size; offset += pieceBytes) {
    hash.update(new Uint8Array(await blob.slice(offset, offset + pieceBytes).arrayBuffer()));
  }
  return hash.hex();
}
