import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { WRITING_LANGUAGES } from '../../lib/languages';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../lib/rpc', () => ({ rpc }));

const { DICTIONARY_LANGUAGES, loadDictionary } = await import('./dictionaries');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|css)$/.test(entry.name) ? [path] : [];
  });
}

describe('spelling dictionaries', () => {
  // In braces: a function returned from here would be called as a cleanup.
  beforeEach(() => {
    rpc.mockReset();
  });

  it('are never compiled into the app, since some are under the GPL', () => {
    const importing = /(?:from\s*|import\s*\(\s*|import\s+)['"][^'"]*dictionary-[a-z-]+[^'"]*['"]/;
    const offenders = sourceFiles(resolve('src')).filter((file) => importing.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('are read from the files beside the app, through Rust', async () => {
    rpc.mockImplementation((_method: string, { name }: { name: string }) => Promise.resolve({ text: `text of ${name}` }));
    expect(await loadDictionary('de')).toEqual({
      aff: 'text of dictionaries/de/index.aff',
      dic: 'text of dictionaries/de/index.dic',
    });
    expect(rpc).toHaveBeenCalledWith('files.readResource', { name: 'dictionaries/de/index.aff' });
    expect(rpc).toHaveBeenCalledWith('files.readResource', { name: 'dictionaries/de/index.dic' });
  });

  it('refuse a language with none, without asking Rust', async () => {
    await expect(loadDictionary('zh')).rejects.toThrow('There is no dictionary for zh.');
    await expect(loadDictionary('../../THIRD_PARTY_LICENSES.txt')).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('cover every language that offers spellchecking, and each is in the installer with its license', () => {
    const offered = WRITING_LANGUAGES.filter((language) => language.dictionaryScript).map((language) => language.code);
    expect([...DICTIONARY_LANGUAGES].sort()).toEqual([...offered].sort());
    const config = JSON.parse(readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'));
    const targets = Object.values(config.bundle.resources as Record<string, string>);
    for (const code of DICTIONARY_LANGUAGES) {
      expect(targets, code).toContain(`dictionaries/${code}/index.aff`);
      expect(targets, code).toContain(`dictionaries/${code}/index.dic`);
      const license = readFileSync(resolve(`src-tauri/resources/dictionaries/${code}/LICENSE.txt`), 'utf8');
      expect(license, code).toMatch(/https:\/\//);
    }
    expect(targets).toContain('dictionaries/');
  });
});
