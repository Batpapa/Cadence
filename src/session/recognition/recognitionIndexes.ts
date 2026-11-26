// ── Which indexes a recognition searches, in what order (2026-11-16) ─────────
// TheSession's index (indexStore.ts) and the user's tune cards (cardIndex.ts),
// chosen and ordered in the analyser's options. Off, an index is not loaded at
// all — TheSession's is not even downloaded. On, its settings are tagged with
// its id as their `source` when the worker merges the indexes, and the order
// goes to the engine as is (set_source_order): on equal scores, the earlier
// index's tune wins.
//
// Stored on the analyser's own slice (TuneAnalyserModuleData.recognitionIndexes),
// read through recognitionIndexesOf() alone: absent means the default order,
// both on (the user, 2026-11-16).

import { analyserModuleOf } from '../model';

/** An index, and the `source` its settings carry in the merged index. */
export type RecognitionIndexId = 'cards' | 'thesession';

/** Every index this version knows, in the default order. */
const KNOWN: readonly RecognitionIndexId[] = ['cards', 'thesession'];

export interface RecognitionIndexChoice { id: RecognitionIndexId; on: boolean }

const isKnown = (id: string): id is RecognitionIndexId => (KNOWN as readonly string[]).includes(id);

/** The indexes in the user's order, each on or off: the stored list's known
 *  entries as stored, then any index it does not name yet, on, in the default
 *  order. Never all off — a list with nothing on reads as the default. */
export function recognitionIndexesOf(user: { modules?: Record<string, unknown> }): RecognitionIndexChoice[] {
  const stored = analyserModuleOf(user)?.recognitionIndexes ?? [];
  const out: RecognitionIndexChoice[] = [];
  for (const entry of stored) {
    if (isKnown(entry.id) && !out.some(o => o.id === entry.id)) out.push({ id: entry.id, on: entry.on !== false });
  }
  for (const id of KNOWN) if (!out.some(o => o.id === id)) out.push({ id, on: true });
  return out.some(o => o.on) ? out : KNOWN.map(id => ({ id, on: true }));
}

/** The list to store: `choices` in their order, and every entry the stored list
 *  holds that this version does not know, after them — a newer version's index
 *  is not dropped by an older one saving its own. */
export function storedRecognitionIndexes(
  user: { modules?: Record<string, unknown> },
  choices: readonly RecognitionIndexChoice[],
): { id: string; on: boolean }[] {
  const stored = analyserModuleOf(user)?.recognitionIndexes ?? [];
  const unknown = stored.filter(e => !isKnown(e.id));
  return [...choices.map(c => ({ id: c.id, on: c.on })), ...unknown.map(e => ({ id: e.id, on: e.on }))];
}

/** What a recognition is started with: which indexes to load, and the order of
 *  their sources among equal scores. */
export function recognitionPlan(choices: readonly RecognitionIndexChoice[]): { cards: boolean; theSession: boolean; sourceOrder: RecognitionIndexId[] } {
  const on = choices.filter(c => c.on).map(c => c.id);
  return { cards: on.includes('cards'), theSession: on.includes('thesession'), sourceOrder: on };
}
