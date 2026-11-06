import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DialogHost } from '../shell/dialogs';
import { LICENSES_FILE, openAbout } from './dialogs';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/rpc', async (original) => ({
  ...(await original<typeof import('../lib/rpc')>()),
  rpc: rpcMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTICES = 'LoreCraft: third-party licenses\n\ndictionary-de 3.0.0\nLicense: (GPL-2.0 OR GPL-3.0)';

/** `npm run licenses:check` compares the whole file. This says what it must hold. */
describe('THIRD_PARTY_LICENSES.txt', () => {
  const notices = readFileSync(resolve(LICENSES_FILE), 'utf8').replace(/\r\n/g, '\n');
  const RULE = `\n${'-'.repeat(78)}\n`;
  /** One package's part: its heading, then its texts up to the next package's rule. */
  const entry = (name: string) => {
    const start = notices.indexOf(`\n${name} `);
    expect(start, name).toBeGreaterThan(0);
    const texts = notices.indexOf(RULE, notices.indexOf('\nSource: ', start)) + RULE.length;
    return notices.slice(start, notices.indexOf(RULE, texts));
  };

  it('lists every npm package the app is built from, at its version', () => {
    const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string; dev?: boolean; name?: string }>;
    };
    for (const [path, info] of Object.entries(lock.packages)) {
      if (!path || info.dev) continue;
      const name = info.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      expect(notices, name).toContain(`\n${name} ${info.version}\n`);
    }
  });

  it('gives the standard text where a crate has no license file', () => {
    expect(entry('webview2-com')).toContain('MIT (standard text; the package has no license file)');
    expect(entry('selectors')).toContain('MPL-2.0 (standard text; the package has no license file)');
    expect(entry('alloc-stdlib')).toContain('Redistribution and use in source and binary forms');
  });

  it('gives the GPL in full for the German dictionary, and the chosen license where there is a choice', () => {
    const german = entry('dictionary-de');
    expect(german).toContain('Version 2, June 1991');
    expect(german).toContain('Version 3, 29 June 2007');
    expect(german).toContain('https://www.j3e.de/ispell/igerman98/');
    expect(entry('dictionary-es')).toContain('LoreCraft uses it under MPL-1.1');
    expect(entry('dictionary-pt')).toContain('LoreCraft uses it under MPL-2.0');
    expect(entry('jszip')).toContain('LoreCraft uses it under MIT');
  });
});

describe('About', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation((method: string) => {
      if (method === 'app.info') return Promise.resolve({ version: '0.1.0', dataDir: 'C:\\data' });
      if (method === 'files.readResource') return Promise.resolve({ text: NOTICES });
      return Promise.reject(new Error(method));
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<DialogHost />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const flush = () => act(() => new Promise((done) => setTimeout(done, 0)));

  it('shows the third-party licenses that ship with the app', async () => {
    void act(() => void openAbout());
    await flush();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="about-licenses"]');
    expect(button?.textContent).toBe('Third-party licenses');
    act(() => button!.click());
    await flush();
    expect(rpcMock).toHaveBeenCalledWith('files.readResource', { name: LICENSES_FILE });
    const text = document.querySelector('[data-testid="licenses-text"]');
    expect(text?.textContent).toBe(NOTICES);
    expect(document.querySelector('[data-testid="licenses"] h2')?.textContent).toBe('Third-party licenses');
    // About closed on the way, so the two never stack.
    expect(document.querySelector('[data-testid="about-version"]')).toBeNull();
    await closeLicenses();
  });

  it('says when it runs portable, and where the data is', async () => {
    rpcMock.mockImplementation((method: string) =>
      method === 'app.info'
        ? Promise.resolve({ version: '0.1.0', dataDir: 'E:\\LoreCraft\\data', portable: true })
        : Promise.reject(new Error(method)),
    );
    void act(() => void openAbout());
    await flush();
    expect(document.querySelector('[data-testid="about-portable"]')?.textContent).toContain('Portable');
    expect(document.querySelector('[data-testid="about-data-dir"]')?.textContent).toBe('E:\\LoreCraft\\data');
  });

  it('says nothing about portable for an installed copy', async () => {
    void act(() => void openAbout());
    await flush();
    expect(document.querySelector('[data-testid="about-data-dir"]')?.textContent).toBe('C:\\data');
    expect(document.querySelector('[data-testid="about-portable"]')).toBeNull();
  });

  async function closeLicenses() {
    const close = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="licenses"] button')].find(
      (button) => button.textContent === 'Close',
    );
    act(() => close!.click());
    await flush();
    expect(document.querySelector('[data-testid="licenses"]')).toBeNull();
  }

  it('says what went wrong if the file is missing', async () => {
    rpcMock.mockImplementation((method: string) =>
      method === 'files.readResource'
        ? Promise.reject(new Error('THIRD_PARTY_LICENSES.txt is missing from this installation.'))
        : Promise.resolve({ version: '0.1.0', dataDir: '' }),
    );
    void act(() => void openAbout());
    await flush();
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="about-licenses"]')!.click());
    await flush();
    expect(document.querySelector('[data-testid="licenses-problem"]')?.textContent).toContain('missing from this installation');
    await closeLicenses();
  });
});
