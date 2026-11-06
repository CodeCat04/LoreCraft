/** Keyboard shortcuts, About and Getting started. They work with or without a project open. */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { t } from '../lib/i18n';
import { rpc, errorMessage } from '../lib/rpc';
import * as api from '../lib/api';
import { allCommands, commandsVersion, getCommand, subscribeCommands } from '../shell/commands';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { shortcutGroups, shortcutText } from './shortcuts';
import { openSampleWorld } from './openSample';
import { withParts } from './parts';

export const GITHUB_URL = 'https://github.com/CodeCat04/LoreCraft';
const LICENSE = 'AGPL-3.0-only';

/** Pressing F1 twice must not stack two copies of the same screen. */
function single(render: (close: () => void) => ReactNode): () => Promise<void> {
  let open = false;
  return async () => {
    if (open) return;
    open = true;
    try {
      await showDialog<void>((close) => render(() => close()), undefined);
    } finally {
      open = false;
    }
  };
}

/** `takeFocus` starts the keyboard on Close, so that Enter does nothing surprising. */
function CloseRow({ close, takeFocus, children }: { close: () => void; takeFocus?: boolean; children?: ReactNode }) {
  useLocale();
  return (
    <div className="dialog-actions">
      {children}
      <button type="button" className="btn btn-primary" autoFocus={takeFocus} onClick={close}>
        {t('Close')}
      </button>
    </div>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="shortcut-keys">
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`}>{key}</kbd>
      ))}
    </span>
  );
}

function ShortcutsBody({ close }: { close: () => void }) {
  useLocale();
  useSyncExternalStore(subscribeCommands, commandsVersion);
  const [query, setQuery] = useState('');
  const groups = shortcutGroups(allCommands(), query);
  return (
    <div className="dialog-sheet dialog-sheet-steady" data-testid="shortcuts">
      <h2 id="dialog-title" className="dialog-title">{t('Keyboard shortcuts')}</h2>
      <input
        className="input"
        type="search"
        autoFocus
        placeholder={t('Search by name or key')}
        aria-label={t('Search shortcuts')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {/* Focusable so that the arrow keys can scroll it. */}
      <div className="shortcut-scroll" tabIndex={0} aria-label={t('Shortcuts')} role="group" data-testid="shortcut-scroll">
        {groups.length === 0 && <p className="muted shortcut-empty">{t('No shortcut matches that search.')}</p>}
        <div className="shortcut-columns">
          {groups.map((group) => (
            <section key={group.name} className="shortcut-group">
              <h3 className="shortcut-group-title">{group.name}</h3>
              <table className="shortcut-table">
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.title}</td>
                      <td className="shortcut-cell">
                        {row.shortcuts.map((keys) => (
                          <Keys key={keys.join('+')} keys={keys} />
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
      <CloseRow close={close} />
    </div>
  );
}

export const openShortcuts = single((close) => <ShortcutsBody close={close} />);

interface AppInfo {
  version: string;
  dataDir: string;
  portable?: boolean;
}

function AboutBody({ close }: { close: () => void }) {
  useLocale();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    rpc<AppInfo>('app.info')
      .then(setInfo)
      .catch((e) => toast(errorMessage(e), 'error'));
  }, []);
  const openSite = () => void api.app.openExternal(GITHUB_URL).catch((e) => toast(errorMessage(e), 'error'));
  return (
    <>
      <h2 id="dialog-title" className="dialog-title">{t('About LoreCraft')}</h2>
      <p className="dialog-message">
        {t(
          'A Wikipedia-style lorebook and a novel manuscript in one project file, with AI help from local or frontier models and checks that keep the two consistent.',
        )}
      </p>
      <dl className="about-facts">
        <dt>{t('Version')}</dt>
        <dd data-testid="about-version">{info?.version ?? ''}</dd>
        <dt>{t('License')}</dt>
        <dd>{LICENSE}</dd>
        {info?.portable && (
          <>
            <dt>{t('Edition')}</dt>
            <dd data-testid="about-portable">
              {t('Portable')}
              <span className="field-hint">{t('Everything is kept in the data folder beside lorecraft.exe.')}</span>
            </dd>
          </>
        )}
        <dt>{t('Data folder')}</dt>
        <dd>
          <span data-testid="about-data-dir" className="about-path">{info?.dataDir ?? ''}</span>
          <span className="field-hint">
            {t('Settings, backups and recovery copies are kept here. Your projects stay wherever you saved them.')}
          </span>
        </dd>
        <dt>{t('Source code')}</dt>
        <dd>
          <button type="button" className="link-button" onClick={openSite}>
            {GITHUB_URL.replace('https://', '')}
          </button>
        </dd>
      </dl>
      <CloseRow close={close} takeFocus>
        <button
          type="button"
          className="btn"
          data-testid="about-licenses"
          onClick={() => {
            close();
            void openLicenses();
          }}
        >
          {t('Third-party licenses')}
        </button>
      </CloseRow>
    </>
  );
}

export const openAbout = single((close) => <AboutBody close={close} />);

/** Made by scripts/licenses.mjs, and installed beside the app. See `files.readResource`. */
export const LICENSES_FILE = 'THIRD_PARTY_LICENSES.txt';

function LicensesBody({ close }: { close: () => void }) {
  useLocale();
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    rpc<{ text: string }>('files.readResource', { name: LICENSES_FILE })
      .then((result) => setText(result.text))
      .catch((e) => setProblem(errorMessage(e)));
  }, []);
  return (
    <div className="dialog-sheet dialog-sheet-steady" data-testid="licenses">
      <h2 id="dialog-title" className="dialog-title">{t('Third-party licenses')}</h2>
      <p className="dialog-message">
        {t('LoreCraft is built from open-source software, and ships with spelling dictionaries and fonts. Each keeps its own license, given here in full.')}
      </p>
      {problem ? (
        <p className="dialog-message" role="alert" data-testid="licenses-problem">{problem}</p>
      ) : (
        // Focusable so that the arrow keys can scroll it.
        <pre
          className="shortcut-scroll"
          tabIndex={0}
          aria-label={t('License texts')}
          data-testid="licenses-text"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.8125rem', margin: '0.75rem 0 0' }}
        >
          {text ?? t('Loading…')}
        </pre>
      )}
      <CloseRow close={close} takeFocus />
    </div>
  );
}

export const openLicenses = single((close) => <LicensesBody close={close} />);

/** The shortcut a command really has, so that this text cannot drift from the app. */
function Shortcut({ command, fallback }: { command: string; fallback: string }) {
  const shortcut = getCommand(command)?.shortcut ?? fallback;
  return <kbd>{shortcutText(shortcut)}</kbd>;
}

function GettingStartedBody({ close }: { close: () => void }) {
  useLocale();
  return (
    <div className="dialog-sheet help-page" data-testid="getting-started">
      <h2 id="dialog-title" className="dialog-title">{t('Getting started')}</h2>
      <div className="help-page-body">
        <p>
          {t(
            'A LoreCraft project is one file holding a wiki of your world and the books set in it. Your writing stays on this computer unless you connect a cloud AI.',
          )}
        </p>
        <h3>{t('Build the wiki')}</h3>
        <p>
          {withParts(
            t(
              'Press {newPage} to create a page. Pick a type, such as character or place, for a box of facts to fill in. Type {link} in any page to link to another. A link to a page that does not exist yet shows in red, and clicking it creates the page.',
            ),
            { newPage: <Shortcut command="wiki.newPage" fallback="Ctrl+N" />, link: <kbd>[[</kbd> },
          )}
        </p>
        <h3>{t('Write the book')}</h3>
        <p>
          {withParts(
            t(
              'Open {write} for your books, chapters and scenes. Press {newScene} for a new scene. Hold the pointer over a name in a scene to see what the wiki says about it, and press {focus} to hide everything but the page.',
            ),
            {
              write: <strong>{t('Write')}</strong>,
              newScene: <Shortcut command="write.newScene" fallback="Ctrl+Alt+N" />,
              focus: <Shortcut command="write.focus" fallback="F11" />,
            },
          )}
        </p>
        <h3>{t('Bring in an AI, if you like')}</h3>
        <p>
          {withParts(
            t(
              'Press {aiPane} for the AI pane, and connect a model under {settings}: a local server, Anthropic or OpenAI. Select text to ask for help with it. The AI suggests changes for you to accept or reject, and it never edits your text by itself.',
            ),
            {
              aiPane: <Shortcut command="ai.togglePane" fallback="Ctrl+Shift+A" />,
              settings: <strong>{t('Settings, AI')}</strong>,
            },
          )}
        </p>
        <h3>{t('Save your work')}</h3>
        <p>
          {withParts(
            t(
              'Every edit goes to a recovery copy straight away, so a crash does not lose it. Press {save} to save to your file. Each save keeps the previous version, and you can get back to it under {backups}.',
            ),
            {
              save: <Shortcut command="file.save" fallback="Ctrl+S" />,
              backups: <strong>{t('File, Backups')}</strong>,
            },
          )}
        </p>
        <h3>{t('See a finished example')}</h3>
        <p>
          {t(
            'The sample world is a small, complete project to explore, with a few mistakes planted for the consistency checker to find. Opening it does not touch your own work.',
          )}
        </p>
      </div>
      <CloseRow close={close} takeFocus>
        <button
          type="button"
          className="btn"
          onClick={() => {
            close();
            void openShortcuts();
          }}
        >
          {t('Keyboard shortcuts')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            close();
            void openSampleWorld();
          }}
        >
          {t('Open sample world')}
        </button>
      </CloseRow>
    </div>
  );
}

export const openGettingStarted = single((close) => <GettingStartedBody close={close} />);
