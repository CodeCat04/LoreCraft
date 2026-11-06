/** The collapsible Contents box, generated from an article's headings. */

import { useState } from 'react';

import type { OutlineHeading } from './outline';
import { loadPref, savePref } from './session';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

/** Fewer headings than this do not need a table of contents. */
export const MIN_HEADINGS_FOR_CONTENTS = 2;

export function ContentsBox(props: { headings: OutlineHeading[]; onJump: (index: number) => void }) {
  useLocale();
  const [collapsed, setCollapsed] = useState(() => loadPref('contentsCollapsed', false));
  if (props.headings.length < MIN_HEADINGS_FOR_CONTENTS) return null;
  return (
    <nav className="wiki-contents" aria-label={t('Contents')}>
      <div className="wiki-contents-head">
        <span className="wiki-contents-title">{t('Contents')}</span>
        <button
          type="button"
          className="link-button wiki-contents-toggle"
          aria-expanded={!collapsed}
          onClick={() => {
            savePref('contentsCollapsed', !collapsed);
            setCollapsed(!collapsed);
          }}
        >
          {collapsed ? t('Show') : t('Hide')}
        </button>
      </div>
      {!collapsed && (
        <ol className="wiki-contents-list">
          {props.headings.map((heading) => (
            <li key={heading.index} style={{ marginLeft: `${(heading.level - 1) * 1}em` }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  props.onJump(heading.index);
                }}
              >
                <span className="wiki-contents-number">{heading.number}</span>
                <span>{heading.text || t('Untitled section')}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
