import { forgetUserKeys } from '../userLocalKeys';
import { clearSnapshotsForUser } from './snapshotService';
import { deleteLocalSessionData } from '../session/db';
import { deleteLocalAttachmentData } from './attachmentDb';
import { deleteUser, removeUserFromOrder, getLastUserId, clearLastUserId } from '../db';

/** Removes the whole local copy of a user from this device: every key of
 *  theirs in localStorage (userLocalKeys.ts — the Drive bookkeeping that points
 *  at them included), their safety-net snapshots, their recordings, their
 *  attachments' local copies, and last their state blob. Nothing on Drive.
 *
 *  The keys go first, as the Drive bookkeeping always did: with it gone,
 *  nothing pushes this user to Drive any more. `deleteLocalSessionData` is what
 *  this was missing until 2026-09-08: `deleteUser` only drops the AppState blob,
 *  so every past recording's audio, the interrupted drafts and their chunks
 *  stayed behind in `cadence-tune-analyser-local-user-{id}` — a database no
 *  screen can reach any more once its owner is gone, quietly holding the
 *  largest thing this app stores. The blob goes last, so a failure before it
 *  leaves the user present and what remains reachable, rather than the
 *  reverse.
 *
 *  Out of Settings since 2026-11-26, with the per-user keys it did not know
 *  of: the folder id on Drive, the last route, the library's sort, the
 *  analyser's audio settings and lists. */
export async function removeUserData(userId: string): Promise<void> {
  forgetUserKeys(userId);
  await clearSnapshotsForUser(userId);
  await deleteLocalSessionData(userId);
  await deleteLocalAttachmentData(userId);
  removeUserFromOrder(userId);
  await deleteUser(userId);
  if (getLastUserId() === userId) clearLastUserId();
}
