/** The two letters in a user's or a profile's round badge: the first letter of
 *  each of the first two words, upper-cased — "—" for a name with none. One
 *  place since 2026-11-26: the welcome screen, the header and the settings had
 *  a copy each, and the welcome screen's had drifted to "?". */
export function initialsOf(name: string): string {
  return name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '—';
}
