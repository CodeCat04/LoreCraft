/**
 * Getting JSON out of a model's text. Local models in particular wrap it in prose or code
 * fences, leave trailing commas, or get cut off, so this is forgiving about what it reads.
 * Validation of what comes out is the caller's job.
 */

/**
 * Every balanced top-level `{...}` or `[...]` in the text, ignoring brackets inside
 * strings, plus whatever was left open when the text ended. Inner values are never
 * candidates, so a reply cut off mid-list is not mistaken for its first item.
 */
function scanBrackets(text: string): { closed: string[]; open: string | null } {
  const closed: string[] = [];
  let start = 0;
  while (start < text.length) {
    const offset = text.slice(start).search(/[{[]/);
    if (offset < 0) break;
    const from = start + offset;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let end = -1;
    let broken = false;
    for (let i = from; i < text.length; i += 1) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        const opener = stack.pop();
        if ((c === '}' && opener !== '{') || (c === ']' && opener !== '[')) {
          broken = true;
          break;
        }
        if (stack.length === 0) {
          end = i;
          break;
        }
      }
    }
    if (broken) {
      start = from + 1;
    } else if (end >= 0) {
      closed.push(text.slice(from, end + 1));
      start = end + 1;
    } else {
      return { closed, open: text.slice(from) };
    }
  }
  return { closed, open: null };
}

/** Removes `//` and `/* *\/` comments and trailing commas, leaving strings alone. */
function stripNoise(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else if (c === ',') {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] !== '}' && text[next] !== ']') out += c;
    } else {
      out += c;
    }
  }
  return out;
}

/** Straight quotes in place of curly ones used as JSON syntax. */
function straightenQuotes(text: string): string {
  return text.replace(/[“”]/g, '"');
}

/** Bare words as keys, and keys or strings in single quotes. Best effort. */
function quoteKeys(text: string): string {
  return text
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/([{,]\s*)'([^'\n]*)'(\s*:)/g, '$1"$2"$3')
    .replace(/(:\s*)'([^'\n]*)'(\s*[,}\]])/g, '$1"$2"$3');
}

/** Closes whatever a reply cut off by the token limit left open. */
function closeTruncated(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
    if (c === ',') lastSafe = i;
  }
  let body = text;
  if (inString) body += '"';
  const tryClose = (candidate: string, open: string[]) => candidate.trimEnd() + [...open].reverse().join('');
  const closed = tryClose(body.replace(/,\s*$/, '').replace(/:\s*$/, ': null'), stack);
  try {
    JSON.parse(closed);
    return closed;
  } catch {
    // A half-written key or value: cut back to the last complete item.
    if (lastSafe > 0) {
      const inner = text.slice(0, lastSafe);
      const again: string[] = [];
      let string = false;
      let esc = false;
      for (const c of inner) {
        if (string) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') string = false;
          continue;
        }
        if (c === '"') string = true;
        else if (c === '{' || c === '[') again.push(c === '{' ? '}' : ']');
        else if (c === '}' || c === ']') again.pop();
      }
      return tryClose(inner, again);
    }
    return closed;
  }
}

function tryParse(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

export interface ExtractedJson {
  value: unknown;
  /** True if the text needed fixing, not merely finding. */
  repaired: boolean;
}

/** Finds JSON in a model's reply. Returns null if there is none to be found. */
export function extractJson(reply: string): ExtractedJson | null {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const direct = tryParse(text);
  if (direct) return { value: direct.value, repaired: false };

  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json|JSON|jsonc)?\s*\n?([\s\S]*?)```/g)) {
    candidates.push(match[1].trim());
  }
  const { closed, open } = scanBrackets(text);
  candidates.push(...closed);

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed) return { value: parsed.value, repaired: false };
  }

  if (open) candidates.push(open);
  for (const candidate of candidates) {
    for (const fixed of [
      stripNoise(candidate),
      stripNoise(straightenQuotes(candidate)),
      quoteKeys(stripNoise(straightenQuotes(candidate))),
    ]) {
      const parsed = tryParse(fixed);
      if (parsed) return { value: parsed.value, repaired: true };
      const closed = tryParse(closeTruncated(fixed));
      if (closed) return { value: closed.value, repaired: true };
    }
  }
  return null;
}
