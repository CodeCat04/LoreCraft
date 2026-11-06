/** The six preset colors, stored as "1" to "6" as JSON Canvas says, drawn from theme tokens. */

import { t } from '../lib/i18n';
import { cleanColor } from './model';

export const PRESETS = ['1', '2', '3', '4', '5', '6'] as const;

export function presetName(preset: string): string {
  switch (preset) {
    case '1':
      return t('Red');
    case '2':
      return t('Orange');
    case '3':
      return t('Yellow');
    case '4':
      return t('Green');
    case '5':
      return t('Cyan');
    default:
      return t('Purple');
  }
}

/** The CSS for a stored color: a theme token for a preset, the hex itself otherwise. */
export function colorVar(color: string | undefined): string | null {
  const clean = cleanColor(color);
  if (!clean) return null;
  return /^[1-6]$/.test(clean) ? `var(--canvas-color-${clean})` : clean;
}
