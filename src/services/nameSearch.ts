// Out of utils.ts since 2026-11-26.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Searching by name ignores accents ────────────────────────────────────────
// Irish titles carry fadas ("Ríl na Tulaí", "Sliabh Bána") that nobody types
// on a phone keyboard, and French names carry their own. NFD splits a letter
// from its accent, and the accent (a combining mark) is then dropped.
//
// A few letters are whole letters rather than letter + mark, so NFD leaves
// them as they are. Measured over every TheSession name and alias (41 247
// strings, 2026-09-17), the ones that occur are ø æ ł ǥ ı — mapped by hand
// below, along with œ and ß for French and German names. The rest of what
// that measure found is upside-down joke text (ǝ ʇ ᴉ ʍ), deliberately left.
//
// Only ever used to COMPARE: the folded string can be longer than the original
// (æ → ae), so no position found in it may be used to cut the original.
const UNDECOMPOSABLE: Record<string, string> = { æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', ǥ: 'g', ı: 'i', ß: 'ss' };

export function foldForSearch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[æœøłǥıß]/g, c => UNDECOMPOSABLE[c]!);
}

/** Substring search that ignores case and accents — "tulai" finds "Ríl na
 *  Tulaí". An empty query matches everything, as `includes('')` does. */
export function matchesSearch(text: string, query: string): boolean {
  return foldForSearch(text).includes(foldForSearch(query));
}

/** 0 (best) to 6 (no match), used by sortByRelevance to rank search results.
 *  Ranks are anchored on WHERE/HOW the query sits relative to word
 *  boundaries in `name` — a match at the very start beats one merely aligned
 *  to a word boundary further in, which in turn beats a match buried
 *  mid-word with no boundary alignment at all (e.g. querying "inch" against
 *  "The Mystery Inch" — whole word — should outrank "The Goldfinch" — the
 *  query is just a fragment of "finch" — even though neither starts with the
 *  query). \b is JS's built-in word-boundary regex anchor (transition
 *  between a \w character — letter/digit/underscore — and a non-\w one, or
 *  string start/end) — cheap and good enough here; it doesn't know about
 *  apostrophes as "part of a word" the way a linguist would, but that's an
 *  acceptable rough edge for tune-name search. Accents are no longer one:
 *  both sides are folded first, and \w does not count "í" as a letter, so
 *  without folding "Tulaí" held a word boundary in its middle. */
/** scoreMatch's fallback return value — no callsite should hardcode this
 *  number to test "did it match at all" (`< NO_SCORE_MATCH`); a past bug
 *  (commandPalette.ts hardcoding the OLD fallback value of 4 as its
 *  match/no-match cutoff) silently started dropping real matches the moment
 *  scoreMatch grew two more ranked tiers below the old ones, without any
 *  type error to catch it — the threshold and the fallback value were never
 *  actually tied together in the code, just coincidentally equal. */
export const NO_SCORE_MATCH = 6;

export function scoreMatch(name: string, query: string): number {
  return scoreFolded(foldForSearch(name), foldForSearch(query).trim());
}

/** scoreMatch on strings already folded — for a caller scoring one query
 *  against many names, which folds the query once. */
function scoreFolded(n: string, q: string): number {
  // Every tier below is a substring match, so a name without the query in it
  // is out before any regex is built — which is most names, most of the time.
  if (!n.includes(q))        return NO_SCORE_MATCH;
  if (n === q)               return 0;
  if (n.startsWith(q + ' ')) return 1; // starts with the query as its own whole first word
  if (n.startsWith(q))       return 2; // starts with the query, mid-word (e.g. "inchindown" vs "inch")
  const qEsc = escapeRegExp(q);
  if (new RegExp(`\\b${qEsc}\\b`).test(n)) return 3; // query is a whole word somewhere else in the name
  if (new RegExp(`\\b${qEsc}`).test(n))    return 4; // query starts some other word in the name, without completing it
  return 5; // query is buried inside a word, no boundary alignment at all
}

export function sortByRelevance<T extends { name: string }>(items: T[], query: string): T[] {
  return [...items].sort((a, b) => {
    const sd = scoreMatch(a.name, query) - scoreMatch(b.name, query);
    return sd !== 0 ? sd : a.name.localeCompare(b.name);
  });
}

// ── Searching a name and its aliases ─────────────────────────────────────────
// A tune has many names (Cooley's is also "Reaping the Rye", "The Tulla"…), and
// the one someone types is the one they heard. An alias is searched exactly
// like the name, and ranked with it: the best tier wins, and on a tie the name
// wins — a card found under its own name is the more obvious answer.
//
// `via` says which alias found it, so the result can show it. A name ALSO
// carried by another tune ("Castle" is an alias of The Kesh and a tune of its
// own) looks like a wrong answer unless the list says why it is there.

export interface AliasMatch {
  /** 0 (best) to NO_SCORE_MATCH (none), scoreMatch's scale. */
  score: number;
  /** The alias that matched, when it beat the name; absent when the name did. */
  via?: string;
}

function matchFolded(name: string, aliases: readonly string[] | undefined, q: string): AliasMatch {
  let best: AliasMatch = { score: scoreFolded(foldForSearch(name), q) };
  // Strictly better only: a tie leaves the name as the reason.
  for (const alias of aliases ?? []) {
    if (best.score === 0) break;
    const score = scoreFolded(foldForSearch(alias), q);
    if (score < best.score) best = { score, via: alias };
  }
  return best;
}

export function scoreWithAliases(name: string, aliases: readonly string[] | undefined, query: string): AliasMatch {
  return matchFolded(name, aliases, foldForSearch(query).trim());
}

/** The items whose name or an alias matches, best first, each with the alias
 *  that found it. Ties go to a name match, then alphabetically — the same
 *  order sortByRelevance gives when nothing has aliases. */
export function rankByRelevance<T extends { name: string; aliases?: readonly string[] }>(
  items: readonly T[],
  query: string,
): Array<{ item: T; via?: string }> {
  const q = foldForSearch(query).trim();
  const hits: Array<{ item: T; score: number; via?: string }> = [];
  for (const item of items) {
    const m = matchFolded(item.name, item.aliases, q);
    if (m.score < NO_SCORE_MATCH) hits.push({ item, ...m });
  }
  hits.sort((a, b) =>
    a.score - b.score
    || Number(a.via !== undefined) - Number(b.via !== undefined)
    || a.item.name.localeCompare(b.item.name));
  return hits.map(({ item, via }) => (via === undefined ? { item } : { item, via }));
}
