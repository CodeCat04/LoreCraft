import { Fragment, type ReactNode } from 'react';

/**
 * A translated sentence with elements inside it, such as a key in a `<kbd>`. The sentence
 * comes from `t()` with its `{placeholders}` left in, so a translation can put them anywhere,
 * and each placeholder named in `parts` becomes that element.
 */
export function withParts(sentence: string, parts: Record<string, ReactNode>): ReactNode {
  return sentence.split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={i}>{name !== undefined && name in parts ? parts[name] : piece}</Fragment>;
  });
}
