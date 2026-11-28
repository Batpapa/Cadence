import { mutate } from '../store';
import { generateId } from '../utils';
import { editTranscriptionModule, editTranscriptionTree, retitled, type TranscriptionRecord } from './model';
import { forgetSession, placeSession } from '../session/sessionTree';
import { putTranscriptionAudio, deleteTranscriptionAudio } from './audioDb';

// ── What is done to a transcription ──────────────────────────────────────────
// Every write goes through mutate() on the stored copy, and never brings back
// a transcription deleted meanwhile — the analyser's rule (session/db.ts's
// mutateAnalysis): an edit landing after a deletion (another tab, Drive) is
// dropped, not resurrected.

/** The worker's ABC (its M:, L:, Q:, K: lines and the tune) made a whole tune. */
export function wholeTune(abc: string, title: string): string {
  return ['X: 1', `T: ${title}`, abc.trim()].join('\n');
}

/** A new transcription and its recording, stored: the recording FIRST, then
 *  the record that names it — a recording's rule everywhere in this app (a
 *  record never points at bytes that were not written). Filed in `folderId`
 *  when it still exists (the one on screen when the recording was chosen), at
 *  the root else. Its id. */
export async function addTranscription(record: Omit<TranscriptionRecord, 'id'>, audio: Blob, folderId: string | null = null): Promise<string> {
  const id = generateId();
  await putTranscriptionAudio(id, audio);
  await mutate(s => {
    editTranscriptionModule(s, m => { m.transcriptions[id] = { ...record, id }; });
    // a folder only: the root needs no entry (an id in no folder is at the root)
    if (folderId) editTranscriptionTree(s, tree => { if (tree.folders[folderId]) placeSession(tree, id, folderId); });
  });
  return id;
}

/** Edits a stored transcription — nothing when it is gone. Whether it was
 *  there. */
async function edit(id: string, fn: (r: TranscriptionRecord) => void): Promise<boolean> {
  let found = false;
  await mutate(s => editTranscriptionModule(s, m => {
    const r = m.transcriptions[id];
    if (r) { fn(r); found = true; }
  }));
  return found;
}

/** The ABC as corrected: the draft itself again is written as no correction.
 *  False when the transcription is gone: nothing was written — which the
 *  score viewer has to say rather than "saved". */
export function saveCorrection(id: string, abc: string): Promise<boolean> {
  return edit(id, r => { if (abc === r.draft) delete r.abc; else r.abc = abc; });
}

/** Back to the draft as the transcriber wrote it. */
export async function revertToDraft(id: string): Promise<void> {
  await edit(id, r => { delete r.abc; });
}

/** Its score's title along, where it is still the old name (retitled). */
export async function renameTranscription(id: string, name: string): Promise<void> {
  await edit(id, r => {
    r.draft = retitled(r.draft, r.name, name);
    if (r.abc !== undefined) r.abc = retitled(r.abc, r.name, name);
    r.name = name;
  });
}

/** A new draft in place of the old — transcribed again, with other settings
 *  or another passage — the corrections of the old one dropped (the user is
 *  asked first, setup.tsx startRedo). */
export async function replaceDraft(id: string, next: Pick<TranscriptionRecord, 'name' | 'draft' | 'from' | 'to' | 'settings'>): Promise<void> {
  await edit(id, r => {
    r.name = next.name;
    r.draft = next.draft;
    r.from = next.from;
    r.to = next.to;
    r.settings = next.settings;
    r.createdAt = Date.now();
    delete r.abc;
  });
}

/** Deletes a transcription, then its recording. Cards made of it keep what
 *  they were given: their files are their own (cards.ts). */
export async function deleteTranscription(id: string): Promise<void> {
  await deleteTranscriptions([id]);
}

/** Deletes transcriptions — a folder's, all at once: the records and their
 *  places in the tree in one write, then their recordings. */
export async function deleteTranscriptions(ids: string[]): Promise<void> {
  await mutate(s => {
    editTranscriptionModule(s, m => { for (const id of ids) delete m.transcriptions[id]; });
    editTranscriptionTree(s, tree => { for (const id of ids) forgetSession(tree, id); });
  });
  for (const id of ids) await deleteTranscriptionAudio(id);
}
