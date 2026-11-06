/** Kept apart from the document builder so the print page does not load it. */
export const ASSET_URL_PREFIX = '#asset/';

/**
 * Running heads are counter styles of the page number, one pair per chapter, so the print
 * page can leave the head off the page a chapter opens on. The engine cannot pick out the
 * first page of a named page with a selector. A chapter's element names its pair in this
 * attribute, as `running-<n>`.
 */
export const RUNNING_HEAD_ATTRIBUTE = 'data-running-head';

/** The counter style a head falls back to on a chapter's first page. It writes nothing. */
export const NO_HEAD_STYLE = 'lorecraft-no-head';

/** The pair of counter styles that write one chapter's heads, on left and right pages. */
export function headStyles(page: string): { left: string; right: string } {
  return { left: `${page}-left`, right: `${page}-right` };
}

/** What those styles start from: the words alone, on every page. */
export function headWords(page: string): { left: string; right: string } {
  return { left: `${page}-book`, right: `${page}-chapter` };
}
