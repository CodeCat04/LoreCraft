/** Choose scenes, and the AI drafts a style describing the writer's own voice. */

import { useEffect, useRef, useState } from 'react';

import * as api from '../lib/api';
import { profileForTask, providerLabel } from '../ai/client';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useProject } from '../state/project';
import type { NodeMeta } from '../lib/types';
import { draftStyleFromScenes } from './fromWriting';
import { goToTab, useStylesUi } from './uiStore';

interface BookScenes {
  id: string;
  title: string;
  scenes: NodeMeta[];
}

async function loadScenes(): Promise<BookScenes[]> {
  const books = await api.books.list();
  return Promise.all(
    books.map(async (book) => {
      const tree = await api.nodes.tree(book.id);
      return { id: book.id, title: book.title, scenes: tree.filter((node) => node.kind === 'scene' && node.wordCount > 0) };
    }),
  );
}

function sceneWords(count: number, held: boolean): string {
  if (count === 1) return held ? t('1 word, local only') : t('1 word');
  const shown = formatNumber(count);
  return held ? t('{count} words, local only', { count: shown }) : t('{count} words', { count: shown });
}

function chosenWords(count: number, cloud: boolean, provider: string): string {
  const shown = formatNumber(count);
  if (cloud) {
    return count === 1
      ? t('1 word chosen. Sent to {provider}.', { provider })
      : t('{count} words chosen. Sent to {provider}.', { count: shown, provider });
  }
  return count === 1 ? t('1 word chosen. Stays on this computer.') : t('{count} words chosen. Stays on this computer.', { count: shown });
}

export function BuildTab() {
  useLocale();
  const isOpen = useProject((s) => s.status.open);
  const version = useDataVersion('nodes', 'nodeContent', 'books');
  const { data: books, loading } = useLoad(() => (isOpen ? loadScenes() : Promise.resolve([])), [isOpen, version]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const stopper = useRef<AbortController | null>(null);
  const set = useStylesUi((s) => s.set);
  const profile = profileForTask('extract');

  // Stop waiting for a model that nobody is waiting on any more.
  useEffect(() => () => stopper.current?.abort(), []);

  if (!isOpen) {
    return (
      <div className="styles-empty">
        <p>{t('This reads your scenes, so it needs a project.')}</p>
        <p className="muted">{t('Open or create a project, write a scene or two, and come back.')}</p>
      </div>
    );
  }

  const allScenes = (books ?? []).flatMap((book) => book.scenes);
  const words = allScenes.filter((scene) => chosen.has(scene.id)).reduce((sum, scene) => sum + scene.wordCount, 0);

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const draft = async () => {
    const controller = new AbortController();
    stopper.current = controller;
    setRunning(true);
    try {
      const style = await draftStyleFromScenes([...chosen], controller.signal);
      set({ editing: style });
      goToTab('mine');
    } catch (e) {
      if (!controller.signal.aborted) toast(t('Could not draft a style: {reason}', { reason: errorMessage(e) }), 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="styles-scroll">
      <div className="styles-narrow">
        <p className="muted styles-intro">
          {t('Choose scenes that sound the way you want to sound. The AI describes your voice in the same form as every style here, and you review and edit the draft before anything is saved.')}
        </p>
        {!loading && allScenes.length === 0 && (
          <div className="styles-empty">
            <p>{t('There are no scenes with text in them yet.')}</p>
            <p className="muted">{t('Write a scene in the Write area, and it appears here.')}</p>
          </div>
        )}
        {(books ?? []).filter((book) => book.scenes.length > 0).map((book) => (
          <fieldset key={book.id} className="settings-group styles-build-book">
            <legend className="field-label">{book.title}</legend>
            {book.scenes.map((scene) => {
              // A scene marked local only cannot go to a cloud profile.
              const held = profile.isCloud && !!scene.localOnly;
              return (
                <label key={scene.id} className="checkbox">
                  <input type="checkbox" disabled={held} checked={chosen.has(scene.id) && !held} onChange={() => toggle(scene.id)} />
                  <span>
                    {scene.title} <span className="faint small">{sceneWords(scene.wordCount, held)}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
        {allScenes.length > 0 && (
          <div className="styles-actions">
            <button type="button" className="btn btn-primary" disabled={chosen.size === 0 || running} onClick={() => void draft()}>
              {running ? t('Reading your scenes…') : t('Draft a style from these scenes')}
            </button>
            {running && <button type="button" className="btn" onClick={() => stopper.current?.abort()}>{t('Stop')}</button>}
            <span className="faint small">
              {chosen.size === 0 ? t('Choose at least one scene.') : chosenWords(words, profile.isCloud, providerLabel(profile))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
