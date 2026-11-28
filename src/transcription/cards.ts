import type { Card, FileAttachment } from '../types';
import { appState } from '../store';
import { generateId } from '../utils';
import { attachmentFor, mutateWithRule, uploadAttachmentSoon } from '../services/attachmentStore';
import { textAttachment } from '../services/textAttachment';
import { sanitizeFileBase } from '../services/attachmentNames';
import { addCardsToDecks } from '../services/deckService';
import { CARD_TYPE_TUNE } from '../services/cardTypeService';
import { typeTag, keyTag } from '../services/tagGroups';
import { DANCES, sessionKeyOf } from './settings';
import { currentAbc, retitled, type TranscriptionRecord } from './model';

// ── A transcription into the cards ───────────────────────────────────────────
// A new card made of it, or an existing card given it as a new ABC file (the
// user, 2026-11-28 — versions into a card's own files were offered, then
// dropped: one way, the plainest). What a card gets is its own, with no mark
// of where it came from (the user, 2026-11-28: no link between the two —
// the trace once written on the file is gone): nothing here is undone by
// deleting the transcription, nor followed by correcting it. The recording
// does not go along.

/** The ABC as a card's score file, named after `base` — and titled after it,
 *  where its title is still the transcription's name (retitled). */
async function abcAttachment(record: TranscriptionRecord, base: string): Promise<FileAttachment> {
  const file = textAttachment(sanitizeFileBase(base) || 'transcription', retitled(currentAbc(record), record.name, base), 'abc');
  return attachmentFor(file, appState.value);
}

/** The new card: the transcription's ABC as its score, its dance and key as
 *  tags. Its id, once written. */
export async function createCard(record: TranscriptionRecord, name: string, deckIds: string[]): Promise<string> {
  const attachments: FileAttachment[] = [await abcAttachment(record, name)];
  const tags: string[] = [];
  const dance = record.settings.dance;
  if (dance && DANCES.some(d => d.id === dance)) tags.push(typeTag(dance));
  const key = sessionKeyOf(currentAbc(record));
  if (key) tags.push(keyTag(key));
  const id = generateId();
  const card: Card = {
    id, guid: generateId(), name, defaultImportance: 1, tags, type: CARD_TYPE_TUNE,
    content: { notes: '', attachments },
  };
  await mutateWithRule(s => {
    s.cards[id] = card;
    addCardsToDecks(s, deckIds, [id]);
  });
  for (const a of attachments) uploadAttachmentSoon(a);
  return id;
}

/** The transcription added to card `cardId`, as an ABC file of its own —
 *  never a version into one of the card's files (2026-11-28, the user: the
 *  card's editor is where its versions are made). Throws when the card is
 *  gone. */
export async function addToCard(record: TranscriptionRecord, cardId: string): Promise<void> {
  if (!appState.value.cards[cardId]) throw new Error('card gone');
  const file = await abcAttachment(record, record.name);
  await mutateWithRule(s => { s.cards[cardId]?.content.attachments.push(file); });
  uploadAttachmentSoon(file);
}
