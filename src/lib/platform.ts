/** What this platform can do, as the native side reported it at startup. */

import { t } from './i18n';
import type { Platform } from './types';

let current: Platform = { os: 'windows', pdf: true };

export function setPlatform(platform: Platform) {
  current = platform;
}

export function platform(): Platform {
  return current;
}

/** Always in English, and the key of its translation. Use `noPdfMessage()` for what people see. */
export const NO_PDF_MESSAGE = 'PDF export works on Windows and Linux. Word and EPUB exports work here.';

/** Shown wherever a PDF would otherwise be offered, in the interface language. */
export function noPdfMessage(): string {
  return t('PDF export works on Windows and Linux. Word and EPUB exports work here.');
}
