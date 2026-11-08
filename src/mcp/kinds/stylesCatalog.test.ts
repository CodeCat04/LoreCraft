/**
 * The MCP server is written in Rust and cannot run the style library's code, so it reads a
 * copy of the built-in styles from `src-tauri/src/mcp/areas/styles_library.json`. This test
 * fails when that copy is out of date. To write it again:
 *
 *   UPDATE_STYLE_CATALOG=1 npx vitest run src/mcp/kinds/stylesCatalog.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LIBRARY } from '../../writingStyles/library';
import { buildStylePrompt } from '../../writingStyles/prompt';

const FILE = join(__dirname, '../../../src-tauri/src/mcp/areas/styles_library.json');

function catalog(): string {
  const styles = LIBRARY.map((style) => ({
    id: style.id,
    name: style.name,
    kind: style.kind,
    genres: style.genres,
    summary: style.summary,
    prompt: buildStylePrompt(style),
  }));
  return `${JSON.stringify(styles, null, 1)}\n`;
}

describe('the built-in style catalog for the MCP server', () => {
  it('matches the style library', () => {
    const wanted = catalog();
    if (process.env.UPDATE_STYLE_CATALOG) writeFileSync(FILE, wanted);
    expect(readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(wanted);
  });
});
