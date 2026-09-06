import type { ComponentChild } from 'preact';

// ── Panels a module contributes to the card page ──────────────────────────────
// The card view knows a card; it does not know what a module might have to say
// about one. This is the seam: a module registers a panel, the card page renders
// whatever is registered, and neither imports the other.
//
// It exists because the Sessions module wants to show which recordings
// recognised a tune — a fact derived from data the core deliberately keeps
// opaque (see `User.modules` in types.ts, loosely typed on purpose so no core
// file depends on a module's shape). Had the card view imported the module
// directly, that direction would have inverted, and the next module wanting a
// word would have added a second hard-coded import — which is exactly what the
// Modules page does today, and it has not aged well.
//
// Deliberately minimal: no ids, no ordering, no removal. Registration happens
// once at module load and never comes back, so anything more would be
// machinery for a case that does not exist.

export type CardPanel = (cardId: string) => ComponentChild;

const panels: CardPanel[] = [];

/** Called at module load. A panel decides for itself whether it has anything to
 *  show for a given card — returning nothing is the normal case, since most
 *  cards have nothing to do with any given module. */
export function registerCardPanel(panel: CardPanel): void {
  panels.push(panel);
}

/** In registration order, which is import order — stable, and not worth making
 *  configurable until two modules actually compete for the same space. */
export function cardPanels(): readonly CardPanel[] {
  return panels;
}
