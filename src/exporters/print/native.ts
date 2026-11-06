/**
 * For engines that draw no @page margin boxes (WebKitGTK on Linux): what the print page
 * tells the native side so it can add the page numbers and running heads itself. See
 * src-tauri/src/rpc/print_stamp.rs.
 */

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The rules that put elements on a named page, as `.title-page { page: title-page }`. */
export function namedPageRules(css: string): { selector: string; name: string }[] {
  const rules: { selector: string; name: string }[] = [];
  for (const match of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector || selector.includes('@')) continue;
    const page = /(?:^|;)\s*page\s*:\s*([\w-]+)/.exec(match[2]);
    if (page && page[1] !== 'auto') rules.push({ selector, name: page[1] });
  }
  return rules;
}

/** The fonts the margin boxes are set in. */
export function marginBoxFonts(css: string): { family: string; italic: boolean; bold: boolean }[] {
  const fonts = new Map<string, { family: string; italic: boolean; bold: boolean }>();
  for (const match of withoutComments(css).matchAll(/@(?:top|bottom)-(?:left|center|right)\s*\{([^{}]*)\}/g)) {
    const family = /font-family\s*:\s*([^;]+)/.exec(match[1])?.[1]?.trim();
    if (!family) continue;
    const italic = /font-style\s*:\s*(italic|oblique)/.test(match[1]);
    const weight = /font-weight\s*:\s*(\w+)/.exec(match[1])?.[1] ?? '';
    const bold = weight === 'bold' || Number(weight) >= 600;
    fonts.set(JSON.stringify([family, italic, bold]), { family, italic, bold });
  }
  return [...fonts.values()];
}

/** Every letter the margin boxes could show: digits, and the words in the style sheet. */
export function glyphSampleText(css: string): string {
  const quoted = [...withoutComments(css).matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
    .map((match) => (match[1] ?? match[2]).replace(/\\(.)/g, '$1'))
    .join('');
  return [...new Set(`0123456789 /${quoted}`.replace(/\s/g, ''))].join('');
}

/**
 * The named page of each page, from where the start and end markers of each named element
 * fell. The elements come in document order, so an inner one overrides its parent.
 */
export function pageNamesFromMarkers(
  pages: number,
  placed: { name: string; start: string; end: string }[],
  markers: Record<string, number>,
): string[] {
  const names = Array.from({ length: pages }, () => '');
  for (const { name, start, end } of placed) {
    const first = markers[start];
    if (!first) continue;
    // An end marker sits a little above its element's end, so on a page-high sliver of an
    // element (a blank page) it can land before the start.
    const last = Math.min(Math.max(markers[end] ?? first, first), pages);
    for (let page = first; page <= last; page += 1) names[page - 1] = name;
  }
  return names;
}
