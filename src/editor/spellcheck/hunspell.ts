/**
 * Reads Hunspell dictionaries and checks words against them. It keeps the word stems and the
 * affix rules as they are, and works out whether a word is valid when asked, as Hunspell
 * itself does. `nspell` expands every word into all its forms first, which takes a third of
 * a gigabyte for French and does not finish in useful time for Italian or Portuguese.
 *
 * It covers what the bundled dictionaries use: flag formats and aliases, prefixes and
 * suffixes with cross products, two suffixes in a row, circumfixes, words that need an affix
 * or only occur in compounds, forbidden words, German-style compounds, and input conversion.
 */

import type { SpellBackend } from './engine';

type FlagSet = ReadonlySet<string>;

interface AffixRule {
  flag: string;
  strip: string;
  add: string;
  /** Tested against the stem, with what the rule strips still on it. */
  condition: RegExp | null;
  continuation: FlagSet;
  cross: boolean;
}

const NO_FLAGS: FlagSet = new Set<string>();
const NO_ENTRIES: readonly FlagSet[] = [];
/** A word beyond this cannot be checked as a compound in useful time, or is not one. */
const MAX_COMPOUND_LENGTH = 64;
const MAX_COMPOUND_PARTS = 5;
/** Plenty for the caller to rank and cut down, as this finds them in no useful order. */
const MAX_SUGGESTIONS = 100;
/** Words longer than this get only the cheapest kinds of suggestion. */
const MAX_SUGGEST_LENGTH = 40;

function capitalized(word: string): string {
  const first = String.fromCodePoint(word.codePointAt(0) as number);
  return first.toUpperCase() + word.slice(first.length);
}

/** A replacement rule writes a space as `_`. */
function unescapeRep(text: string): string {
  return text.replace(/_/g, ' ');
}

export class Hunspell implements SpellBackend {
  private flagMode = 'char';
  private aliases: FlagSet[] = [];
  private flagCache = new Map<string, FlagSet>();
  private words = new Map<string, readonly FlagSet[]>();
  private prefixes = new Map<string, AffixRule[]>();
  private suffixes = new Map<string, AffixRule[]>();
  /** Suffixes that another suffix can follow, by the flag of that other suffix. */
  private continuedBy = new Map<string, AffixRule[]>();
  private longestPrefix = 0;
  private crossFlags = new Map<string, boolean>();
  private conditions = new Map<string, RegExp | null>();
  private iconv: [string, string][] = [];
  private rep: [string, string][] = [];
  private ignore = '';
  private tryChars = '';
  private forbidden: string | null = null;
  private needAffix: string | null = null;
  private onlyInCompound: string | null = null;
  private circumfix: string | null = null;
  private noSuggest: string | null = null;
  private compoundFlag: string | null = null;
  private compoundBegin: string | null = null;
  private compoundMiddle: string | null = null;
  private compoundEnd: string | null = null;
  private compoundPermit: string | null = null;
  private compoundMin = 3;

  constructor({ aff, dic }: { aff: string; dic: string }) {
    this.parseAffixes(aff);
    this.parseWords(dic);
  }

  // ---- Reading ---------------------------------------------------------------------

  private parseFlags(text: string): FlagSet {
    const cached = this.flagCache.get(text);
    if (cached) return cached;
    let flags: FlagSet;
    if (this.aliases.length > 0 && /^\d+$/.test(text)) {
      flags = this.aliases[Number(text) - 1] ?? NO_FLAGS;
    } else {
      flags = new Set(this.splitFlags(text));
    }
    this.flagCache.set(text, flags);
    return flags;
  }

  private splitFlags(text: string): string[] {
    if (this.flagMode === 'long') {
      const out: string[] = [];
      for (let i = 0; i < text.length; i += 2) out.push(text.slice(i, i + 2));
      return out;
    }
    if (this.flagMode === 'num') return text.split(',').filter(Boolean);
    return [...text];
  }

  private singleFlag(text: string | undefined): string | null {
    return text ? (this.splitFlags(text)[0] ?? null) : null;
  }

  private condition(text: string, atEnd: boolean): RegExp | null {
    if (text === '.' || text === '') return null;
    const key = `${atEnd ? 'S' : 'P'}${text}`;
    if (this.conditions.has(key)) return this.conditions.get(key) ?? null;
    let compiled: RegExp | null = null;
    try {
      compiled = new RegExp(atEnd ? `(?:${text})$` : `^(?:${text})`, 'u');
    } catch {
      compiled = null;
    }
    this.conditions.set(key, compiled);
    return compiled;
  }

  private parseAffixes(aff: string) {
    const rules: { atEnd: boolean; parts: string[] }[] = [];
    let aliasCountRead = false;
    for (const raw of aff.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      const name = parts[0];
      const value = parts[1];
      switch (name) {
        case 'FLAG':
          // `UTF-8` and the default both mean one character per flag.
          this.flagMode = value === 'long' || value === 'num' ? value : 'char';
          break;
        case 'AF':
          // The first line only says how many there are.
          if (aliasCountRead) this.aliases.push(new Set(this.splitFlags(value ?? '')));
          aliasCountRead = true;
          break;
        case 'TRY':
          this.tryChars = value ?? '';
          break;
        case 'IGNORE':
          this.ignore = value ?? '';
          break;
        case 'ICONV':
          if (parts.length >= 3) this.iconv.push([value, parts[2]]);
          break;
        case 'REP':
          if (parts.length >= 3) this.rep.push([unescapeRep(value), unescapeRep(parts[2])]);
          break;
        case 'FORBIDDENWORD':
          this.forbidden = this.singleFlag(value);
          break;
        case 'NEEDAFFIX':
        case 'PSEUDOROOT':
          this.needAffix = this.singleFlag(value);
          break;
        case 'ONLYINCOMPOUND':
          this.onlyInCompound = this.singleFlag(value);
          break;
        case 'CIRCUMFIX':
          this.circumfix = this.singleFlag(value);
          break;
        case 'NOSUGGEST':
          this.noSuggest = this.singleFlag(value);
          break;
        case 'COMPOUNDFLAG':
          this.compoundFlag = this.singleFlag(value);
          break;
        case 'COMPOUNDBEGIN':
          this.compoundBegin = this.singleFlag(value);
          break;
        case 'COMPOUNDMIDDLE':
          this.compoundMiddle = this.singleFlag(value);
          break;
        case 'COMPOUNDEND':
          this.compoundEnd = this.singleFlag(value);
          break;
        case 'COMPOUNDPERMITFLAG':
          this.compoundPermit = this.singleFlag(value);
          break;
        case 'COMPOUNDMIN':
          this.compoundMin = Math.max(1, Number(value) || 3);
          break;
        case 'PFX':
        case 'SFX':
          // Flags may be declared after the rules that use them, so these wait.
          rules.push({ atEnd: name === 'SFX', parts });
          break;
        default:
          break;
      }
    }
    for (const { atEnd, parts } of rules) this.addRule(atEnd, parts);
  }

  private addRule(atEnd: boolean, parts: string[]) {
    const flag = this.singleFlag(parts[1]);
    if (!flag) return;
    if (parts.length === 4 && (parts[2] === 'Y' || parts[2] === 'N')) {
      this.crossFlags.set(`${atEnd ? 'S' : 'P'}${flag}`, parts[2] === 'Y');
      return;
    }
    if (parts.length < 4) return;
    const slash = parts[3].indexOf('/');
    const addText = slash < 0 ? parts[3] : parts[3].slice(0, slash);
    const rule: AffixRule = {
      flag,
      strip: parts[2] === '0' ? '' : parts[2],
      add: addText === '0' ? '' : addText,
      condition: this.condition(parts[4] ?? '.', atEnd),
      continuation: slash < 0 ? NO_FLAGS : this.parseFlags(parts[3].slice(slash + 1)),
      cross: this.crossFlags.get(`${atEnd ? 'S' : 'P'}${flag}`) ?? false,
    };
    const table = atEnd ? this.suffixes : this.prefixes;
    const list = table.get(rule.add);
    if (list) list.push(rule);
    else table.set(rule.add, [rule]);
    if (!atEnd) this.longestPrefix = Math.max(this.longestPrefix, rule.add.length);
    if (atEnd) {
      for (const next of rule.continuation) {
        const others = this.continuedBy.get(next);
        if (others) others.push(rule);
        else this.continuedBy.set(next, [rule]);
      }
    }
  }

  private parseWords(dic: string) {
    // One shared list per set of flags, as most words are spelled only once.
    const lists = new Map<FlagSet, readonly FlagSet[]>();
    const lines = dic.split(/\r?\n/);
    for (let i = 1; i < lines.length; i += 1) {
      let line = lines[i];
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab >= 0) line = line.slice(0, tab);
      const space = line.indexOf(' ');
      if (space >= 0 && line.indexOf(':', space) > 0) line = line.slice(0, space);
      const slash = line.indexOf('/');
      const word = this.withoutIgnored((slash < 0 ? line : line.slice(0, slash)).trim());
      if (!word) continue;
      const flags = slash < 0 ? NO_FLAGS : this.parseFlags(line.slice(slash + 1).trim());
      const existing = this.words.get(word);
      if (existing) {
        this.words.set(word, [...existing, flags]);
      } else {
        let list = lists.get(flags);
        if (!list) {
          list = [flags];
          lists.set(flags, list);
        }
        this.words.set(word, list);
      }
    }
  }

  private withoutIgnored(word: string): string {
    if (!this.ignore) return word;
    let out = word;
    for (const char of this.ignore) out = out.split(char).join('');
    return out;
  }

  private converted(word: string): string {
    let out = word;
    for (const [from, to] of this.iconv) {
      if (out.includes(from)) out = out.split(from).join(to);
    }
    return this.withoutIgnored(out);
  }

  // ---- Checking --------------------------------------------------------------------

  private entries(word: string): readonly FlagSet[] {
    return this.words.get(word) ?? NO_ENTRIES;
  }

  private has(flags: FlagSet, flag: string | null): boolean {
    return flag !== null && flags.has(flag);
  }

  /** A stem with this flag, and the second flag if given. */
  private stemHas(word: string, flag: string, also: string | null): boolean {
    for (const flags of this.entries(word)) {
      if (this.has(flags, this.forbidden)) continue;
      if (flags.has(flag) && (also === null || flags.has(also))) return true;
    }
    return false;
  }

  /** A rule can end a word on its own unless it marks itself as needing something more. */
  private canFinish(rule: AffixRule): boolean {
    return !this.has(rule.continuation, this.needAffix) && !this.has(rule.continuation, this.onlyInCompound);
  }

  private ruleApplies(rule: AffixRule, stem: string): boolean {
    return stem.length > 0 && (rule.condition === null || rule.condition.test(stem));
  }

  /** The word is a stem plus one or two suffixes, and the prefix if one was already removed. */
  private hasSuffixes(word: string, prefix: AffixRule | null): boolean {
    // Down to nothing left of the word, since a rule can replace all of a stem: être, est.
    for (let i = word.length; i >= 0; i -= 1) {
      const rules = this.suffixes.get(i === word.length ? '' : word.slice(i));
      if (!rules) continue;
      const head = word.slice(0, i);
      for (const rule of rules) {
        const stem = head + rule.strip;
        if (!this.ruleApplies(rule, stem)) continue;
        const circumfix = this.has(rule.continuation, this.circumfix);
        if (circumfix !== (prefix !== null && this.has(prefix.continuation, this.circumfix))) continue;
        if (!prefix) {
          if (!this.canFinish(rule)) continue;
          if (this.stemHas(stem, rule.flag, null)) return true;
          if (this.continuedBy.has(rule.flag) && this.hasInnerSuffix(stem, rule.flag)) return true;
        } else if (rule.continuation.has(prefix.flag)) {
          // French gives its elisions this way: the suffix says which prefixes can join it.
          if (this.stemHas(stem, rule.flag, null)) return true;
        } else if (rule.cross && prefix.cross && this.stemHas(stem, rule.flag, prefix.flag)) {
          return true;
        }
      }
    }
    return false;
  }

  /** The word is a stem plus a suffix that the given suffix's flag may follow. */
  private hasInnerSuffix(word: string, outerFlag: string): boolean {
    const inner = this.continuedBy.get(outerFlag);
    if (!inner) return false;
    for (const rule of inner) {
      if (!word.endsWith(rule.add)) continue;
      const stem = word.slice(0, word.length - rule.add.length) + rule.strip;
      if (this.ruleApplies(rule, stem) && this.stemHas(stem, rule.flag, null)) return true;
    }
    return false;
  }

  private hasPrefix(word: string): boolean {
    const longest = Math.min(this.longestPrefix, word.length);
    for (let i = 0; i <= longest; i += 1) {
      const rules = this.prefixes.get(word.slice(0, i));
      if (!rules) continue;
      const rest = word.slice(i);
      for (const rule of rules) {
        const stem = rule.strip + rest;
        if (!this.ruleApplies(rule, stem)) continue;
        if (this.canFinish(rule) && !this.has(rule.continuation, this.circumfix) && this.stemHas(stem, rule.flag, null)) {
          return true;
        }
        if (this.hasSuffixes(stem, rule)) return true;
      }
    }
    return false;
  }

  /** Valid as it stands, in exactly this case. */
  private isForm(word: string): boolean {
    const entries = this.entries(word);
    for (const flags of entries) {
      if (this.has(flags, this.forbidden)) return false;
    }
    for (const flags of entries) {
      if (!this.has(flags, this.needAffix) && !this.has(flags, this.onlyInCompound)) return true;
    }
    return this.hasSuffixes(word, null) || this.hasPrefix(word);
  }

  private get canCompound(): boolean {
    return this.compoundFlag !== null || this.compoundBegin !== null;
  }

  /**
   * A word in this case can stand at this place in a compound. The last part can end like
   * any word, since its endings are the compound's: "Handschuhe" is Hand and Schuhe.
   */
  private isCompoundPart(word: string, place: string | null, last: boolean): boolean {
    const flags = [this.compoundFlag, place].filter((flag): flag is string => flag !== null);
    for (const entry of this.entries(word)) {
      if (this.has(entry, this.forbidden)) return false;
      if (flags.some((flag) => entry.has(flag))) return true;
    }
    // A suffix inside a compound, such as the plural or linking forms of German.
    for (let i = word.length; i >= 0; i -= 1) {
      const rules = this.suffixes.get(i === word.length ? '' : word.slice(i));
      if (!rules) continue;
      const head = word.slice(0, i);
      for (const rule of rules) {
        const stem = head + rule.strip;
        if (!this.ruleApplies(rule, stem)) continue;
        const permits = last || this.has(rule.continuation, this.compoundPermit);
        const marks = flags.some((flag) => rule.continuation.has(flag));
        if (!permits && !marks) continue;
        for (const entry of this.entries(stem)) {
          if (entry.has(rule.flag) && (marks || flags.some((flag) => entry.has(flag)))) return true;
        }
      }
    }
    return false;
  }

  private isCompound(word: string, parts: number): boolean {
    if (parts >= MAX_COMPOUND_PARTS) return false;
    const min = this.compoundMin;
    for (let i = min; i <= word.length - min; i += 1) {
      const head = word.slice(0, i);
      const place = parts === 0 ? this.compoundBegin : this.compoundMiddle;
      // A German noun begins a compound with a capital, and is written lower case after that.
      const fits =
        this.isCompoundPart(head, place, false) ||
        (parts > 0 && this.isCompoundPart(capitalized(head), place, false));
      if (!fits) continue;
      const rest = word.slice(i);
      const lastPart =
        this.isCompoundPart(rest, this.compoundEnd, true) || this.isCompoundPart(capitalized(rest), this.compoundEnd, true);
      if (lastPart || this.isCompound(rest, parts + 1)) return true;
    }
    return false;
  }

  private check(word: string, compounds: boolean): boolean {
    const lower = word.toLowerCase();
    const upper = word.toUpperCase();
    const forms = [word];
    if (word === upper && word !== lower) forms.push(capitalized(lower), lower);
    else if (word !== lower && word === capitalized(lower)) forms.push(lower);
    if (forms.some((form) => this.isForm(form))) return true;
    if (!compounds || !this.canCompound || word.length > MAX_COMPOUND_LENGTH) return false;
    return forms.some((form) => this.isCompound(form, 0));
  }

  correct(word: string): boolean {
    return this.check(this.converted(word), true);
  }

  // ---- Suggesting ------------------------------------------------------------------

  /** Valid words one change from this one. The caller ranks them. */
  suggest(word: string): string[] {
    const found = new Set<string>();
    const base = this.converted(word).toLowerCase();
    const fits = (form: string) =>
      form !== word && this.check(form, false) && !this.entries(form).some((flags) => this.has(flags, this.noSuggest));
    const consider = (candidate: string) => {
      if (found.size >= MAX_SUGGESTIONS || !candidate) return;
      if (fits(candidate)) found.add(candidate);
      else if (fits(capitalized(candidate))) found.add(capitalized(candidate));
    };
    consider(base);
    for (const [from, to] of this.rep) {
      if (from.startsWith('^') || from.endsWith('$')) continue;
      let at = base.indexOf(from);
      while (at >= 0) {
        consider(base.slice(0, at) + to + base.slice(at + from.length));
        at = base.indexOf(from, at + 1);
      }
    }
    if (base.length > MAX_SUGGEST_LENGTH) return [...found];
    const chars = [...new Set([...this.tryChars.toLowerCase()])];
    const letters = [...base];
    for (let i = 0; i < letters.length; i += 1) {
      const head = letters.slice(0, i).join('');
      const tail = letters.slice(i + 1).join('');
      consider(head + tail);
      if (i + 1 < letters.length) consider(head + letters[i + 1] + letters[i] + letters.slice(i + 2).join(''));
      for (const char of chars) {
        if (char !== letters[i]) consider(head + char + tail);
        consider(head + char + letters[i] + tail);
      }
    }
    for (const char of chars) consider(base + char);
    return [...found];
  }
}
