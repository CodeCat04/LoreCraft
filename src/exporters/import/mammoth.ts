/** The one place `mammoth` is used. */

import { MAMMOTH_STYLE_MAP } from './docxStyles';

export async function docxBytesToHtml(data: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth');
  const convert = mammoth.convertToHtml ?? mammoth.default.convertToHtml;
  // Node's build reads a Buffer and the browser's an ArrayBuffer. Only tests are on Node.
  const source = typeof Buffer !== 'undefined' ? { buffer: Buffer.from(data) } : { arrayBuffer: data };
  const result = await convert(source, { styleMap: MAMMOTH_STYLE_MAP, includeDefaultStyleMap: true });
  return result.value;
}
