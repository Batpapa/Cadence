import type { FilterState } from '../types';

// ── Folder chips, and chips that point at nothing ────────────────────────────
// A leaf with no imports worth the name, so the rules below can be tested
// without mounting anything. Shared by the card library (decks and their
// folders) and the analyser's tunes tab (analyses and theirs): the same gesture
// on both screens has to mean the same thing, so it is written once.

/** A folder travels in the SAME chip map as the things it holds — one section,
 *  one AND/OR toggle — told apart by this prefix. Ids are UUIDs, so nothing
 *  real can collide with it, and it stays readable in a stored route. */
const FOLDER_CHIP_PREFIX = 'folder:';

export function folderChipKey(folderId: string): string {
  return FOLDER_CHIP_PREFIX + folderId;
}

/** The folder a chip key names, or null for any other kind of chip. */
export function folderIdOfChip(key: string): string | null {
  return key.startsWith(FOLDER_CHIP_PREFIX) ? key.slice(FOLDER_CHIP_PREFIX.length) : null;
}

/** The chips that still name something that exists.
 *
 *  A pinned chip for a deck, an analysis or a folder deleted since — on another
 *  device, then a back navigation — used to keep filtering while no chip showed
 *  it: an empty list with no visible cause. Such a key is now ignored.
 *
 *  Ignored, not erased: callers read through this and keep their stored map, so
 *  a key whose target is merely not LOADED yet (the analyses come from
 *  IndexedDB after the first render) is still there once it is. Returns the
 *  map itself when nothing is dropped, so its identity is stable. */
export function knownChips<M extends ReadonlyMap<string, FilterState>>(
  chips: M, exists: (key: string) => boolean,
): M | Map<string, FilterState> {
  for (const key of chips.keys()) {
    if (!exists(key)) return new Map([...chips].filter(([k]) => exists(k)));
  }
  return chips;
}

/** The chips an INCLUDED folder already covers — the things inside it, and the
 *  folders below it — so the section can show what that folder pulled in, and
 *  one of them can be excluded from it in a click.
 *
 *  `foldersAbove(key)` is every folder chip key above an item, nearest or not;
 *  for a folder chip it must not contain the folder itself. */
export function coveredByFolders(
  keys: readonly string[],
  foldersAbove: (key: string) => readonly string[],
  chips: ReadonlyMap<string, FilterState>,
): Set<string> {
  const included = new Set([...chips].filter(([k, s]) => s === 'include' && folderIdOfChip(k) !== null).map(([k]) => k));
  const out = new Set<string>();
  if (included.size === 0) return out;
  for (const key of keys) {
    if (foldersAbove(key).some(f => included.has(f))) out.add(key);
  }
  return out;
}

/** What each folder chip is called: its name, or its whole path when another
 *  folder offered alongside has the same name — two "Mardis" under two parents
 *  are two different chips, and a phone has no tooltip to tell them apart. */
export function folderChipLabels(
  folderIds: readonly string[],
  nameOf: (id: string) => string,
  pathOf: (id: string) => string,
): Map<string, string> {
  const seen = new Map<string, number>();
  for (const id of folderIds) seen.set(nameOf(id), (seen.get(nameOf(id)) ?? 0) + 1);
  return new Map(folderIds.map(id => [id, (seen.get(nameOf(id)) ?? 0) > 1 ? pathOf(id) : nameOf(id)]));
}
