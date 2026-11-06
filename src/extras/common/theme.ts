/** Lets canvas drawing follow the CSS theme, which it cannot pick up by itself. */

/**
 * Resolves CSS custom properties to colors the canvas understands. Goes through a real
 * element, so tokens built with `var()` and `color-mix()` come back as final colors.
 */
export function resolveCssColors<T extends string>(tokens: readonly T[]): Record<T, string> {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const colors = {} as Record<T, string>;
  for (const token of tokens) {
    probe.style.color = `var(${token})`;
    colors[token] = getComputedStyle(probe).color;
  }
  probe.remove();
  return colors;
}

/** The current size of 1rem in CSS pixels. Follows the interface-size setting. */
export function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

export function uiFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
}

/**
 * Calls back when the theme, mode or interface size changes. All three live on the root
 * element, and watching it costs nothing while nothing changes.
 */
export function observeTheme(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-mode', 'style'],
  });
  return () => observer.disconnect();
}
