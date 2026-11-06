/** The full-size picture viewer, for Read mode. Escape, or a click anywhere, closes it. */

import { t } from '../../lib/i18n';

let closeCurrent: (() => void) | null = null;

export function openImageViewer(src: string, label: string, alt: string) {
  closeCurrent?.();
  const previous = document.activeElement as HTMLElement | null;

  const overlay = document.createElement('div');
  overlay.className = 'media-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', label || t('Full size picture'));

  const image = document.createElement('img');
  image.src = src;
  image.alt = alt || label;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn media-viewer-close';
  close.textContent = t('Close');

  overlay.append(image, close);
  if (label) {
    const caption = document.createElement('p');
    caption.className = 'media-viewer-label';
    caption.textContent = label;
    overlay.append(caption);
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish();
    } else if (event.key === 'Tab') {
      // The close button is the only stop, so focus stays here.
      event.preventDefault();
    }
  };
  const finish = () => {
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
    closeCurrent = null;
    previous?.focus?.();
  };
  overlay.addEventListener('click', finish);
  window.addEventListener('keydown', onKey, true);
  closeCurrent = finish;

  document.body.append(overlay);
  close.focus();
}
