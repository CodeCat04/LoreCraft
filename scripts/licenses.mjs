#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_LICENSES.txt, the notices for everything LoreCraft ships: each package's
 * name, version, license, source and full license and notice texts. It also writes a
 * LICENSE.txt beside each spelling dictionary, in src-tauri/resources/dictionaries/. The
 * installer carries both (`bundle.resources` in src-tauri/tauri.conf.json), and About shows
 * the first.
 *
 *   node scripts/licenses.mjs           writes the files
 *   node scripts/licenses.mjs --check   fails if a committed file is out of date
 *
 * - npm: every production dependency in package-lock.json, which covers all the web view's
 *   bundle can contain, fonts included. The dictionaries have a section of their own, since
 *   they ship as separate files.
 * - Rust: `cargo metadata` for every platform, so macOS and Linux crates are covered too,
 *   following normal dependencies from `lorecraft`. Build scripts' dependencies and
 *   procedural macros are left out, since none of their code ships.
 *
 * License, copying and notice files are copied from each package's folder. A package with
 * none gets the standard text of its license from scripts/license-texts/. A text that is
 * exactly the same as one given earlier is given once, and named again after that.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'THIRD_PARTY_LICENSES.txt');
const STANDARD_TEXTS = join(ROOT, 'scripts', 'license-texts');
const DICTIONARY_FOLDER = join(ROOT, 'src-tauri', 'resources', 'dictionaries');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;
const RULE = '-'.repeat(78);

/** Where a package offers a choice, the one LoreCraft takes. */
export const CHOSEN = {
  'dictionary-es': 'MPL-1.1',
  'dictionary-pt': 'MPL-2.0',
  jszip: 'MIT',
};

/** The language folder each dictionary package ships in, and the license texts it needs. */
export const DICTIONARIES = [
  { code: 'en-US', name: 'English (United States)', pkg: 'dictionary-en', texts: [] },
  { code: 'en-GB', name: 'English (United Kingdom)', pkg: 'dictionary-en-gb', texts: [] },
  { code: 'es', name: 'Spanish', pkg: 'dictionary-es', texts: ['MPL-1.1'] },
  { code: 'fr', name: 'French', pkg: 'dictionary-fr', texts: ['MPL-2.0'] },
  // Either version, as the authors allow, so both are given.
  { code: 'de', name: 'German', pkg: 'dictionary-de', texts: ['GPL-2.0', 'GPL-3.0'] },
  { code: 'pt', name: 'Portuguese', pkg: 'dictionary-pt', texts: ['MPL-2.0'] },
  // Its own license file holds the whole GPL.
  { code: 'it', name: 'Italian', pkg: 'dictionary-it', texts: [] },
  { code: 'ru', name: 'Russian', pkg: 'dictionary-ru', texts: [] },
];

// ---- Texts ---------------------------------------------------------------------------

/** Line endings, trailing spaces and a byte order mark make no difference to a license. */
export function normalizeText(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\s+$/g, '');
}

function standardText(id, holder) {
  const path = join(STANDARD_TEXTS, `${id}.txt`);
  if (!existsSync(path)) throw new Error(`There is no standard text for ${id} in scripts/license-texts.`);
  return normalizeText(readFileSync(path, 'utf8').replace('{copyright}', `Copyright (c) ${holder}`));
}

/** The licenses an SPDX expression asks for: one from each choice, MIT where offered. */
export function licensesToGive(expression, chosen) {
  if (chosen) return [chosen];
  const preference = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'MPL-2.0', 'ISC', 'Zlib'];
  // Old crates write `MIT/Apache-2.0` for `AGPL-3.0-only`.
  const clean = expression.replace(/\s*\/\s*/g, ' OR ').replace(/[()]/g, ' ');
  return clean
    .split(/\s+AND\s+/)
    .map((part) => {
      const options = part.split(/\s+OR\s+/).map((option) => option.trim()).filter(Boolean);
      return preference.find((id) => options.includes(id)) ?? options[0];
    })
    .filter((id, index, all) => id && all.indexOf(id) === index);
}

function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: normalizeText(readFileSync(join(dir, name), 'utf8')) }))
    .filter((file) => file.text);
}

/** A package's own license files, or the standard texts for its license if it has none. */
function textsFor(pkg) {
  const own = licenseFiles(pkg.dir);
  if (own.length > 0) return own;
  const holder = pkg.authors || `the ${pkg.name} authors`;
  return licensesToGive(pkg.license, CHOSEN[pkg.name]).map((id) => ({
    name: `${id} (standard text; the package has no license file)`,
    text: standardText(id, holder),
  }));
}

/**
 * Fonts whose package license file names the wrong copyright holder: these fontsource
 * packages copy a template naming Google Inc. Each line is the font's own, from its upstream
 * license, and is printed with the package so the notice names the real authors.
 */
const FONT_COPYRIGHTS = {
  '@fontsource/libertinus-serif':
    'Copyright © 2012-2024 The Libertinus Project Authors, with Reserved Font Name "Linux Libertine", "Biolinum", "STIX Fonts". (https://github.com/alerque/libertinus)',
  '@fontsource/source-serif-4':
    'Copyright 2014 - 2023 Adobe (http://www.adobe.com/), with Reserved Font Name ‘Source’. (https://github.com/adobe-fonts/source-serif)',
};

function repositoryUrl(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) return '';
  const shorthand = url.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
  if (shorthand) return `https://github.com/${shorthand[1]}`;
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '');
}

// ---- npm -----------------------------------------------------------------------------

export function npmPackages(root = ROOT) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const dictionaries = new Set(DICTIONARIES.map((d) => d.pkg));
  const seen = new Map();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev || entry.link) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (dictionaries.has(name)) continue;
    const key = `${name}@${entry.version}`;
    if (seen.has(key)) continue;
    const dir = join(root, path);
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      // An optional package for another platform is not installed here. The lock file
      // still says what it is.
    }
    const author = (typeof manifest.author === 'string' ? manifest.author : manifest.author?.name)?.replace(/\s*[<(][^>)]*[>)]/g, '');
    seen.set(key, {
      name,
      version: entry.version,
      license: entry.license ?? manifest.license ?? 'UNKNOWN',
      // A package for one platform is installed only on that platform, so its manifest is
      // missing elsewhere. Its npm page is used everywhere, so every platform writes the same file.
      source: entry.os || entry.cpu
        ? `https://www.npmjs.com/package/${name}`
        : repositoryUrl(manifest.repository) || manifest.homepage || `https://www.npmjs.com/package/${name}`,
      authors: author ?? '',
      dir,
    });
  }
  return sortPackages([...seen.values()]);
}

// ---- Rust ----------------------------------------------------------------------------

export function cargoPackages(metadata) {
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const root = metadata.packages.find((p) => p.name === 'lorecraft' && !p.source);
  const seen = new Set();
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue;
      const pkg = packages.get(dep.pkg);
      if (pkg.targets.some((target) => target.kind.includes('proc-macro'))) continue;
      stack.push(dep.pkg);
    }
  }
  return sortPackages(
    [...seen]
      .map((id) => packages.get(id))
      // LoreCraft's own crates have no source: they are under its license.
      .filter((pkg) => pkg.source)
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? `see ${pkg.license_file}`,
        source: pkg.repository || pkg.homepage || `https://crates.io/crates/${pkg.name}`,
        authors: (pkg.authors ?? []).map((a) => a.replace(/\s*<[^>]*>/, '')).join(', '),
        dir: dirname(pkg.manifest_path),
      })),
  );
}

function cargoMetadata() {
  const out = execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml')],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out);
}

function sortPackages(list) {
  return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

// ---- Dictionaries ----------------------------------------------------------------------

function dictionaryInfo(entry, root = ROOT) {
  const dir = join(root, 'node_modules', entry.pkg);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const readme = readFileSync(join(dir, 'readme.md'), 'utf8');
  const upstream = readme.match(/^\[source\]:\s*(\S+)/m)?.[1] ?? '';
  return {
    ...entry,
    version: manifest.version,
    license: manifest.license,
    chosen: CHOSEN[entry.pkg] ?? '',
    repository: repositoryUrl(manifest.repository),
    upstream,
    own: licenseFiles(dir),
    standard: entry.texts.map((id) => ({ name: `${id} (full text)`, text: standardText(id, '') })),
  };
}

/** The LICENSE.txt that ships in each dictionary's folder. */
export function dictionaryLicense(info) {
  const lines = [
    `Spelling dictionary: ${info.name} (${info.code})`,
    '',
    `index.aff and index.dic come from the npm package ${info.pkg} ${info.version}.`,
    'LoreCraft reads them as data. They are not part of its program.',
    '',
    `License: ${info.license}`,
  ];
  if (info.chosen) lines.push(`LoreCraft distributes them under ${info.chosen}, one of the licenses offered.`);
  lines.push(
    `Source: ${info.repository}`,
    `Original source: ${info.upstream}`,
    `Package: https://www.npmjs.com/package/${info.pkg}/v/${info.version}`,
  );
  for (const file of [...info.own, ...info.standard]) {
    lines.push('', RULE, file.name, RULE, '', file.text);
  }
  return `${lines.join('\n')}\n`;
}

// ---- The notices -----------------------------------------------------------------------

export function renderNotices({ dictionaries, npm, cargo }) {
  const given = new Map();
  const out = [];
  const section = (title, intro) => out.push('', '', '='.repeat(78), title, '='.repeat(78), '', intro);
  const entry = (pkg, texts, extra = []) => {
    out.push('', RULE, `${pkg.name} ${pkg.version}`, `License: ${pkg.license}`);
    if (CHOSEN[pkg.name]) out.push(`LoreCraft uses it under ${CHOSEN[pkg.name]}, one of the licenses offered.`);
    out.push(...extra, `Source: ${pkg.source}`, RULE);
    for (const file of texts) {
      const first = given.get(file.text);
      if (first) {
        out.push('', `${file.name}: the same text as given above for ${first}.`);
      } else {
        given.set(file.text, `${pkg.name} ${pkg.version}`);
        out.push('', `${file.name}:`, '', file.text);
      }
    }
  };

  out.push(
    'LoreCraft: third-party licenses',
    '',
    'LoreCraft is under the GNU Affero General Public License v3.0. It is built from the software below and ships with',
    'the data files below, each under its own license, whose terms and notices follow.',
    '',
    'This file is made by scripts/licenses.mjs. Run "npm run licenses" to update it.',
    '',
    `1. Spelling dictionaries: ${dictionaries.length}`,
    `2. JavaScript packages: ${npm.length}`,
    `3. Rust crates: ${cargo.length}`,
  );

  section(
    '1. Spelling dictionaries',
    'These ship as separate files in the dictionaries folder beside the program, each with\n' +
      'its own LICENSE.txt. The spellchecker reads one as data when its language is chosen.',
  );
  for (const info of dictionaries) {
    entry(
      { name: info.pkg, version: info.version, license: info.license, source: info.repository },
      [...info.own, ...info.standard],
      [`Language: ${info.name} (${info.code})`, `Original source: ${info.upstream}`],
    );
  }

  section('2. JavaScript packages', 'The interface and its fonts are built from these npm packages.');
  for (const pkg of npm) {
    const font = FONT_COPYRIGHTS[pkg.name];
    entry(pkg, textsFor(pkg), font ? [`Font copyright, from the font's own license: ${font}`] : []);
  }

  section('3. Rust crates', 'The program itself is built from these crates, for Windows, macOS and Linux.');
  for (const pkg of cargo) entry(pkg, textsFor(pkg));

  return `${out.join('\n')}\n`;
}

export function buildAll() {
  const dictionaries = DICTIONARIES.map((entry) => dictionaryInfo(entry));
  const files = new Map();
  files.set(OUTPUT, renderNotices({ dictionaries, npm: npmPackages(), cargo: cargoPackages(cargoMetadata()) }));
  for (const info of dictionaries) files.set(join(DICTIONARY_FOLDER, info.code, 'LICENSE.txt'), dictionaryLicense(info));
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const files = buildAll();
  const stale = [];
  for (const [path, text] of files) {
    // A checkout may have turned the line endings into CRLF, which changes nothing.
    const current = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === text) continue;
    if (check) {
      stale.push(relative(ROOT, path));
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`Wrote ${relative(ROOT, path)}`);
    }
  }
  if (stale.length > 0) {
    console.error(`These license files are out of date:\n  ${stale.join('\n  ')}\nRun "npm run licenses" and commit the result.`);
    process.exit(1);
  }
  if (check) console.log('The license files are up to date.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
