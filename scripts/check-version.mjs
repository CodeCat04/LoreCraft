#!/usr/bin/env node
/**
 * Fails unless every place that states LoreCraft's version agrees with package.json.
 *
 *   node scripts/check-version.mjs              package.json, Cargo.toml and both lock files
 *   node scripts/check-version.mjs --tag v1.2.3  the same, and the tag must name that version
 *
 * The app reports Cargo's version (CARGO_PKG_VERSION, which the update check compares with
 * the latest release), while the installers take theirs from tauri.conf.json, which reads
 * package.json. So the two must match, or an installer would say one version and the app
 * another. Tags are read as `v1.2.3` or `1.2.3`, as the update check reads them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** The `version` in the first table of a Cargo.toml that is `[package]`. */
function cargoPackageVersion(toml) {
  const section = toml.match(/^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  return section?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** The version Cargo.lock records for one package. */
function lockedCrateVersion(lock, name) {
  for (const block of lock.split(/^\[\[package\]\]\s*$/m)) {
    if (block.match(/^name\s*=\s*"([^"]+)"/m)?.[1] === name) return block.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  }
  return null;
}

export function check({ tag } = {}) {
  const pkg = JSON.parse(read('package.json'));
  const expected = pkg.version;
  const problems = [];
  const expect = (where, found) => {
    if (found !== expected) problems.push(`${where} says ${found ?? 'nothing'}, package.json says ${expected}.`);
  };

  const cargoToml = read('src-tauri/Cargo.toml');
  const crate = cargoToml.match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m)?.[1] ?? 'lorecraft';
  expect('src-tauri/Cargo.toml', cargoPackageVersion(cargoToml));
  expect('src-tauri/Cargo.lock', lockedCrateVersion(read('src-tauri/Cargo.lock'), crate));

  const lock = JSON.parse(read('package-lock.json'));
  expect('package-lock.json', lock.version);
  expect('package-lock.json (packages[""])', lock.packages?.['']?.version);

  // Pointing at package.json is what keeps the installers in step, so a number here is a mistake
  // waiting to happen even when it matches today.
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json')).version;
  if (tauri !== '../package.json') {
    problems.push(`src-tauri/tauri.conf.json has version ${JSON.stringify(tauri)}. Set it to "../package.json".`);
  }

  if (tag !== undefined) {
    const named = tag.replace(/^refs\/tags\//, '').replace(/^v/, '');
    if (named !== expected) problems.push(`The tag ${tag} does not match version ${expected}. Tag v${expected}, or change the version first.`);
  }
  return { version: expected, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--tag');
  const tag = at === -1 ? undefined : process.argv[at + 1];
  if (at !== -1 && !tag) {
    console.error('--tag needs a tag, such as --tag v1.2.3');
    process.exit(2);
  }
  const { version, problems } = check({ tag });
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error('See "Making a release" in docs/RELEASING.md.');
    process.exit(1);
  }
  console.log(`Version ${version} everywhere${tag ? `, and the tag ${tag} matches` : ''}.`);
}
