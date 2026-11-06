/** "Add scene…": a palette-style list of every scene, labeled with its book and chapter. */

import { useEffect, useRef, useState } from 'react';

import { t } from '../lib/i18n';
import { showDialog } from '../shell/dialogs';
import { wikiPages } from '../wiki/api';

export interface SceneOption {
  id: string;
  label: string;
}

/** The scenes whose label holds every word typed, in reading order. */
export function filterScenes(options: SceneOption[], query: string, limit = 50): SceneOption[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return options.filter((o) => words.every((w) => o.label.toLowerCase().includes(w))).slice(0, limit);
}

function ScenePicker({ options, close }: { options: SceneOption[]; close: (id: string | null) => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = filterScenes(options, query);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  return (
    <div className="palette canvas-scene-picker">
      <h2 id="dialog-title" className="visually-hidden">
        {t('Add scene')}
      </h2>
      <input
        role="combobox"
        aria-label={t('Search scenes')}
        aria-expanded={shown.length > 0}
        aria-controls="canvas-scene-list"
        aria-autocomplete="list"
        aria-activedescendant={shown[index] ? `canvas-scene-${index}` : undefined}
        className="palette-input"
        placeholder={t('Search scenes…')}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close(null);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (shown[index]) close(shown[index].id);
          }
        }}
      />
      <div className="palette-list" id="canvas-scene-list" ref={listRef} role="listbox" aria-label={t('Scenes')}>
        {shown.length === 0 && (
          <div className="palette-empty" role="status">
            {options.length ? t('Nothing matches.') : t('There are no scenes yet.')}
          </div>
        )}
        {shown.map((scene, i) => (
          <button
            key={scene.id}
            type="button"
            id={`canvas-scene-${i}`}
            tabIndex={-1}
            role="option"
            aria-selected={i === index}
            className={`palette-item${i === index ? ' is-selected' : ''}`}
            onClick={() => close(scene.id)}
          >
            <span>{scene.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Asks for a scene. Resolves to its id, or null. */
export async function pickScene(): Promise<string | null> {
  const options = await wikiPages.sceneOptions().catch(() => [] as SceneOption[]);
  return showDialog<string | null>((close) => <ScenePicker options={options} close={close} />, null);
}
