/** What native file dialogs offer when choosing media. */

import { t } from '../lib/i18n';

const PICTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'];
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg'];
const SOUND_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'];
const PDF_EXTENSIONS = ['pdf'];

/** A filter list whose name is read when a dialog opens, so it is in the current language. */
function filterList(name: () => string, extensions: string[]) {
  const filter = {
    get name() {
      return name();
    },
    extensions,
  };
  return [filter];
}

export const PICTURE_FILTERS = filterList(() => t('Pictures'), PICTURE_EXTENSIONS);
export const VIDEO_FILTERS = filterList(() => t('Videos'), VIDEO_EXTENSIONS);
export const SOUND_FILTERS = filterList(() => t('Sound files'), SOUND_EXTENSIONS);
export const PDF_FILTERS = filterList(() => t('PDF files'), PDF_EXTENSIONS);
/** Everything a canvas card can show. */
export const CARD_FILTERS = [
  ...filterList(() => t('All supported files'), [...new Set([...PICTURE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...SOUND_EXTENSIONS, ...PDF_EXTENSIONS])]),
  ...PICTURE_FILTERS, ...VIDEO_FILTERS, ...SOUND_FILTERS, ...PDF_FILTERS];
