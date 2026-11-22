import { appState, mutate } from '../store';
import { replaceExternalBytes, isExternal, uploadAttachmentSoon, condemnAttachmentFile, mutateWithRule } from './attachmentStore';
import { copyFileName } from './attachmentNames';

// ── Writing a card's file from wherever it is open ───────────────────────────
// The card page's own (views/card.tsx) and a score opened from a detection
// (session/ui/abcPreview.tsx) write the same way: out of the card view since
// 2026-11-22, when the detection's score became editable too.

/** Writes `data` (base64) into the card's file at `i`. */
export function updateCardFile(cardId: string, i: number, data: string): Promise<void> {
  const att = appState.value.cards[cardId]?.content.attachments[i];
  // An externalised file is edited where its bytes actually are. Only text
  // is editable and text is normally far below the threshold, so this is
  // the rare case of a very large note — but writing `data` here would
  // leave the card carrying both a copy and a pointer, and the pointer
  // would win at every read.
  if (att?.type === 'file' && isExternal(att)) {
    return replaceExternalBytes(att, data)
      // The edit lands under a NEW id, so every other device misses on its
      // own copy and fetches the new content instead of serving the old
      // one for ever. Which also means the previous bytes are now
      // referenced by nothing — dropped here, and only once the state
      // actually carries the new id.
      .then(external => mutate(s => {
        const target = s.cards[cardId]!.content.attachments[i];
        if (target?.type === 'file' && target.external) target.external = external;
      }).then(() => {
        // The old content is referenced by nothing in the CURRENT state,
        // so its Drive copy goes. Its local bytes stay for the sweep to
        // judge, for the same reason as the card view's onRemove: a snapshot
        // may still name them.
        void condemnAttachmentFile(att, external.id);
        uploadAttachmentSoon({ ...att, type: 'file', external });
      }));
  }
  return mutate(s => {
    const target = s.cards[cardId]!.content.attachments[i];
    if (target && target.type === 'file') target.data = data;
  });
}

/** Copies the card's file at `i`, holding `data` (base64: the original's
 *  bytes, read in by the caller when they live outside the card), into a
 *  file of the user's own, inserted just BEFORE it — so the copy takes `i`
 *  and the original moves down one. False when the file is no longer there. */
export async function copyCardFile(cardId: string, i: number, data: string): Promise<boolean> {
  const current = appState.value.cards[cardId]?.content.attachments ?? [];
  const source = current[i];
  if (!source || source.type !== 'file') return false;
  const name = copyFileName(source.name, current.flatMap(a => (a.type === 'file' ? [a.name] : [])));
  let copied = false;
  // mutateWithRule gives the copy the same rule as any new file (2026-10-01;
  // it used to land in the blob whatever its size); the write checks it is
  // still the same file.
  await mutateWithRule(s => {
    const atts = s.cards[cardId]?.content.attachments;
    const original = atts?.[i];
    if (!atts || !original || original.type !== 'file' || original.name !== source.name) return;
    // Everything but the marker: the copy is the user's, so no refresh
    // may ever replace it. The star comes along.
    //
    // `external` is dropped too, and that one is not cosmetic: the copy
    // arrives with its own `data`, and keeping the pointer would leave two
    // attachments sharing ONE set of bytes — removing either would take
    // the other's file with it.
    const { generatedBy: _generatedBy, external: _external, ...rest } = original;
    atts.splice(i, 0, { ...rest, name, data });
    copied = true;
  });
  return copied;
}
