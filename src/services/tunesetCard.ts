import type { Attachment, Card } from '../types';
import { CARD_TYPE_TUNESET } from './cardTypeService';
import { TUNESET_NAME_SEPARATOR } from './stateNormalise';

/** A new set card made of these tunes, in this order. Shaped like an imported
 *  set (theSessionService's buildSetCards): its name follows its tunes, and
 *  each tune comes with the user's usual number of passes.
 *
 *  Shared by every place that makes a set out of cards already in the library
 *  — a set heard in an analysis, the analyser's batch, the library selection.
 *  Its own module so neither cardRefService nor cardTypeService has to import
 *  stateNormalise, which imports them both.
 *
 *  A repeat of 1 is written by absence, as the card page writes it: once is
 *  the default, and storing it would be noise in every export. */
export function buildTunesetCard(
  tunes: readonly Card[],
  opts: { defaultRepeat: number; attachments: Attachment[]; newId: () => string },
): Card {
  return {
    id: opts.newId(),
    guid: opts.newId(),
    // Replaced on the first normalisation anyway — computedName is on.
    name: tunes.map(c => c.name).join(TUNESET_NAME_SEPARATOR),
    defaultImportance: 1,
    tags: [],
    type: CARD_TYPE_TUNESET,
    computedName: true,
    tunes: tunes.map(c => ({
      id: c.id, guid: c.guid, externalId: c.externalId, title: c.name,
      ...(opts.defaultRepeat > 1 ? { repeat: opts.defaultRepeat } : {}),
    })),
    content: { notes: '', attachments: opts.attachments },
  };
}
