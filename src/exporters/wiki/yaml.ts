/**
 * YAML: the same structure as the JSON export. Documents are Markdown by default so that
 * a person can read the file. Set `bodyFormat` to `prosemirror` to lose nothing.
 */

import { stringify } from 'yaml';

import { pmToMarkdown } from '../../editor/convert';
import type { ExportInput } from '../types';
import { utf8 } from '../util';
import { buildLorebookFile } from './lorebookFile';

export function exportYaml(input: ExportInput): Uint8Array {
  const file = input.options.bodyFormat === 'prosemirror'
    ? buildLorebookFile(input)
    : buildLorebookFile(input, pmToMarkdown);
  // Repeated values are written out, because anchors and aliases are hard to read and
  // some YAML readers refuse them.
  return utf8(stringify(file, { aliasDuplicateObjects: false, lineWidth: 0 }));
}
