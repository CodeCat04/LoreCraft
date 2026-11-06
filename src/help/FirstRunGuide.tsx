/**
 * A short guide on first launch. It is a card in the corner rather than a dialog, so a
 * project can open and be used behind it. Help can bring it back.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';

import { t } from '../lib/i18n';
import type { Bootstrap } from '../lib/types';
import { getCommand } from '../shell/commands';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { openSampleWorld } from './openSample';
import { withParts } from './parts';
import { shortcutText } from './shortcuts';

interface GuideStore {
  open: boolean;
  step: number;
  /** Reopened on request, so it takes the keyboard. On first launch it leaves it alone. */
  takeFocus: boolean;
  show: (takeFocus: boolean) => void;
  hide: () => void;
  goTo: (step: number) => void;
}

const useGuide = create<GuideStore>((set) => ({
  open: false,
  step: 0,
  takeFocus: false,
  show: (takeFocus) => set({ open: true, step: 0, takeFocus }),
  hide: () => set({ open: false }),
  goTo: (step) => set({ step, takeFocus: true }),
}));

export function reopenGuide() {
  useGuide.getState().show(true);
}

/** Shows the guide if this person has never seen it. Test runs skip it unless they ask. */
export function startFirstRunGuide(boot: Pick<Bootstrap, 'e2e' | 'e2eGuide'>) {
  if (boot.e2e && !boot.e2eGuide) return;
  const settings = useSettings.getState();
  if (settings.settings.help.guideSeen) return;
  useGuide.getState().show(false);
  void settings.update({ help: { guideSeen: true } }).catch(() => {});
}

function Shortcut({ command, fallback }: { command: string; fallback: string }) {
  return <kbd>{shortcutText(getCommand(command)?.shortcut ?? fallback)}</kbd>;
}

interface Step {
  title: string;
  body: ReactNode;
}

/** Built on each render, so the steps read in the interface language. */
function steps(): Step[] {
  return [
    {
      title: t('The wiki holds your world'),
      body: withParts(
        t(
          'Press {newPage} in a project to add a page, and type {link} to link to another. A red link is a page you have not written yet. Click it to create the page.',
        ),
        { newPage: <Shortcut command="wiki.newPage" fallback="Ctrl+N" />, link: <kbd>[[</kbd> },
      ),
    },
    {
      title: t('Write holds your books'),
      body: t(
        'The Write tab has your books, chapters and scenes. Hold the pointer over a name in a scene to see what the wiki says about it.',
      ),
    },
    {
      title: t('AI help is optional'),
      body: withParts(
        t(
          'Press {aiPane} for the AI pane, and connect a model under Settings, AI: a local server, Anthropic or OpenAI. It suggests changes, and you accept or reject each one.',
        ),
        { aiPane: <Shortcut command="ai.togglePane" fallback="Ctrl+Shift+A" /> },
      ),
    },
    {
      title: t('Your work is kept safe'),
      body: withParts(
        t(
          'Every edit goes to a recovery copy straight away, so a crash does not lose it. Press {save} to save to your file. Each save keeps a backup of the last version, under File, Backups.',
        ),
        { save: <Shortcut command="file.save" fallback="Ctrl+S" /> },
      ),
    },
    {
      title: t('See how it all fits together'),
      body: withParts(
        t(
          'The sample world is a small, finished project to explore. Press {shortcuts} at any time for the list of shortcuts. You can see this guide again from the Help menu.',
        ),
        { shortcuts: <Shortcut command="help.shortcuts" fallback="F1" /> },
      ),
    },
  ];
}

export function FirstRunGuide() {
  useLocale();
  const { open, step, takeFocus, hide, goTo } = useGuide();
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && takeFocus) nextRef.current?.focus();
  }, [open, step, takeFocus]);

  if (!open) return null;
  const STEPS = steps();
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hide();
    }
  };

  return (
    <aside
      className="guide-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby="guide-title"
      data-testid="first-run-guide"
      onKeyDown={onKeyDown}
    >
      <div className="guide-head">
        <span className="guide-step muted small">{t('Step {step} of {total}', { step: step + 1, total: STEPS.length })}</span>
        <button type="button" className="icon-btn" aria-label={t('Close the guide')} title={t('Close the guide')} onClick={hide}>
          ×
        </button>
      </div>
      <h2 id="guide-title" className="guide-title">{current.title}</h2>
      <p className="guide-body">{current.body}</p>
      <div className="guide-actions">
        {last && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              hide();
              void openSampleWorld();
            }}
          >
            {t('Open sample world')}
          </button>
        )}
        <span className="guide-spacer" />
        {step > 0 && (
          <button type="button" className="btn" onClick={() => goTo(step - 1)}>
            {t('Back')}
          </button>
        )}
        {last ? (
          <button ref={nextRef} type="button" className="btn btn-primary" onClick={hide}>
            {t('Done')}
          </button>
        ) : (
          <button ref={nextRef} type="button" className="btn btn-primary" onClick={() => goTo(step + 1)}>
            {t('Next')}
          </button>
        )}
      </div>
    </aside>
  );
}
