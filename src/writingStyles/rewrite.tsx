/** "Rewrite in a style…": the instruction for a selection, and the list to choose from. */

import { useEffect, useRef } from 'react';

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { StyleSearchList } from './StylePicker';
import { getStyle } from './store';

/**
 * What a rewrite asks for. The style itself travels as the request's `styleId`, so the model
 * reads it in the same <writing_style> block as always, with the writer's style guide.
 */
export function rewriteInstruction(styleId: string): { instruction: string; label: string } | null {
  const style = getStyle(styleId);
  if (!style) return null;
  return {
    label: t('In a style: {name}', { name: style.name }),
    instruction: `Rewrite this passage in the writing style you were given (${style.name}). Keep every event, fact and meaning the same, and change only how it is written.`,
  };
}

/** A small panel for choosing a style to rewrite in. Escape or a click away closes it. */
export function RewriteInStylePicker({ onChoose, onClose }: { onChoose: (styleId: string) => void; onClose: () => void }) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="style-rewrite-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <StyleSearchList
        autoFocus
        value={null}
        label={t('Rewrite in which style?')}
        onChoose={(id) => {
          if (id) onChoose(id);
        }}
      />
    </div>
  );
}
