#!/usr/bin/env node
/**
 * Lists every text passed to `t()` in the source, and what each language's catalog is missing.
 *
 *   node scripts/i18n-extract.mjs           the summary, with missing and unused text per language
 *   node scripts/i18n-extract.mjs --list    every text, one per line
 *   node scripts/i18n-extract.mjs --check   the same summary, and fails if anything is missing
 *
 * Catalogs are src/locales/<code>.json, a map of English text to its translation. To add a
 * language, add a catalog and a line to INTERFACE_LANGUAGES in src/lib/i18n.ts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src');
const LOCALES = join(SOURCE, 'locales');

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** The first argument of each `t(...)` call, when it is a plain string as it must be. */
const CALL = /(?<![\w$.])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;

function unescape(text) {
  return text.replace(/\\(.)/gs, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
}

export function extract() {
  const found = new Map();
  for (const file of sourceFiles(SOURCE)) {
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(CALL)) {
      const text = unescape(match[1] ?? match[2] ?? match[3]);
      if (!found.has(text)) found.set(text, file.slice(ROOT.length + 1).replaceAll('\\', '/'));
    }
  }
  return found;
}

/** What each catalog lacks, what it holds for no reason, and placeholders that do not match. */
export function report() {
  const texts = extract();
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const languages = {};
  for (const name of readdirSync(LOCALES)) {
    if (!name.endsWith('.json')) continue;
    const code = name.slice(0, -5);
    const catalog = JSON.parse(readFileSync(join(LOCALES, name), 'utf8'));
    // Module catalogs in locales/<code>/ add to the main one.
    try {
      for (const part of readdirSync(join(LOCALES, code))) {
        if (part.endsWith('.json')) Object.assign(catalog, JSON.parse(readFileSync(join(LOCALES, code, part), 'utf8')));
      }
    } catch {
      // No module catalogs for this language.
    }
    languages[code] = {
      missing: [...texts.keys()].filter((text) => !catalog[text]),
      unused: Object.keys(catalog).filter((text) => !texts.has(text)),
      badPlaceholders: Object.keys(catalog).filter((text) => texts.has(text) && placeholders(catalog[text]) !== placeholders(text)),
    };
  }
  return { texts, languages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { texts, languages } = report();
  if (process.argv.includes('--list')) {
    for (const [text, file] of texts) console.log(`${file}\t${text}`);
  } else {
    console.log(`${texts.size} texts to translate`);
    let problems = 0;
    for (const [code, { missing, unused, badPlaceholders }] of Object.entries(languages)) {
      console.log(`${code}: ${texts.size - missing.length} of ${texts.size} translated`);
      for (const text of missing) console.log(`  missing: ${text}`);
      for (const text of unused) console.log(`  unused: ${text}`);
      for (const text of badPlaceholders) console.log(`  different placeholders: ${text}`);
      problems += missing.length + badPlaceholders.length;
    }
    if (process.argv.includes('--check') && problems > 0) process.exit(1);
  }
}
