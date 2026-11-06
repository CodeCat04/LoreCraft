/** JSON: the whole project, nothing lost. It can be imported back. */

import type { ExportInput } from '../types';
import { utf8 } from '../util';
import { buildLorebookFile } from './lorebookFile';

export function exportJson(input: ExportInput): Uint8Array {
  return utf8(JSON.stringify(buildLorebookFile(input), null, 2));
}
