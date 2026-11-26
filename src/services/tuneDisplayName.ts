// Out of utils.ts since 2026-11-26.

// ── Tune display name normalization ───────────────────────────────────────────
// Both FolkFriend's tune index (ffWorker.ts) and TheSession's static GitHub
// data dump (adactio/TheSession-data — trendingSyncService.ts's
// json/tune_popularity.json, tuneNameIndexService.ts's json/tunes.json) store
// names in library-catalog sort order — the leading article moved to the end
// so the name alphabetizes under its real first word ("Kesh, The", so it
// sorts under K, not T). That's a sorting convention, not how anyone actually
// says or writes the name — flip it back for display ("The Kesh"). NOT
// needed for thesession.org's own live JSON API (theSessionService.ts,
// actual tune/card import) — verified (2026-08-24) it already returns
// natural order ("The Kesh"), only the static data dump has this quirk.

const TRAILING_ARTICLE = /^(.+),\s*(the|an?)$/i;

export function normalizeDisplayName(name: string): string {
  const m = TRAILING_ARTICLE.exec(name);
  return m ? `${m[2]} ${m[1]}` : name;
}

// ── Reading a recognised name before the real one arrives ────────────────────
// The recognition index holds its names ENTIRELY in lower case — measured, not
// assumed: 0 capitals across its 46 867 aliases, "'ma' mcnulty's favourite"
// included. Case was dropped because matching ignores it.
//
// This is the LAST resort for showing one, and deliberately temporary: the
// name a detection really deserves is its card's, or TheSession's own from the
// name index (see tuneNames.ts's `tuneName`, which reaches for those first
// and starts the index downloading when it is missing). This only fills the
// seconds in between, and does the job better than the CSS `capitalize` it
// replaces — that one produced "Mcgoldrick's" and "The Bucks Of Oranmore".
//
// Rules, therefore, are acceptable HERE and nowhere else: nothing is stored
// from this, and whatever it gets wrong is corrected the moment the index
// lands.

/** Words that stay lower case inside a title, but not at either end of one.
 *  English and Irish both, since the index carries plenty of Irish names. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of',
  'off', 'on', 'or', 'the', 'to', 'up', 'with',
  'na', 'nan', 'agus', 'don', 'de', 'do', 'le', 'go',
]);

/** Capitals a first-letter rule cannot produce. `Mc` is safe to expand — an
 *  Irish or Scottish name is what it always is. `Mac` is NOT: "Macklin" and
 *  "Machine" would become "MacKlin" and "MacHine", so it gets its own capital
 *  and nothing more. */
function fixInternalCaps(word: string): string {
  if (/^mc[a-z]/.test(word)) return 'Mc' + word.charAt(2).toUpperCase() + word.slice(3);
  if (/^o'[a-z]/.test(word)) return "O'" + word.charAt(2).toUpperCase() + word.slice(3);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function titleCaseTuneName(name: string): string {
  // Anything already carrying a capital came from a source that kept them —
  // TheSession, or a person typing. Re-casing that can only do harm.
  if (/[A-Z]/.test(name)) return name;

  return name.split('/').map(segment => {
    const parts = segment.split(/(\s+)/);           // separators kept
    const wordIdx = parts.map((p, i) => (i % 2 === 0 && p ? i : -1)).filter(i => i >= 0);
    const first = wordIdx[0];
    const last = wordIdx[wordIdx.length - 1];

    return parts.map((part, i) => {
      if (i % 2 === 1 || !part) return part;         // whitespace
      const lower = part.toLowerCase();
      // The bare word decides: "of," and "of" are the same word.
      const bare = lower.replace(/[^a-zà-ÿ']/g, '');
      if (i !== first && i !== last && SMALL_WORDS.has(bare)) return lower;
      // Hyphenated names get each half capitalised ("sean-nós" → "Sean-Nós").
      return lower.split('-').map(fixInternalCaps).join('-');
    }).join('');
  }).join('/');
}
