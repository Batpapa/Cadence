import { appState } from '../store';
import type { FileEntry } from '../types';
import { hydratedEntry } from '../services/attachmentStore';
import { copyCardFile } from '../services/cardFiles';
import { showModal, closeModal, dismissTopModal } from './modal';
import type { AudioSyncCarry } from './fileViewer';
import { t } from '../services/i18nService';

// ── Editing TheSession's score: on a copy (2026-11-22, the user) ─────────────
// "Refresh score" replaces TheSession's file whole, so an edit made in it would
// be lost at the next refresh. Its editor's tab (fileViewer.ts's editGate)
// asks first, wherever the score is open — the card, or a detection's score —
// and makes a copy just before the original; the viewer then opens on the
// copy, on its editor's face, at the version that was on screen.
//
// It used to ask at the first SAVE, from the card only (2026-09-15). A copy
// the card already has is not looked for: telling one from any other score of
// the same tune takes rules the user did not want (2026-11-22). Each press
// makes a new one, there to see in the list.

/** The editor's tab of TheSession's score at `index` of the card, pressed on
 *  `version` in a viewer still open. Asks, makes the copy, closes that viewer
 *  and calls `open` with the copy's place and the version to open it on —
 *  and `carry`, that viewer's audio sync when it was on, for the copy's to
 *  go on with it. Nothing happens on a cancel, or once the file is gone. */
export async function theSessionEditGate(
  cardId: string, index: number, version: number,
  open: (index: number, version: number, carry?: AudioSyncCarry) => void,
  carry?: AudioSyncCarry,
): Promise<void> {
  const att = appState.value.cards[cardId]?.content.attachments[index];
  if (!att || att.type !== 'file') return;
  let original: FileEntry;
  try { original = await hydratedEntry(att, true); } catch { return; }

  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = t('fileViewer.abc.copy.message');
  showModal(t('fileViewer.abc.copy.title'), body, [
    { label: t('common.cancel'), onClick: () => closeModal() },
    {
      label: t('fileViewer.abc.copy.confirm'), primary: true,
      // The copy takes the original's place, versions and all: the question
      // closes, then the viewer under it, and the copy opens.
      onClick: () => {
        void copyCardFile(cardId, index, original.data).then(done => {
          closeModal();
          if (!done) return;
          // As a dismissal: its sound, its audio sync, its keys released —
          // popped alone, its audio sync played on behind the copy's
          // viewer (2026-11-23, the user).
          dismissTopModal();
          open(index, version, carry);
        });
      },
    },
  ]);
}
