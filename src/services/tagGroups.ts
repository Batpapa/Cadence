import type { AppState, Card } from '../types';

// ── Tag groups ────────────────────────────────────────────────────────────────
// Decided with the user on 2026-11-09 (point 6 of the testers' feedback of
// 27-10): a tag stays a plain string, and "::" inside it makes a path —
// "key::A::minor" is the value "minor" of the group "A" of the group "key".
// Nothing in the data model changes, so an older build, or a card shared to
// one, just sees a tag with colons in it and filters on it as it always did.
//
// A group is NOT a thing of its own: it exists because some tag starts with
// its path. Selecting it in a filter means "any tag under it", like a deck
// folder (deckChips.ts) — the chips under it are covered, not ticked.

export const TAG_SEP = '::';

/** The path of a tag. A tag with an empty segment ("a::", "::b", "a::::b") is
 *  not read as a path at all — a typo is not a group — and stays one piece. */
export function tagSegments(tag: string): string[] {
  const parts = tag.split(TAG_SEP);
  return parts.length > 1 && parts.every(p => p !== '') ? parts : [tag];
}

/** The groups above a tag, outermost first: "key::A::minor" → ["key", "key::A"]. */
export function tagAncestors(tag: string): string[] {
  const parts = tagSegments(tag);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(TAG_SEP));
  return out;
}

/** Every chip a card with these tags answers to: each tag and each group above
 *  it — the card's deck folders, for tags. */
export function tagChipValues(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    out.add(tag);
    for (const a of tagAncestors(tag)) out.add(a);
  }
  return [...out];
}

/** The last segment: what a chip shows inside its group. */
export function tagLabel(tag: string): string {
  const parts = tagSegments(tag);
  return parts[parts.length - 1]!;
}

/** The whole path, readable: "key › A › minor". Where a tag is shown on its
 *  own (a card's page, a study card), since its last segment alone would not
 *  say which group it belongs to. */
export function tagDisplay(tag: string): string {
  return tagSegments(tag).join(' › ');
}

/** Whether `tag` is `node` or lies under it. */
export function isUnderTag(tag: string, node: string): boolean {
  return tag === node || (tag.startsWith(node + TAG_SEP) && tagSegments(tag).length > 1);
}

export interface TagNode {
  /** The full path — the chip's key. */
  id: string;
  /** Sub-groups first, then values, each alphabetical. Empty for a value. */
  children: TagNode[];
}

/** The chips as a tree, from every chip key (tags and the groups above them —
 *  tagChipValues). Top level: groups first, then the plain tags. */
export function tagTree(keys: Iterable<string>): TagNode[] {
  const nodes = new Map<string, TagNode>();
  const roots: TagNode[] = [];
  const nodeOf = (id: string): TagNode => {
    let n = nodes.get(id);
    if (n) return n;
    n = { id, children: [] };
    nodes.set(id, n);
    const parent = tagAncestors(id).at(-1);
    if (parent === undefined) roots.push(n);
    else nodeOf(parent).children.push(n);
    return n;
  };
  for (const key of keys) nodeOf(key);
  const order = (list: TagNode[]) => {
    list.sort((a, b) => (Number(b.children.length > 0) - Number(a.children.length > 0)) || tagLabel(a.id).localeCompare(tagLabel(b.id)));
    for (const n of list) order(n.children);
  };
  order(roots);
  return roots;
}

/** The chips that an INCLUDED group chip already covers — the tags and groups
 *  under it — so they are drawn as taken in, not ticked (coveredByFolders, for
 *  tags). */
export function coveredByTagGroups(keys: readonly string[], included: Iterable<string>): Set<string> {
  const groups = [...included];
  const out = new Set<string>();
  if (groups.length === 0) return out;
  for (const key of keys) {
    if (tagAncestors(key).some(a => groups.includes(a))) out.add(key);
  }
  return out;
}

/** Whether some card carries a tag under `node` (the node itself included). */
export function tagNodeExists(cards: Iterable<Card>, node: string): boolean {
  for (const c of cards) if ((c.tags ?? []).some(t => isUnderTag(t, node))) return true;
  return false;
}

/** Whether `node` has tags below it: a group, not just a tag. */
export function tagNodeHasChildren(cards: Iterable<Card>, node: string): boolean {
  for (const c of cards) if ((c.tags ?? []).some(t => t !== node && isUnderTag(t, node))) return true;
  return false;
}

/** A card's tags rewritten one by one, keeping the stored order and never the
 *  same tag twice: where two collapse into one, the first slot wins — which is
 *  what makes a rename into an existing name a merge. Returns whether the card
 *  changed. */
function rewriteTags(card: Card, map: (tag: string) => string | null): boolean {
  if (!card.tags?.length) return false;
  const out: string[] = [];
  let changed = false;
  for (const tag of card.tags) {
    const next = map(tag);
    if (next !== tag) changed = true;
    if (next !== null && !out.includes(next)) out.push(next);
    else if (next !== null) changed = true;
  }
  if (changed) card.tags = out;
  return changed;
}

/** Renames a tag — and, when it is a group, everything under it — on every
 *  card: "key" → "tonality" turns "key::A::minor" into "tonality::A::minor".
 *  A name that already exists MERGES (the library's pencil, 2026-11-01).
 *  Only the cards' own `tags`. Returns how many cards changed. */
export function renameTagNode(state: AppState, from: string, to: string): number {
  if (!to || from === to) return 0;
  let n = 0;
  for (const card of Object.values(state.cards)) {
    if (rewriteTags(card, t => isUnderTag(t, from) ? to + t.slice(from.length) : t)) n++;
  }
  return n;
}

/** Dissolves a group: its own segment goes, what is under it moves up one
 *  level — dissolving "key::A" turns "key::A::minor" into "key::minor", and
 *  dissolving "key" turns it into "A::minor". A card tagged with the group
 *  itself keeps the level above ("key::A" → "key"), or loses the tag when the
 *  group was at the top. Returns how many cards changed. */
export function dissolveTagNode(state: AppState, node: string): number {
  const parent = tagAncestors(node).at(-1);
  let n = 0;
  for (const card of Object.values(state.cards)) {
    const changed = rewriteTags(card, t => {
      if (!isUnderTag(t, node)) return t;
      if (t === node) return parent ?? null;
      const rest = t.slice(node.length + TAG_SEP.length);
      return parent === undefined ? rest : parent + TAG_SEP + rest;
    });
    if (changed) n++;
  }
  return n;
}

/** Pinned filter chips after renameTagNode: those under `from` follow it, each
 *  in its place and state, rather than being dropped by knownChips the moment
 *  no card carries the old name — so a filter on "key::A" survives renaming
 *  "key". Where a chip lands on one already pinned (a merge), that one's state
 *  wins. */
export function renameTagNodeChips<S>(chips: ReadonlyMap<string, S>, from: string, to: string): Map<string, S> {
  const staying = new Set([...chips.keys()].filter(k => !isUnderTag(k, from)));
  const out = new Map<string, S>();
  for (const [k, s] of chips) {
    if (staying.has(k)) { out.set(k, s); continue; }
    const moved = to + k.slice(from.length);
    if (!staying.has(moved) && !out.has(moved)) out.set(moved, s);
  }
  return out;
}

/** Pinned filter chips once a tag or group is gone: the chips under it go too,
 *  rather than lying in the route until a tag of that name comes back. */
export function dropTagNodeChips<S>(chips: ReadonlyMap<string, S>, node: string): Map<string, S> {
  return new Map([...chips].filter(([k]) => !isUnderTag(k, node)));
}

// ── What the importers write ──────────────────────────────────────────────────
// Fixed English group names: these are data, and travel with a shared card,
// as the values themselves ("reel", "minor") always did.

export const TYPE_GROUP = 'type';
export const KEY_GROUP = 'key';

/** TheSession's tune types, the closed list its imports could ever write. */
const TUNE_TYPES = new Set([
  'jig', 'reel', 'slip jig', 'hornpipe', 'polka', 'slide',
  'waltz', 'barndance', 'strathspey', 'three-two', 'mazurka', 'march',
]);

/** TheSession's key format, tonic then lower-case mode: "Gmajor", "F#minor",
 *  "Bbmixolydian" (irishtune.info's are converted to it on import). What the
 *  migration recognises as a key written flat. */
const KEY_FORMAT = /^([A-G](?:##|bb|#|b)?)(major|minor|dorian|mixolydian|lydian|phrygian|locrian|aeolian|ionian)$/;

export function typeTag(type: string): string {
  return `${TYPE_GROUP}${TAG_SEP}${type}`;
}

/** "Aminor" → "key::Aminor": the key whole, tonic and mode together (the
 *  user's call, 2026-11-09, going back on splitting them). */
export function keyTag(key: string): string {
  return `${KEY_GROUP}${TAG_SEP}${key}`;
}

/** Moves the type and key tags an import wrote flat ("reel", "Aminor") into
 *  their groups. Only on a tune imported from a source — a set's tags are its
 *  owner's own, and a hand-made card's "reel" is the user's word, not the
 *  import's — and only values in the importers' exact formats, so nothing is
 *  guessed. Idempotent; run on every normalisation, since an older build still
 *  writes the flat tags when it imports or refreshes. Returns whether the card
 *  changed. */
export function groupImportTags(card: Card): boolean {
  const id = card.externalId;
  if (!id || !(id.startsWith('thesession:') || id.startsWith('irishtuneinfo:'))) return false;
  return rewriteTags(card, t => TUNE_TYPES.has(t) ? typeTag(t) : KEY_FORMAT.test(t) ? keyTag(t) : t);
}
