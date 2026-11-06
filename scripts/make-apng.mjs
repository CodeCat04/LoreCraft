// Assembles the frames saved by e2e/trailer.mjs into an animated PNG, in plain Node.
//
//   node scripts/make-apng.mjs [framesDir] [out.png] [--width 960] [--poster poster.png]
//   node scripts/make-apng.mjs --check out.png [dumpDir]   decodes an APNG back and reports on it
//
// Each frame is scaled down, shown for its own time, and scenes cross-fade into each other
// with a few blended frames. Only the part of a frame that changed is stored, so held
// screens cost almost nothing.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---------------------------------------------------------------------------
// Reading PNGs
// ---------------------------------------------------------------------------

function chunksOf(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
  const out = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    out.push({ type, data: buf.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes PNG row filters. Returns the raw bytes, `bpp` bytes per pixel. */
function unfilter(data, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const type = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[src + x];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
      let v;
      if (type === 0) v = raw;
      else if (type === 1) v = raw + a;
      else if (type === 2) v = raw + b;
      else if (type === 3) v = raw + ((a + b) >> 1);
      else if (type === 4) v = raw + paeth(a, b, c);
      else throw new Error(`Bad filter ${type}`);
      out[row + x] = v & 255;
    }
  }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Converts raw pixels of a colour type to RGB. */
function toRgb(raw, width, height, colorType) {
  const n = CHANNELS[colorType];
  if (n === 3) return raw;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i += 1, j += n) {
    if (n === 4) {
      // Screenshots are opaque; blend anything else onto black.
      const al = raw[j + 3] / 255;
      out[i * 3] = raw[j] * al;
      out[i * 3 + 1] = raw[j + 1] * al;
      out[i * 3 + 2] = raw[j + 2] * al;
    } else {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = raw[j];
    }
  }
  return out;
}

/** Reads an 8-bit, non-interlaced PNG as RGB. */
export function readPng(buf) {
  const chunks = chunksOf(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colorType, , , interlace] = ihdr.subarray(8, 13);
  if (depth !== 8 || interlace !== 0 || !CHANNELS[colorType]) throw new Error('Only 8-bit, non-interlaced grey or RGB(A) PNGs are read');
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = unfilter(inflateSync(idat), width, height, CHANNELS[colorType]);
  return { width, height, rgb: toRgb(raw, width, height, colorType) };
}

/** Decodes every frame of an APNG to full RGB images, with their delays in ms. */
export function readApng(buf) {
  const chunks = chunksOf(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const colorType = ihdr[9];
  const actl = chunks.find((c) => c.type === 'acTL');
  if (!actl) throw new Error('No acTL: not animated');
  const declared = actl.data.readUInt32BE(0);
  const canvas = Buffer.alloc(width * height * 3);
  const frames = [];
  let current = null;
  let seq = -1;
  const flush = () => {
    if (!current) return;
    const { fw, fh, fx, fy, delay, parts } = current;
    const raw = unfilter(inflateSync(Buffer.concat(parts)), fw, fh, CHANNELS[colorType]);
    const rgb = toRgb(raw, fw, fh, colorType);
    for (let y = 0; y < fh; y += 1) rgb.copy(canvas, ((fy + y) * width + fx) * 3, y * fw * 3, (y + 1) * fw * 3);
    frames.push({ delay, rgb: Buffer.from(canvas) });
    current = null;
  };
  for (const { type, data } of chunks) {
    if (type === 'fcTL' || type === 'fdAT') {
      const s = data.readUInt32BE(0);
      if (s !== seq + 1) throw new Error(`Sequence number ${s} after ${seq}`);
      seq = s;
    }
    if (type === 'fcTL') {
      flush();
      const den = data.readUInt16BE(22) || 100;
      current = {
        fw: data.readUInt32BE(4), fh: data.readUInt32BE(8), fx: data.readUInt32BE(12), fy: data.readUInt32BE(16),
        delay: (data.readUInt16BE(20) * 1000) / den, parts: [],
      };
      if (current.fx + current.fw > width || current.fy + current.fh > height) throw new Error('Frame outside the image');
    } else if (type === 'IDAT' && current) current.parts.push(data);
    else if (type === 'fdAT') current.parts.push(data.subarray(4));
  }
  flush();
  if (frames.length !== declared) throw new Error(`acTL says ${declared} frames, found ${frames.length}`);
  return { width, height, frames };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

/** Filters a region of an RGB image row by row, picking the filter that looks smallest. */
function filterRegion(rgb, width, x0, y0, w, h) {
  const stride = w * 3;
  const out = Buffer.alloc((stride + 1) * h);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    rgb.copy(line, 0, ((y0 + y) * width + x0) * 3, ((y0 + y) * width + x0 + w) * 3);
    let best = -1;
    let bestScore = Infinity;
    for (let f = 0; f <= 4; f += 1) {
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= 3 ? line[i - 3] : 0;
        const b = y > 0 ? prev[i] : 0;
        const c = i >= 3 && y > 0 ? prev[i - 3] : 0;
        const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (line[i] - p) & 255;
        cand[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
        out[y * (stride + 1)] = f;
        cand.copy(out, y * (stride + 1) + 1);
      }
    }
    if (best < 0) throw new Error('unreachable');
    line.copy(prev);
  }
  return deflateSync(out, { level: 9, memLevel: 9 });
}

/** The smallest box holding every pixel that differs between two images, or null. */
function changedBox(a, b, width, height) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const i = row + x * 3;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Writes RGB frames as an APNG. Each frame is `{ rgb, ms }`; it loops forever. */
export function writeApng(width, height, frames) {
  // Merge frames that look the same into one longer one.
  const merged = [];
  for (const f of frames) {
    const last = merged.at(-1);
    if (last && last.rgb.equals(f.rgb)) last.ms += f.ms;
    else merged.push({ ...f });
  }
  const parts = [SIGNATURE];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  parts.push(chunk('IHDR', ihdr));
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(merged.length, 0);
  actl.writeUInt32BE(0, 4);
  parts.push(chunk('acTL', actl));
  let seq = 0;
  merged.forEach((f, index) => {
    const box = index === 0 ? { x: 0, y: 0, w: width, h: height } : (changedBox(merged[index - 1].rgb, f.rgb, width, height) ?? { x: 0, y: 0, w: 1, h: 1 });
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(box.w, 4);
    fctl.writeUInt32BE(box.h, 8);
    fctl.writeUInt32BE(box.x, 12);
    fctl.writeUInt32BE(box.y, 16);
    fctl.writeUInt16BE(Math.min(65535, Math.round(f.ms)), 20);
    fctl.writeUInt16BE(1000, 22);
    fctl[24] = 0; // dispose: none, the next frame draws over this one
    fctl[25] = 0; // blend: source, replace the box
    parts.push(chunk('fcTL', fctl));
    const data = filterRegion(f.rgb, width, box.x, box.y, box.w, box.h);
    if (index === 0) parts.push(chunk('IDAT', data));
    else {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(seq++, 0);
      parts.push(chunk('fdAT', Buffer.concat([head, data])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return { buffer: Buffer.concat(parts), count: merged.length };
}

/** Writes one RGB image as a plain PNG. */
export function writePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', filterRegion(rgb, width, 0, 0, width, height)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Scaling and blending
// ---------------------------------------------------------------------------

/** Scales an RGB image down by averaging the source pixels under each target pixel. */
function scaleDown(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 3);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const ya = y * fy;
    const yb = ya + fy;
    for (let x = 0; x < dw; x += 1) {
      const xa = x * fx;
      const xb = xa + fx;
      let r = 0;
      let g = 0;
      let b = 0;
      let total = 0;
      for (let sy = Math.floor(ya); sy < Math.ceil(yb); sy += 1) {
        const wy = Math.min(sy + 1, yb) - Math.max(sy, ya);
        for (let sx = Math.floor(xa); sx < Math.ceil(xb); sx += 1) {
          const w = wy * (Math.min(sx + 1, xb) - Math.max(sx, xa));
          const i = (sy * sw + sx) * 3;
          r += src[i] * w;
          g += src[i + 1] * w;
          b += src[i + 2] * w;
          total += w;
        }
      }
      const o = (y * dw + x) * 3;
      out[o] = Math.round(r / total);
      out[o + 1] = Math.round(g / total);
      out[o + 2] = Math.round(b / total);
    }
  }
  return out;
}

function blend(a, b, t) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = Math.round(a[i] + (b[i] - a[i]) * t);
  return out;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function option(args, name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const [value] = args.splice(at, 2).slice(1);
  return value;
}

function check(file, dumpDir) {
  const { width, height, frames } = readApng(readFileSync(file));
  const total = frames.reduce((sum, f) => sum + f.delay, 0);
  console.log(`${file}: ${width}x${height}, ${frames.length} frames, ${(total / 1000).toFixed(1)} s, ${(statSync(file).size / 1e6).toFixed(2)} MB`);
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true });
    let at = 0;
    frames.forEach((f, i) => {
      writeFileSync(join(dumpDir, `frame-${String(i).padStart(4, '0')}-${Math.round(at)}ms.png`), writePng(width, height, f.rgb));
      at += f.delay;
    });
    console.log(`Wrote ${frames.length} frames to ${dumpDir}`);
  }
}

function make(args) {
  const width = Number(option(args, '--width', 960));
  const fadeFrames = Number(option(args, '--fade', 5));
  const poster = option(args, '--poster', join(ROOT, 'docs', 'media', 'trailer-poster.png'));
  const dir = args[0] ?? join(ROOT, 'e2e', 'artifacts', 'trailer');
  const out = args[1] ?? join(ROOT, 'docs', 'media', 'trailer.png');
  const { frames, poster: posterIndex } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!frames.length) throw new Error(`No frames in ${dir}`);

  let height = 0;
  const scaled = frames.map((f) => {
    const img = readPng(readFileSync(join(dir, f.file)));
    height ||= Math.round((img.height * width) / img.width);
    return { ...f, rgb: scaleDown(img.rgb, img.width, img.height, width, height) };
  });
  console.log(`Scaled ${frames.length} frames to ${width}x${height}`);

  // Cross-fade between scenes: the last of one blends into the first of the next.
  const timeline = [];
  scaled.forEach((f, i) => {
    const prev = scaled[i - 1];
    if (prev && prev.scene !== f.scene && fadeFrames > 0) {
      for (let k = 1; k <= fadeFrames; k += 1) timeline.push({ rgb: blend(prev.rgb, f.rgb, k / (fadeFrames + 1)), ms: 50 });
    }
    timeline.push({ rgb: f.rgb, ms: f.ms });
  });

  const { buffer, count } = writeApng(width, height, timeline);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buffer);
  const total = timeline.reduce((sum, f) => sum + f.ms, 0);
  console.log(`Wrote ${out}: ${width}x${height}, ${count} frames, ${(total / 1000).toFixed(1)} s, ${(buffer.length / 1e6).toFixed(2)} MB`);

  const still = scaled[posterIndex ?? 0];
  writeFileSync(poster, writePng(width, height, still.rgb));
  console.log(`Wrote ${poster}`);
}

const args = process.argv.slice(2);
if (args[0] === '--check') check(args[1], args[2]);
else make(args);

