// Builds the portable zip from a release build: `npm run app:release`, then `npm run portable`.
//
// The zip holds lorecraft.exe, the bundle resources at the paths the installer gives them,
// LICENSE, a README.txt, and the `portable` marker that keeps all data in a `data` folder
// beside the program (src-tauri/src/paths.rs). Written with plain Node, no packages.
//
// `--exe <path>` zips a different build, `--out <path>` writes the zip somewhere else.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = join(ROOT, 'src-tauri');

function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function findExe() {
  const given = option('--exe');
  const candidates = given
    ? [resolve(given)]
    : [
        process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, 'release', 'lorecraft.exe'),
        join(TAURI, 'target', 'release', 'lorecraft.exe'),
      ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`No release build. Run "npm run app:release" first. Looked in:\n${candidates.join('\n')}`);
    process.exit(1);
  }
  return found;
}

const README = (version) => `LoreCraft ${version}, portable

Run lorecraft.exe. Nothing is installed.

Everything LoreCraft keeps for itself (settings, recovery copies, backups, logs and
downloaded models) stays in the "data" folder next to lorecraft.exe. Your projects are
saved wherever you choose. To move LoreCraft to another computer or a USB drive, copy
this whole folder.

The folder must be somewhere you can write to. On a locked drive LoreCraft says so and
does not start.

The file named "portable" turns this on. Delete it to keep the data in your user profile,
as the installed version does.

LoreCraft needs Microsoft Edge WebView2, which comes with Windows 11. On Windows 10, get
it from https://developer.microsoft.com/microsoft-edge/webview2/ if LoreCraft does not open.

License: AGPL-3.0-only, see LICENSE. Third-party licenses: THIRD_PARTY_LICENSES.txt.
Source code: https://github.com/CodeCat04/LoreCraft
`;

/** Every file in the zip, as [path in the zip, contents]. */
function collect(exe, version) {
  const files = new Map();
  const addFrom = (zipPath, diskPath) => {
    if (statSync(diskPath).isDirectory()) {
      for (const name of readdirSync(diskPath).sort()) addFrom(`${zipPath}/${name}`, join(diskPath, name));
    } else {
      files.set(zipPath.replace(/^\/+/, '').replace(/\/+/g, '/'), readFileSync(diskPath));
    }
  };
  addFrom('lorecraft.exe', exe);
  const config = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8'));
  const resources = config.bundle?.resources ?? {};
  const entries = Array.isArray(resources) ? resources.map((p) => [p, p]) : Object.entries(resources);
  for (const [from, to] of entries) addFrom(to.replace(/\/$/, ''), join(TAURI, from));
  addFrom('LICENSE', join(ROOT, 'LICENSE'));
  files.set('README.txt', Buffer.from(README(version).replace(/\n/g, '\r\n')));
  files.set('portable', Buffer.alloc(0));
  return files;
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** A plain zip: deflate where it helps, stored otherwise, no zip64 (every part is far under 4 GB). */
export function zip(files, when = new Date()) {
  const { time, day } = dosTime(when);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const deflate = packed.length < data.length;
    const body = deflate ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    parts.push(local, name, body);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const exe = findExe();
  const out = resolve(
    option('--out') ??
      join(TAURI, 'target', 'release', 'bundle', 'portable', `LoreCraft_${version}_x64-portable.zip`),
  );
  const files = collect(exe, version);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip(files));
  const shown = relative(ROOT, out).split(sep).join('/');
  console.log(`${shown}: ${files.size} files, ${(statSync(out).size / 1e6).toFixed(1)} MB`);
}
