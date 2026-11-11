import type { AppState, FilterState } from '../types';
import { t } from '../services/i18nService';
import { deckIdsByCard, deckPath, folderPath, findParentFolder, folderChainIds } from '../services/deckService';
import { folderChipKey, folderIdOfChip, knownChips, coveredByFolders } from './filterChips';
import type { FilterTreeNode } from './filterSection';

// ── The "Decks" section of chips, decks and deck folders ─────────────────────
// Moved out of the card library (2026-11-05) when the analyser's tunes tab
// gained the same section: which chips it offers, what each is called, what an
// included folder covers and which chips a card answers to. Written once, so
// the same chip cannot mean two things on the two screens.

/** The "no deck" chip. A sentinel rather than the empty string so it can never
 *  be confused with a real id. Stored in routes: never rename it. */
export const NO_DECK = '__no_deck__';

/** Whether a deck chip still names something: a deck, a deck folder, or "no
 *  deck". A chip naming one deleted since is ignored (see knownChips). */
export function deckChipKnown(user: AppState, key: string): boolean {
  if (key === NO_DECK) return true;
  const folderId = folderIdOfChip(key);
  return folderId === null ? !!user.decks[key] : !!user.folders[folderId];
}

export interface DeckChipSection {
  /** The pinned chips that still name something. */
  live: Map<string, FilterState>;
  /** "No deck" first when offered, then the decks by name. */
  items: string[];
  folderItems: string[];
  /** The same chips as a tree (FilterSection's `tree`): each folder with its
   *  decks and sub-folders, top-level folders first, then "no deck" and the
   *  decks filed nowhere. */
  tree: FilterTreeNode[];
  covered: Set<string>;
  labelOf: (key: string) => string;
  titleOf: (key: string) => string;
  /** Every chip a card answers to: its decks and every folder above them, or
   *  "no deck" alone. undefined (no card at all) is in no deck. */
  valuesOf: (cardId: string | undefined) => string[];
  /** Whether a click in the section could split the list. Decks are an
   *  exhaustive partition ("no deck" counts), so one occupied bucket cannot;
   *  a pinned chip keeps the section, or it would filter out of sight. */
  hasMix: boolean;
}

/** The section over the cards `inPool` accepts. `hasOrphans`: whether one of
 *  the things listed is in no deck — the caller's to say, since an analyser
 *  row without a card is one too. */
export function deckChipSection(
  user: AppState,
  active: Map<string, FilterState>,
  inPool: (cardId: string) => boolean,
  hasOrphans: boolean,
): DeckChipSection {
  const live = knownChips(active, key => deckChipKnown(user, key));
  const items = [
    ...(hasOrphans || live.has(NO_DECK) ? [NO_DECK] : []),
    ...Object.values(user.decks)
      .filter(d => d.entries.some(e => inPool(e.cardId)) || live.has(d.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => d.id),
  ];

  // A folder chip stands for every deck below it, however deep: a card is "in"
  // the folder when it is in one of those decks. Same section as the decks, so
  // "this folder OR that deck" can be asked (decided with the user, 2026-09-15).
  /** The folder chips above each deck. Built once per call, not per card. */
  const foldersAboveDeck = new Map(Object.keys(user.decks).map(id =>
    [id, folderChainIds(findParentFolder(id, 'deck', user), user).map(folderChipKey)]));
  const offeredFolders = new Set<string>();
  for (const id of items) for (const k of foldersAboveDeck.get(id) ?? []) offeredFolders.add(folderIdOfChip(k)!);
  for (const k of live.keys()) { const id = folderIdOfChip(k); if (id !== null) offeredFolders.add(id); }
  // By path, so a sub-folder follows its parent.
  const folderIds = [...offeredFolders].sort((a, b) => folderPath(a, user).localeCompare(folderPath(b, user)));
  const folderItems = folderIds.map(folderChipKey);
  const covered = coveredByFolders(
    [...items, ...folderItems],
    key => {
      const folderId = folderIdOfChip(key);
      return folderId === null
        ? foldersAboveDeck.get(key) ?? []
        : folderChainIds(folderId, user).slice(0, -1).map(folderChipKey);
    },
    live,
  );

  // The tree: a deck under the innermost folder above it, a folder under its
  // parent. Every folder above an offered deck is offered (offeredFolders), so
  // no chip is left without its parent. Folders by path and decks by name, as
  // `folderItems` and `items` already are.
  const nodes = new Map<string, FilterTreeNode>();
  const tree: FilterTreeNode[] = [];
  for (const key of folderItems) nodes.set(key, { id: key, children: [], group: true });
  for (const key of items) nodes.set(key, { id: key, children: [] });
  const parentOf = (key: string): string | undefined => {
    if (key === NO_DECK) return undefined;
    const folderId = folderIdOfChip(key);
    const above = folderId === null
      ? foldersAboveDeck.get(key) ?? []
      : folderChainIds(folderId, user).slice(0, -1).map(folderChipKey);
    return above.at(-1);
  };
  for (const key of [...folderItems, ...items]) {
    const parent = parentOf(key);
    const node = nodes.get(key)!;
    (parent !== undefined && nodes.has(parent) ? nodes.get(parent)!.children : tree).push(node);
  }

  // Each card's decks, read once for the whole section rather than every deck
  // searched per card: `valuesOf` is asked of every row, twice (bench,
  // 2026-11-10: half of a library render). Built from `user` on each call, so
  // nothing outlives the state it was read from.
  const decksOfCard = deckIdsByCard(user);

  return {
    live,
    items,
    folderItems,
    tree,
    covered,
    labelOf: id => {
      if (id === NO_DECK) return t('library.filterNoDecks');
      const folderId = folderIdOfChip(id);
      // The name alone: in the tree, where a folder sits says which one it is
      // (the flat row of chips used to need the path for two of one name).
      return folderId !== null ? user.folders[folderId]?.name ?? folderId : (user.decks[id]?.name ?? id);
    },
    titleOf: id => {
      if (id === NO_DECK) return '';
      const folderId = folderIdOfChip(id);
      return folderId !== null ? folderPath(folderId, user) : deckPath(id, user);
    },
    valuesOf: cardId => {
      const decks = cardId ? decksOfCard.get(cardId) ?? [] : [];
      if (decks.length === 0) return [NO_DECK];
      const out = new Set<string>();
      for (const d of decks) {
        out.add(d);
        for (const k of foldersAboveDeck.get(d) ?? []) out.add(k);
      }
      return [...out];
    },
    hasMix: items.length > 1 || live.size > 0,
  };
}
