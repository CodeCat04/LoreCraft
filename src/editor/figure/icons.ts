/** Small line icons for the figure toolbar. Drawn with `currentColor`, so themes apply. */

function svg(body: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
}

const LINES_LEFT = '<path d="M9.5 3.5H14M9.5 6.5H14M9.5 9.5H14M2 12.5H14"/>';
const LINES_RIGHT = '<path d="M2 3.5H6.5M2 6.5H6.5M2 9.5H6.5M2 12.5H14"/>';

export const ICONS = {
  /** A box on the left with text beside it. */
  wrapLeft: svg(`<rect x="2" y="3" width="5.5" height="6.5" rx="0.5"/>${LINES_LEFT}`),
  wrapRight: svg(`<rect x="8.5" y="3" width="5.5" height="6.5" rx="0.5"/>${LINES_RIGHT}`),
  center: svg('<path d="M2 2.5H14"/><rect x="4" y="5" width="8" height="6" rx="0.5"/><path d="M2 13.5H14"/>'),
  full: svg('<path d="M4 1.5H12"/><rect x="2" y="4" width="12" height="8" rx="0.5"/><path d="M4 14.5H12"/>'),
  describe: svg('<path d="M3 2.5H13A1 1 0 0 1 14 3.5V10A1 1 0 0 1 13 11H8L5 13.8V11H3A1 1 0 0 1 2 10V3.5A1 1 0 0 1 3 2.5Z"/><path d="M5 5.5H11M5 8H9"/>'),
  remove: svg('<path d="M2.5 4H13.5M6 4V2.5H10V4M4 4L4.7 13.5H11.3L12 4M6.8 6.5V11M9.2 6.5V11"/>'),
  grip: svg('<path d="M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01" stroke-width="2.2"/>'),
  addRow: svg('<rect x="2" y="2.5" width="12" height="6" rx="0.5"/><path d="M2 5.5H14M8 10.5V14.5M6 12.5H10"/>'),
  addColumn: svg('<rect x="2" y="2" width="6" height="12" rx="0.5"/><path d="M5 2V14M10.5 8H14.5M12.5 6V10"/>'),
  removeRow: svg('<rect x="2" y="2.5" width="12" height="6" rx="0.5"/><path d="M2 5.5H14M6 12.5H10"/>'),
  removeColumn: svg('<rect x="2" y="2" width="6" height="12" rx="0.5"/><path d="M5 2V14M10.5 8H14.5"/>'),
  picture: svg('<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1.1"/><path d="M2.5 12L6.5 8.5L9 10.5L11 9L13.5 11.5"/>'),
  video: svg('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M6.5 5.8V10.2L10.2 8Z"/>'),
  table: svg('<rect x="2" y="3" width="12" height="10" rx="0.5"/><path d="M2 6.5H14M2 9.8H14M6 3V13M10 3V13"/>'),
} as const;

export type IconName = keyof typeof ICONS;
