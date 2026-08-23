// ── Tune display name normalization ───────────────────────────────────────────
// FolkFriend's tune index stores names in library-catalog sort order — the
// leading article moved to the end so the name alphabetizes under its real
// first word ("Kesh, The", so it sorts under K, not T). That's a sorting
// convention, not how anyone actually says or writes the name — flip it back
// for display ("The Kesh").

const TRAILING_ARTICLE = /^(.+),\s*(the|an?)$/i;

export function normalizeDisplayName(name: string): string {
  const m = TRAILING_ARTICLE.exec(name);
  return m ? `${m[2]} ${m[1]}` : name;
}
