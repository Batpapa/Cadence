import type { AppState, Attachment, Card, FileAttachment, FileEntry, ExternalFile, ResolvableFile } from '../types';
import { generateId } from '../utils';
import {
  getAttachmentBlob, putAttachmentBlob, deleteAttachmentBlob, heldAttachmentIds,
  condemnDriveFile, condemnedFiles, forgetCondemned,
} from './attachmentDb';

// ── Resolving an attachment's bytes ──────────────────────────────────────────
// One module owns two questions, and nothing else may answer them by hand:
//
//   • does a file being attached belong in the synced blob, or outside it?
//   • given an attachment, where are its bytes right now?
//
// The measurements behind this: on one real backup, ten audio files were 82%
// of a 34.6 MB state. Every `mutate()` structuredClones that state AND rewrites
// it to IndexedDB, and every Drive push serialises it whole — so those bytes
// were paid for on every single rating given, and sent again on every sync,
// while never changing. Out of the blob, the same state weighs 6.3 MB.
//
// ── The rule, and why Drive is part of it ────────────────────────────────────
// Size alone does not decide: an attachment only moves out when Drive is
// connected, because out of the blob it is no longer backed up by the sync.
// Externalising without Drive would quietly turn a backed-up file into one
// copy on one device — which is precisely the loss this app has already lived
// through (2026-09-09). Under that condition, `data` stays where it is.
//
// ── The state is the field, not an enum ──────────────────────────────────────
// `external` present = bytes outside; absent = bytes in `data`. No mode string
// to keep in step. Within `external`, `driveFileId` absent means the upload has
// not happened yet and these bytes exist HERE AND NOWHERE ELSE.

/** 50 KB. Deliberately well below the smallest thing worth moving (the audio
 *  files measured start at 1.2 MB) and well above the largest thing that must
 *  stay put (the biggest ABC in that library is 30 KB): the population is
 *  strongly bimodal, and any threshold between 64 KB and 1 MB externalised
 *  exactly the same ten files out of 1307. So this number is not a delicate
 *  trade-off, and it does not need to be tuned to be right. */
export const DEFAULT_THRESHOLD_KB = 50;

/** Zero is a real answer, not a mistake: "keep nothing in the blob". Someone
 *  who wants their library to stay small whatever it holds is entitled to say
 *  so, and every reader now waits for bytes that are elsewhere rather than
 *  assuming they are at hand. A NEGATIVE number is still not a size, and
 *  anything that is not a number at all is the field being absent. */
export function attachmentThresholdBytes(user: { attachmentThresholdKb?: number }): number {
  const kb = user.attachmentThresholdKb;
  return (typeof kb === 'number' && kb >= 0 ? kb : DEFAULT_THRESHOLD_KB) * 1024;
}

/** driveService reads `sessionStorage` at module evaluation, which crashes any
 *  test importing this file in node. Deferred exactly as session/db.ts defers
 *  the same module, and for the same reason. */
function driveModule(): Promise<typeof import('./driveService')> {
  return (_drive ??= once(() => import('./driveService'), () => { _drive = null; }));
}

/** store.ts pulls in driveService transitively, so it is deferred for exactly
 *  the same reason — the pattern session/db.ts documents at length. */
function storeModule(): Promise<typeof import('../store')> {
  return (_store ??= once(() => import('../store'), () => { _store = null; }));
}

/** Each deferred module is asked for once, not on every call — this file makes
 *  them by the thousand in a single pass. Found by the property test
 *  (2026-10-01): under vitest, two `import()`s of one mocked module in flight
 *  at the same moment could resolve the second to the REAL module. In the
 *  browser the import is already in the bundle and this only saves the calls.
 *  A failed import is forgotten rather than kept, so a later call retries. */
let _drive: Promise<typeof import('./driveService')> | null = null;
let _store: Promise<typeof import('../store')> | null = null;
let _snapshots: Promise<typeof import('./snapshotService')> | null = null;
let _db: Promise<typeof import('../db')> | null = null;
function once<T>(load: () => Promise<T>, forget: () => void): Promise<T> {
  return load().catch((e: unknown) => { forget(); throw e; });
}

/** Size half of the rule, on its own so it can be reasoned about and tested
 *  without a browser, a user account or a network.
 *
 *  A file with no bytes is above NO threshold, zero included. Without that
 *  guard `0 >= 0` is true, and a threshold of zero — "keep nothing in the
 *  blob" — sent every empty attachment out: one 0-byte Drive file per set,
 *  since a set's score is stored as an empty placeholder and rebuilt at
 *  display time (abcService's tunesetAbcPlaceholder). There is nothing to
 *  externalise about no bytes, so the question never arises. */
export function isAboveThreshold(bytes: number, user: { attachmentThresholdKb?: number }): boolean {
  return bytes > 0 && bytes >= attachmentThresholdBytes(user);
}

async function driveConnected(): Promise<boolean> {
  try { return (await driveModule()).isDriveConnected(); }
  catch { return false; }
}

/** THE rule, stated once, as a test a caller can apply to many files: asking
 *  Drive is a module load and a localStorage read, and a library has thousands
 *  of attachments.
 *
 *  Everything that decides where bytes belong goes through this — the file
 *  picker, the analyser's clips, an imported package, and the conversion of an
 *  existing library. Two expressions of one rule is how a threshold comes to
 *  mean one thing on the way in and another on the way out. */
async function attachmentRule(
  user: { attachmentThresholdKb?: number },
): Promise<(bytes: number) => boolean> {
  const driveOn = await driveConnected();
  return (bytes: number) => isAboveThreshold(bytes, user) && driveOn;
}

/** The same rule, for a caller weighing a single file. Both halves matter —
 *  see this file's header for why Drive is not an optimisation here but a
 *  condition. */
export async function shouldExternalise(
  bytes: number, user: { attachmentThresholdKb?: number },
): Promise<boolean> {
  if (!isAboveThreshold(bytes, user)) return false;   // no need to ask Drive
  return (await attachmentRule(user))(bytes);
}

/** The attachment to store for a file the user just attached — externalised or
 *  not, according to the rule. THE way to build a file attachment: the three
 *  places that produce one (the device picker, and the analyser's two clip
 *  extractions) all come through here, so the rule cannot be applied in two
 *  and a half places and drift.
 *
 *  Falling back to inline on any failure is deliberate. Whatever went wrong —
 *  no quota for the local row, a database that will not open — attaching the
 *  file must still work; the worst case is a big attachment in the blob, which
 *  is exactly what the app did until today. */
export async function attachmentFor(
  entry: FileEntry, user: { attachmentThresholdKb?: number },
): Promise<FileAttachment> {
  const bytes = Math.floor(entry.data.length * 3 / 4);
  if (!(await shouldExternalise(bytes, user))) return { type: 'file', ...entry };
  try { return await externaliseEntry(entry); }
  catch (e) {
    console.warn('[attachments] keeping ' + entry.name + ' in the blob — could not store it locally', e);
    return { type: 'file', ...entry };
  }
}

export function isExternal(f: ResolvableFile): f is ResolvableFile & { external: ExternalFile } {
  return !!f.external;
}

/** Moves `entry`'s bytes out of the blob: writes them to this device and
 *  returns the attachment to store, its `data` emptied.
 *
 *  Does NOT upload — the caller does that, and may fail at it: an attachment
 *  whose `driveFileId` is still absent is the upload backlog, deducible from
 *  the state itself rather than journalled (the shape that makes the analyser's
 *  audio backlog work). */
export async function externaliseEntry(entry: FileEntry): Promise<FileAttachment> {
  const blob = base64ToBlobLocal(entry.data, entry.mimeType);
  const external: ExternalFile = { id: generateId(), bytes: blob.size };
  // Reserved BEFORE the write, not after: the sweep only has to land between
  // the two for the protection to be worth nothing. A reservation whose write
  // then fails names no row and costs nothing.
  reserveUnfiled(external.id);
  await putAttachmentBlob(external.id, blob);
  return { type: 'file', name: entry.name, mimeType: entry.mimeType, data: '', external };
}

/** Bytes written to this device that the state does not name YET.
 *
 *  Every externalisation is two steps — write the blob, then mutate the state
 *  to point at it — and between them those bytes are referenced by nothing.
 *  Which is exactly what `sweepLocalAttachments` deletes. For one attached
 *  file the window is milliseconds; for `externaliseIncoming` it is a whole
 *  import, and for `applyConversion` it is the whole conversion, minutes
 *  included when files have to come down from Drive. A sweep landing in that
 *  window — the eight-second boot timer, or the storage panel opening because
 *  any other mutation re-rendered it — deleted the bytes, and the mutate that
 *  followed then pointed the attachments at nothing. Silently, and for good:
 *  `data` had just been emptied.
 *
 *  In memory on purpose. After a reload nothing is in flight any more, so
 *  bytes whose mutate never happened are collected by the next sweep instead
 *  of being protected for ever — the leak is bounded by one page lifetime,
 *  and it errs towards keeping someone's file. */
const _unfiled = new Set<string>();

function reserveUnfiled(id: string): void { _unfiled.add(id); }

/** Applies the rule to attachments arriving from OUTSIDE — an imported card
 *  package, a shared library — whose files are inline by construction, since
 *  that is the only shape a package travels in. Mutates them in place and
 *  returns the ones that moved out, for the caller to upload.
 *
 *  This is not the retroactive conversion that was deliberately refused: these
 *  attachments are being created here and now, exactly as the file picker
 *  creates one, so they go through the same constructor. What is already in
 *  the library stays where it is until the user asks otherwise.
 *
 *  Call it BEFORE the mutate that files the cards away. Bytes written for a
 *  card the import then skips as a duplicate are left for the local sweep,
 *  which is what it is for — nothing points at them, so nothing uploads them
 *  either. Not on THIS page's sweep, mind: they are reserved as unfiled until
 *  a reload clears the set (see `_unfiled`), which is the safe direction. */
export async function externaliseIncoming(
  cards: Iterable<Card>, user: { attachmentThresholdKb?: number },
): Promise<FileAttachment[]> {
  const moved: FileAttachment[] = [];
  for (const card of cards) {
    for (const att of card.content?.attachments ?? []) {
      if (att.type !== 'file' || att.external || !att.data) continue;
      // Built from the entry rather than replacing the attachment: a file
      // attachment carries more than the three fields of a FileEntry
      // (`preferredIndex`, `clipOf`, `generatedBy`…) and an import must not
      // quietly drop them.
      const built = await attachmentFor({ name: att.name, data: att.data, mimeType: att.mimeType }, user);
      if (!built.external) continue;
      att.external = built.external;
      att.data = '';
      moved.push(att);
    }
  }
  return moved;
}

/** `mutate`, for recipes that create cards or replace their files: every
 *  import, every refresh from a source, every migration between sources, the
 *  copy of a file. The rule is applied to what THIS recipe changed, and to
 *  nothing else:
 *
 *   - a file attachment it added inline — present after, absent from the same
 *     card before, compared on name and bytes — goes out if the rule says so,
 *     exactly as the file picker would have sent it;
 *   - an external file it dropped — named before, named by no card after — has
 *     its Drive copy condemned, exactly as deleting the attachment would.
 *
 *  Until 2026-10-01 each of those sites built its attachment inline whatever
 *  its size, and a refresh that replaced an externalised score left its Drive
 *  file behind for good. A dozen places, each of which would have had to
 *  remember two steps; this is the one place that does.
 *
 *  Scoped to the diff on purpose. Applied to the whole library it would be the
 *  retroactive conversion that was refused, and applied to a state that came
 *  from Drive it would rewrite what another device wrote — neither goes
 *  through here.
 *
 *  The two snapshots are taken INSIDE the recipe, where mutate is still
 *  synchronous: `appState.value` is the state before, `s` the one about to be
 *  committed, and no other write can land between them. Externalising then
 *  happens after the commit, anchored like applyConversion — a file edited or
 *  removed in the meantime is left alone. Between the two writes the new file
 *  sits inline, which is where it always sat before this existed. */
export async function mutateWithRule(recipe: (s: AppState) => void): Promise<void> {
  const { appState, mutate } = await storeModule();
  let before: AppState | undefined;
  let after: AppState | undefined;
  await mutate(s => { before = appState.value; recipe(s); after = s; });
  if (!before || !after) return;

  const externalIds = (st: AppState) => {
    const ids = new Set<string>();
    for (const { att } of externalFilesIn(Object.values(st.cards ?? {}))) ids.add(att.external.id);
    return ids;
  };
  const still = externalIds(after);
  for (const { att } of externalFilesIn(Object.values(before.cards ?? {}))) {
    if (!still.has(att.external.id)) void condemnAttachmentFile(att);
  }

  const belongsOut = await attachmentRule(after);
  const changes: PlannedChange[] = [];
  const uploads: FileAttachment[] = [];
  for (const [cardId, card] of Object.entries(after.cards ?? {})) {
    const atts = card.content?.attachments ?? [];
    const old = new Set((before.cards?.[cardId]?.content?.attachments ?? [])
      .flatMap(a => a.type === 'file' && !a.external ? [a.name + '\0' + a.data] : []));
    for (let index = 0; index < atts.length; index++) {
      const att = atts[index];
      if (!att || att.type !== 'file' || att.external || !att.data) continue;
      if (old.has(att.name + '\0' + att.data) || !belongsOut(inlineBytes(att))) continue;
      try {
        const built = await externaliseEntry({ name: att.name, data: att.data, mimeType: att.mimeType });
        if (!built.external) continue;
        changes.push({ cardId, index, name: att.name, data: att.data, external: built.external });
        uploads.push(built);
      } catch (e) {
        // No room for the local row: it stays inline, as attachmentFor keeps it.
        console.warn('[attachments] keeping ' + att.name + ' in the blob — could not store it locally', e);
      }
    }
  }
  if (changes.length === 0) return;
  const filed = new Set<string>();
  await mutate(s => {
    for (const ch of changes) {
      const att = s.cards[ch.cardId]?.content?.attachments?.[ch.index];
      if (!att || att.type !== 'file' || att.external || att.name !== ch.name || att.data !== ch.data) continue;
      att.data = '';
      att.external = ch.external;
      filed.add(ch.external!.id);
    }
  });
  for (const att of uploads) if (filed.has(att.external!.id)) uploadAttachmentSoon(att);
}

/** Why an attachment's bytes could not be produced. Three distinct situations,
 *  told apart by the state alone — no extra bookkeeping:
 *
 *   'not-uploaded' — no `driveFileId`: another device attached it and has not
 *                    sent it up yet. There is nothing to fetch; waiting is the
 *                    answer, and saying "connect to the internet" would be a
 *                    lie the user cannot act on.
 *   'offline'      — there is a file, we just cannot reach it right now.
 *   'gone'         — Drive answered 404. The file was deleted from the Drive
 *                    itself, which the user is entitled to do. */
export type MissingReason = 'not-uploaded' | 'offline' | 'gone';

/** Raised when the bytes are nowhere this device can get them. */
export class AttachmentNotHere extends Error {
  constructor(
    public readonly file: ResolvableFile & { external: ExternalFile },
    public readonly reason: MissingReason,
  ) { super('attachment_not_here:' + reason); }
}

/** The bytes, wherever they are: this device first, then Drive — and what came
 *  down is cached locally, so the next read (and the clip, and the player)
 *  costs nothing. Same shape as `fetchSyncedAudio` next door.
 *
 *  `interactive` is passed on to Drive: opening an attachment IS a user
 *  gesture, so it may legitimately raise a token window — unlike the
 *  background work, which never may (see driveService's token rules). */
export async function attachmentBlob(f: ResolvableFile, interactive = false): Promise<Blob> {
  if (!f.external) return base64ToBlobLocal(f.data, f.mimeType);
  const external = f.external;
  const typed = (b: Blob) =>
    // The stored Blob keeps whatever type it was written with; the attachment's
    // declared mimeType is the one the rest of the app agreed on (see the
    // container sniffing of 2026-09-18), so it wins.
    b.type === f.mimeType ? b : new Blob([b], { type: f.mimeType });

  const held = await getAttachmentBlob(external.id);
  if (held) return typed(held);

  const missing = (reason: MissingReason) =>
    new AttachmentNotHere(f as ResolvableFile & { external: ExternalFile }, reason);
  if (!external.driveFileId) throw missing('not-uploaded');

  let fetched: Blob | null;
  try {
    fetched = await (await driveModule()).downloadCompanionFile(external.driveFileId, interactive);
  } catch (e) {
    console.warn('[attachments] could not fetch ' + f.name + ' from Drive', e);
    throw missing('offline');
  }
  if (!fetched) throw missing('gone');
  // Cached under the SAME id, which is safe precisely because an id names one
  // immutable set of bytes: an edit elsewhere lands under a new id and misses
  // this row rather than being masked by it.
  try { await putAttachmentBlob(external.id, fetched); }
  catch (e) { console.warn('[attachments] fetched but could not cache ' + f.name, e); }
  return typed(fetched);
}

/** The attachment as the viewer and the players want it: a FileEntry whose
 *  `data` is filled, whatever it took to get there.
 *
 *  Re-encoding to base64 for a file that was kept out of the blob looks like
 *  undoing the work — it is not. What costs is holding those bytes in the state
 *  that is cloned on every mutation and serialised on every sync; a string that
 *  lives for as long as one modal is open is the same cost the app already paid
 *  on every single open, since `data` WAS base64. It keeps every branch of
 *  fileViewer, audioPlayer and pdfCanvas working unchanged, which is worth far
 *  more here than shaving one conversion. If a big file ever feels slow to
 *  open, the way out is to hand those three a Blob instead — not to put the
 *  bytes back in the blob. */
export async function hydratedEntry(f: ResolvableFile, interactive = false): Promise<FileEntry> {
  if (!f.external) return f;
  const blob = await attachmentBlob(f, interactive);
  return { name: f.name, mimeType: f.mimeType, data: await blobToBase64(blob) };
}

/** Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte file blows the
 *  argument limit — the same trap utils' arrayBufferToBase64 documents. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Stores edited content for an externalised attachment, under a **new id**.
 *
 *  The id names the BYTES, not the attachment — and editing makes new bytes.
 *  Reusing it would leave every OTHER device holding a local row under that
 *  same id, with no way to know it had gone stale: it would go on serving the
 *  old content for ever, since the whole point of the local row is that it is
 *  read without asking Drive anything. A new id simply misses on those devices,
 *  and they fetch, which is the behaviour we want and costs no bookkeeping — no
 *  revision counter, no checksum, no invalidation message.
 *
 *  The caller drops the old bytes once the new id is in the state (and, from
 *  phase 2, condemns the old Drive file). `driveFileId` is naturally absent
 *  here: these bytes have never been uploaded, which is what the upload
 *  backlog looks for. */
export async function replaceExternalBytes(
  f: ResolvableFile & { external: ExternalFile }, data: string,
): Promise<ExternalFile> {
  const blob = base64ToBlobLocal(data, f.mimeType);
  const external: ExternalFile = { id: generateId(), bytes: blob.size };
  // Same two-step as externaliseEntry, same window, same protection: these
  // bytes are the user's edit and nothing names them until the caller's mutate.
  reserveUnfiled(external.id);
  await putAttachmentBlob(external.id, blob);
  return external;
}

// ── Walking a library's externalised attachments ─────────────────────────────

interface ExternalHit {
  /** The card it hangs on. Carried along because a message about a file the
   *  user has to go and find says nothing useful without it. */
  card: Card;
  att: FileAttachment & { external: ExternalFile };
}

function externalFilesIn(cards: Iterable<Card>): ExternalHit[] {
  const out: ExternalHit[] = [];
  for (const card of cards) {
    for (const att of card.content?.attachments ?? []) {
      if (att.type === 'file' && att.external) {
        out.push({ card, att: att as FileAttachment & { external: ExternalFile } });
      }
    }
  }
  return out;
}

/** The same, over a whole state. */
function externalAttachments(user: AppState): ExternalHit[] {
  return externalFilesIn(Object.values(user.cards ?? {}));
}

/** What this library's externalised attachments weigh, read straight from the
 *  state: a figure that would otherwise be counted nowhere, since those bytes
 *  are in neither the blob nor the recordings. */
export function externalAttachmentBytes(user: AppState): number {
  let bytes = 0;
  for (const { att } of externalAttachments(user)) bytes += att.external.bytes;
  return bytes;
}


// ── Putting the bytes back, for an export ────────────────────────────────────
// An export that names an attachment without carrying its bytes is a file that
// points at somebody else's device. So every export resolves first — and what
// it cannot resolve is announced rather than quietly dropped: the .cdbf exists
// precisely because a backup that looked complete was not (2026-09-09).
//
// Resolution is interactive throughout: an export IS a user gesture, so
// raising a token window to fetch a file back is legitimate here, in a way it
// never is in the background passes further down.

/** A file an export could not put back together. */
export interface UnresolvedAttachment {
  /** The card's name, so the message can say where to look. */
  card: string;
  name: string;
  reason: MissingReason;
}

/** Asked before an export that cannot be complete; `true` writes it anyway.
 *
 *  A parameter rather than a call into the UI: no service here opens a modal,
 *  and passing it makes "what happens when bytes are missing" something each
 *  export states out loud rather than inherits. */
export type ExportGate = (missing: UnresolvedAttachment[]) => Promise<boolean>;

/** Whether a failure condemns the REST of the pass as well as this file.
 *
 *  'gone' and 'not-uploaded' are facts about ONE file: the next one may well
 *  be fine, so the walk carries on. 'offline' is a fact about the network or
 *  the token, and it is expensive to learn — a rejected token sends
 *  driveService asking for a new one, which waits a full OAUTH_TIMEOUT_MS
 *  before giving up, and `requestTokenOnce` clears itself afterwards so the
 *  next file starts its own sixty-second wait. Measured on 2026-09-28
 *  against a real Drive answering 401: exactly 60 s per attachment, three of
 *  them costing 180 s of a frozen button — a library of ten would freeze for
 *  ten minutes, and a threshold of zero over 1299 attachments for a day.
 *
 *  So the first 'offline' IS the answer. Everything still waiting is reported
 *  as unreachable without being asked, which is both the truth and instant. */
function pastRecovery(e: unknown): boolean {
  return e instanceof AttachmentNotHere && e.reason === 'offline';
}

function unresolved(hit: ExternalHit, e: unknown): UnresolvedAttachment {
  return {
    card: hit.card.name,
    name: hit.att.name,
    // Anything that is not one of the three known situations is reported as a
    // network failure: of the three it is the one the user can act on.
    reason: e instanceof AttachmentNotHere ? e.reason : 'offline',
  };
}

/** Puts every externalised attachment of `cards` back inline, IN PLACE — so
 *  the caller passes a copy, this being the state the app is still running on.
 *
 *  `external` is dropped as well as `data` refilled, which is the point: what
 *  comes out is a card in the shape every reader has always understood, so an
 *  older build, another person's device and the hand-crafted-file path all read
 *  it without having to know that externalisation exists. */
export async function inlineExternalAttachments(cards: Iterable<Card>): Promise<UnresolvedAttachment[]> {
  const missing: UnresolvedAttachment[] = [];
  const hits = externalFilesIn(cards);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    try {
      const entry = await hydratedEntry(hit.att, true);
      hit.att.data = entry.data;
      delete (hit.att as FileAttachment).external;
    } catch (e) {
      missing.push(unresolved(hit, e));
      // See pastRecovery: asking the next one costs another minute and
      // cannot succeed. The gate names them all just the same.
      if (pastRecovery(e)) {
        for (const rest of hits.slice(i + 1)) missing.push(unresolved(rest, e));
        break;
      }
    }
  }
  return missing;
}

/** The bytes of every externalised attachment of `cards`, by external id — for
 *  a format that carries them beside the state instead of inside it (.cdbf).
 *
 *  Keyed by id rather than by card: an id names one immutable set of bytes, so
 *  two references to it are one entry in the archive rather than two. */
export async function externalAttachmentBlobs(
  cards: Iterable<Card>,
): Promise<{ blobs: Map<string, Blob>; missing: UnresolvedAttachment[] }> {
  const blobs = new Map<string, Blob>();
  const missing: UnresolvedAttachment[] = [];
  const hits = externalFilesIn(cards);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    if (blobs.has(hit.att.external.id)) continue;
    try { blobs.set(hit.att.external.id, await attachmentBlob(hit.att, true)); }
    catch (e) {
      missing.push(unresolved(hit, e));
      if (pastRecovery(e)) {            // see pastRecovery
        for (const rest of hits.slice(i + 1)) {
          if (!blobs.has(rest.att.external.id)) missing.push(unresolved(rest, e));
        }
        break;
      }
    }
  }
  return { blobs, missing };
}

/** Writes an archive's attachment bytes onto this device, once the state that
 *  names them is in place.
 *
 *  Counted rather than thrown, exactly like restoreFullBackupAudio next door:
 *  the library is already restored by the time this runs, and one attachment
 *  that will not land must not read as the whole import having failed. */
export async function restoreExternalAttachments(
  blobs: Map<string, Blob>,
): Promise<{ ok: number; failed: number }> {
  let ok = 0, failed = 0;
  for (const [id, blob] of blobs) {
    try { await putAttachmentBlob(id, blob); ok++; }
    catch (e) { console.warn('[attachments] could not restore the bytes of ' + id, e); failed++; }
  }
  return { ok, failed };
}

// ── Getting the bytes up to Drive ────────────────────────────────────────────
// The backlog is not a list anyone keeps: it is every attachment in the state
// carrying `external` without a `driveFileId`, whose bytes this device holds.
// So it survives a crash, a refused token and a closed tab for free, and it
// cannot disagree with reality — the same property that makes the analyser's
// audio backlog reliable.

const ATTACHMENTS_DIR = 'attachments';

/** What has not reached Drive yet, and how much it weighs. */
export async function pendingAttachmentUploads(user: AppState): Promise<{ ids: string[]; bytes: number }> {
  const held = new Set(await heldAttachmentIds());
  const ids: string[] = [];
  let bytes = 0;
  for (const { att } of externalAttachments(user)) {
    if (att.external.driveFileId) continue;
    // Bytes we do not have are somebody else's job — this device cannot upload
    // what another one attached.
    if (!held.has(att.external.id)) continue;
    ids.push(att.external.id);
    bytes += att.external.bytes;
  }
  return { ids, bytes };
}

/** Uploads one attachment's bytes and writes the resulting file id into the
 *  state, found by `external.id` rather than by position: the list may have
 *  been reordered, and the card renamed, while this was in flight. */
/** Ids being uploaded right now.
 *
 *  `driveFileId` is only written when the upload RETURNS, so it cannot keep two
 *  attempts apart while one is in flight — and there are two callers who
 *  legitimately fire close together: the one that just attached the file, and
 *  the periodic backlog pass. Observed on 2026-09-24 against a real Drive: one
 *  attachment, two identical files uploaded, the second orphaned the moment
 *  the first won the write. The set closes that window.
 *
 *  The set is per tab; across tabs it is a Web Lock per file (2026-10-01). A
 *  lock alone would not do: each tab holds its own copy of the state, so the
 *  tab that waited still believes the file unsent once the other is done.
 *  Under the lock the SAVED state is read too, and a Drive id another tab got
 *  for these same bytes is adopted instead of uploading them again. */
const _uploading = new Set<string>();

export async function uploadAttachment(externalId: string, interactive = false): Promise<void> {
  if (_uploading.has(externalId)) return;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return uploadAttachmentHere(externalId, interactive);
  // ifAvailable: another tab is sending it this very moment, so leave it be —
  // this tab's next pass adopts the result from the saved state.
  await locks.request('cadence-upload-' + externalId, { ifAvailable: true }, async lock => {
    if (lock) await uploadAttachmentHere(externalId, interactive);
  });
}

/** The Drive id another tab already recorded for these bytes, if any. */
async function uploadedElsewhere(userId: string, externalId: string): Promise<string | undefined> {
  try {
    const saved = await (await (_db ??= once(() => import('../db'), () => { _db = null; }))).loadUser(userId);
    return saved ? externalAttachments(saved).find(x => x.att.external.id === externalId)?.att.external.driveFileId : undefined;
  } catch { return undefined; }
}

async function uploadAttachmentHere(externalId: string, interactive: boolean): Promise<void> {
  if (_uploading.has(externalId)) return;
  const { appState, mutate } = await storeModule();
  const found = externalAttachments(appState.value).find(x => x.att.external.id === externalId);
  if (!found || found.att.external.driveFileId) return;
  const adopted = await uploadedElsewhere(appState.value.id, externalId);
  if (adopted) {
    await mutate(s => {
      for (const card of Object.values(s.cards ?? {})) {
        for (const att of card.content?.attachments ?? []) {
          if (att.type === 'file' && att.external?.id === externalId) att.external.driveFileId = adopted;
        }
      }
    });
    return;
  }
  const blob = await getAttachmentBlob(externalId);
  if (!blob) return;

  _uploading.add(externalId);
  try {
    const drive = await driveModule();
    const folder = await drive.companionPathId([ATTACHMENTS_DIR], interactive);
    // Named after the file, so the Drive folder reads like a folder of files
    // rather than a wall of uuids. Nothing depends on the name — `driveFileId`
    // is the link — so two attachments may share one and it costs nothing.
    const driveFileId = await drive.uploadCompanionFileInto(folder, found.att.name, blob, interactive);

    await mutate(s => {
      for (const card of Object.values(s.cards ?? {})) {
        for (const att of card.content?.attachments ?? []) {
          if (att.type === 'file' && att.external?.id === externalId) att.external.driveFileId = driveFileId;
        }
      }
    });
  } finally {
    _uploading.delete(externalId);
  }
  // An edit's old version may have been waiting for exactly this.
  void purgeCondemnedFiles();
}

/** Sends whatever is waiting. Never interactive: this runs on its own. */
export async function uploadPendingAttachments(): Promise<{ ok: number; failed: number }> {
  const { appState } = await storeModule();
  const { ids } = await pendingAttachmentUploads(appState.value);
  let ok = 0, failed = 0;
  for (const id of ids) {
    try { await uploadAttachment(id, false); ok++; }
    catch (e) { failed++; console.warn('[attachments] upload of ' + id + ' failed', e); }
  }
  return { ok, failed };
}

// ── Applying the rule to a library that already exists ──────────────────────
// The rule decides where a file being attached NOW belongs. It is never
// applied behind the user's back to what is already there: raising the
// threshold converts nothing, and neither does connecting Drive (arbitrated
// 2026-09-23). This is the button that does it, on request — and it goes both
// ways, because "belongs outside the blob" and "belongs back inside it" are
// the same question answered by the same test.
//
// Coming back in matters as much as going out. A file that no longer meets
// the threshold, or one that is externalised on a device where Drive has been
// disconnected, sits outside the blob with nothing backing it up — the very
// situation the rule's Drive condition exists to prevent.

function inlineBytes(att: FileAttachment): number {
  return Math.floor(att.data.length * 3 / 4);
}

export interface ConversionPlan {
  /** Inline today, belongs outside the blob. */
  out: { count: number; bytes: number };
  /** Outside today, belongs back in. */
  back: { count: number; bytes: number };
}

/** What the rule would change, without changing anything. */
export async function conversionPlan(user: AppState): Promise<ConversionPlan> {
  const belongsOut = await attachmentRule(user);
  const out = { count: 0, bytes: 0 };
  const back = { count: 0, bytes: 0 };
  for (const card of Object.values(user.cards ?? {})) {
    for (const att of card.content?.attachments ?? []) {
      if (att.type !== 'file') continue;
      if (att.external) {
        if (belongsOut(att.external.bytes)) continue;
        back.count++; back.bytes += att.external.bytes;
      } else {
        const bytes = inlineBytes(att);
        if (!belongsOut(bytes)) continue;
        out.count++; out.bytes += bytes;
      }
    }
  }
  return { out, back };
}

/** One attachment's move, pinned to where it was found.
 *
 *  Position AND name, checked again at the moment of writing: this walk can
 *  take minutes when files have to come down from Drive, and a card edited
 *  meanwhile must not have a stranger's bytes written into it. A change whose
 *  anchor no longer matches is dropped rather than applied to whatever is
 *  there now. */
interface PlannedChange {
  cardId: string;
  index: number;
  name: string;
  external?: ExternalFile;
  data: string;
}

/** Applies the rule to every attachment of the current library.
 *
 *  Interactive: this runs off a button, so fetching bytes back from Drive may
 *  legitimately raise a token window. */
export async function applyConversion(): Promise<{ out: number; back: number; failed: number }> {
  const { appState, mutate } = await storeModule();
  const user = appState.value;
  const belongsOut = await attachmentRule(user);

  const changes: PlannedChange[] = [];
  const uploads: FileAttachment[] = [];
  /** Copied before the state loses the reference: once the bytes are back in
   *  the blob, nothing remembers which Drive file they came from. */
  const returned: FileAttachment[] = [];
  let failed = 0;

  /** Set by the first failure that condemns the rest of the pass too — see
   *  pastRecovery. Everything after it is counted as failed without being
   *  asked, which is what the user is told at the end. */
  let doomed = false;

  for (const [cardId, card] of Object.entries(user.cards ?? {})) {
    const atts = card.content?.attachments ?? [];
    for (let index = 0; index < atts.length; index++) {
      const att = atts[index];
      if (!att || att.type !== 'file') continue;
      if (doomed) {
        // Only the ones that would have needed Drive: an attachment going OUT
        // is written locally and never asks the network.
        if (att.external && !belongsOut(att.external.bytes)) failed++;
        continue;
      }
      try {
        if (att.external) {
          if (belongsOut(att.external.bytes)) continue;
          // The bytes have to be in hand before the reference is dropped —
          // the whole point of coming back in is that the blob carries them.
          const entry = await hydratedEntry(att, true);
          changes.push({ cardId, index, name: att.name, data: entry.data });
          returned.push(att);
        } else {
          if (!belongsOut(inlineBytes(att))) continue;
          const built = await externaliseEntry({ name: att.name, data: att.data, mimeType: att.mimeType });
          if (!built.external) continue;
          changes.push({ cardId, index, name: att.name, external: built.external, data: '' });
          uploads.push(built);
        }
      } catch (e) {
        failed++;
        console.warn('[attachments] could not convert ' + att.name, e);
        if (pastRecovery(e)) {
          doomed = true;
          console.warn('[attachments] Drive is unreachable — abandoning the rest of the conversion');
        }
      }
    }
  }

  if (changes.length > 0) {
    await mutate(s => {
      for (const ch of changes) {
        const att = s.cards[ch.cardId]?.content?.attachments?.[ch.index];
        if (!att || att.type !== 'file' || att.name !== ch.name) continue;
        att.data = ch.data;
        if (ch.external) att.external = ch.external;
        else delete att.external;
      }
    });
  }
  // What came home no longer has anything pointing at its Drive copy, so that
  // copy is condemned — exactly as an edit condemns the bytes it replaced.
  // Leaving it was the first instinct ("one trigger only for deleting a
  // companion file") and it was wrong in a way a single afternoon of use makes
  // obvious: every trip out and back leaves a full copy behind for ever, and
  // nothing but the 30-day orphan sweep would ever collect it.
  //
  // Safe for the same reason every other condemnation is: purgeCondemnedFiles
  // re-checks the live state before deleting, so a file that came back into
  // use in the meantime is spared.
  for (const back of returned) void condemnAttachmentFile(back);
  for (const att of uploads) uploadAttachmentSoon(att);

  return {
    out: changes.filter(c => c.external).length,
    back: changes.filter(c => !c.external).length,
    failed,
  };
}

// ── Freeing local space that Drive already holds ────────────────────────────

/** The externalised attachments this device holds a copy of AND whose Drive
 *  copy is proven. Anything without a `driveFileId` exists here and nowhere
 *  else in the world, so it is never offered.
 *
 *  Nor is anything a snapshot names WITHOUT a `driveFileId` (2026-10-01, found
 *  by the property test): a snapshot taken while the file waited in the upload
 *  backlog records no Drive id, and never will — it is a frozen state. The
 *  live state learning the id later proves the copy exists, not that the
 *  snapshot can find it; freed here, that snapshot would restore a card whose
 *  file reads "not uploaded yet" for ever, with the bytes sitting on Drive
 *  under an id nothing it holds can name. Snapshots unreadable: nothing is
 *  offered, the rule the sweep follows. */
export async function freeableAttachments(user: AppState): Promise<{ ids: string[]; bytes: number }> {
  const held = new Set(await heldAttachmentIds());
  let pinned: Set<string>;
  try { pinned = (await snapshotReferences(user.id)).withoutDriveId; }
  catch { return { ids: [], bytes: 0 }; }
  const seen = new Set<string>();
  const ids: string[] = [];
  let bytes = 0;
  for (const { att } of externalAttachments(user)) {
    const { id, driveFileId, bytes: size } = att.external;
    if (!driveFileId || !held.has(id) || seen.has(id) || pinned.has(id)) continue;
    seen.add(id);
    ids.push(id);
    bytes += size;
  }
  return { ids, bytes };
}

/** Frees them. Undone by opening the attachment, which downloads it again. */
export async function freeUploadedAttachments(user: AppState): Promise<{ count: number; bytes: number }> {
  const { ids } = await freeableAttachments(user);
  const sizes = new Map(externalAttachments(user).map(x => [x.att.external.id, x.att.external.bytes]));
  let count = 0, bytes = 0;
  for (const id of ids) {
    try { await deleteAttachmentBlob(id); count++; bytes += sizes.get(id) ?? 0; }
    catch (e) { console.warn('[attachments] could not free ' + id, e); }
  }
  return { count, bytes };
}

// ── Deleting, and the one journal this design needs ─────────────────────────

/** Marks an attachment's Drive file for deletion and tries straight away.
 *
 *  Recorded BEFORE trying: the attempt may fail, the tab may close, and after
 *  the attachment leaves the state nothing else remembers that a file out
 *  there is now pointless. Trying first and recording only on failure would
 *  lose exactly the cases that matter. */
export async function condemnAttachmentFile(att: Attachment | ResolvableFile, replacedBy?: string): Promise<void> {
  const external = 'external' in att ? att.external : undefined;
  if (!external?.driveFileId) return;
  try { await condemnDriveFile(external.driveFileId, external.id, replacedBy); }
  catch (e) { console.warn('[attachments] could not record a file deletion', e); }
  void purgeCondemnedFiles();
}

/** Deletes what is waiting to be deleted — on a schedule of its own, whenever
 *  Drive is reachable again.
 *
 *  Re-checks that nothing in the state points at the file before deleting it.
 *  That single check is what makes the order of writes irrelevant (record then
 *  mutate, or the reverse, both become safe) AND covers the case where a
 *  conflict resolution brought the attachment back between the condemnation
 *  and now.
 *
 *  And spares — without forgetting — every file a snapshot still names
 *  (2026-09-29). Until then the check stopped at the live state, which left one
 *  real way to gut a snapshot: free an attachment's local bytes (Storage →
 *  free space), then delete it. Its only copy was the Drive one, this deleted
 *  it, and restoring a snapshot from before handed back a card whose
 *  attachment existed nowhere. The row stays in the journal, so the file goes
 *  once the last snapshot naming it expires or is deleted.
 *
 *  Returns how many files are still waiting on DRIVE — the ones a snapshot
 *  holds are not: counted as pending, they would keep the token renewal asking
 *  for a token on every tap, for a month, to do nothing. */
export async function purgeCondemnedFiles(): Promise<number> {
  let rows;
  try { rows = await condemnedFiles(); } catch { return 0; }
  if (!rows.length) return 0;

  const { appState } = await storeModule();
  const live = new Set(
    externalAttachments(appState.value)
      .map(x => x.att.external.driveFileId)
      .filter((id): id is string => !!id),
  );
  let held: SnapshotReferences;
  try { held = await snapshotReferences(appState.value.id); }
  catch (e) {
    // Same rule as the local sweep: unable to read the net, delete nothing.
    console.warn('[attachments] skipping the Drive purge — snapshots unreadable', e);
    return rows.length;
  }

  // Edits whose new version has not reached Drive yet. Until it has, the old
  // copy is the only one any OTHER device can fetch — and, should this device
  // never manage the upload (lost, wiped), the only one left anywhere. An
  // online edit used to lose that race: the condemnation purged at once while
  // the new version was still on its way up (found 2026-10-01).
  const notYetUp = new Set(
    externalAttachments(appState.value).filter(x => !x.att.external.driveFileId).map(x => x.att.external.id),
  );
  const due: typeof rows = [];
  for (const row of rows) {
    if (live.has(row.driveFileId)) { await forgetCondemned(row.driveFileId); continue; }
    if (row.replacedBy && notYetUp.has(row.replacedBy)) continue;
    // Either id will do: a snapshot taken before the upload finished names
    // the attachment but not yet its Drive file.
    if (held.driveFileIds.has(row.driveFileId) || held.ids.has(row.attachmentId)) continue;
    due.push(row);
  }
  if (!due.length) return 0;
  const drive = await driveModule();
  if (!drive.isDriveConnected() || !drive.hasDriveToken()) return due.length;

  let left = 0;
  for (const row of due) {
    // Best-effort, like every companion deletion: a file that cannot be
    // removed right now stays an orphan in the user's own Drive, visible and
    // deletable by them — a far better failure than blocking anything here.
    if (await drive.deleteCompanionFile(row.driveFileId, false)) await forgetCondemned(row.driveFileId);
    else left++;
  }
  return left;
}

interface SnapshotReferences {
  ids: Set<string>;
  driveFileIds: Set<string>;
  /** Named by some snapshot that records no Drive copy: for that snapshot the
   *  local bytes are the only way back. */
  withoutDriveId: Set<string>;
}

/** Every external attachment `userId`'s snapshots name, by both of its ids.
 *  Throws when the snapshots cannot be read; the callers then delete nothing. */
async function snapshotReferences(userId: string): Promise<SnapshotReferences> {
  const { snapshotStates } = await (_snapshots ??= once(() => import('./snapshotService'), () => { _snapshots = null; }));
  const ids = new Set<string>();
  const driveFileIds = new Set<string>();
  const withoutDriveId = new Set<string>();
  for (const state of await snapshotStates(userId)) {
    for (const { att } of externalAttachments(state)) {
      ids.add(att.external.id);
      if (att.external.driveFileId) driveFileIds.add(att.external.driveFileId);
      else withoutDriveId.add(att.external.id);
    }
  }
  return { ids, driveFileIds, withoutDriveId };
}

/** Drops bytes this device holds for attachments nothing points at any more.
 *
 *  Safe in a way the Drive sweep is not: a local row can only have been
 *  written by THIS device, and the state carries the reference before the
 *  write even finishes — so "unreferenced here" is the truth, not a guess
 *  about what another device may be doing.
 *
 *  Snapshots count as references. They hold a STATE, not the bytes, so
 *  restoring one that names an id this swept away would hand back a card whose
 *  attachment is dead — and the snapshots are the app's only safety net. */
export async function sweepLocalAttachments(): Promise<number> {
  const { appState } = await storeModule();
  const referenced = new Set(externalAttachments(appState.value).map(x => x.att.external.id));
  try {
    // The strict reader, since 2026-09-29. The catch below never fired before:
    // listSnapshots and getSnapshotState answer a failure with an empty list
    // and a null, so an unreadable snapshot store read as "no snapshot" and
    // the sweep went ahead.
    for (const id of (await snapshotReferences(appState.value.id)).ids) referenced.add(id);
  } catch (e) {
    // Could not read the snapshots: delete nothing rather than risk gutting
    // one. An unused blob costs space; a broken snapshot costs the net.
    console.warn('[attachments] skipping the local sweep — snapshots unreadable', e);
    return 0;
  }
  let dropped = 0;
  for (const id of await heldAttachmentIds()) {
    // Filed away at last: it is the state's business now, not the reservation's.
    if (referenced.has(id)) { _unfiled.delete(id); continue; }
    // Written a moment ago by an externalisation whose mutate has not landed
    // yet — see _unfiled. Unreferenced, and not an orphan.
    if (_unfiled.has(id)) continue;
    try { await deleteAttachmentBlob(id); dropped++; } catch { /* next boot */ }
  }
  return dropped;
}

// ── Wiring it all to the app's lifecycle ────────────────────────────────────

/** Whether something is waiting for Drive. A hint, kept in memory because
 *  `DrivePendingWork.pending` must answer synchronously and the truth lives in
 *  IndexedDB: set whenever work is created or fails, cleared when a pass
 *  finds nothing left. Wrong in the harmless direction — a stale `true` costs
 *  one pass that finds nothing. */
let _pendingHint = false;
let _wired = false;

/** Called once per user, from the same place as initAttachmentDbForUser.
 *
 *  Three jobs, none of them interactive: resume uploads when a token comes
 *  back, delete what was condemned while offline, and drop local bytes nothing
 *  points at any more. The sweep is deferred — it reads every snapshot, and
 *  boot is not the moment to do that. */
export function initAttachmentSync(): void {
  _pendingHint = true;   // until a pass proves otherwise
  if (!_wired) {
    _wired = true;
    void driveModule().then(drive => {
      drive.registerDrivePendingWork({
        pending: () => _pendingHint,
        resume: () => { void runPendingAttachmentWork(); },
      });
      // Until 2026-10-01 the backlog only moved at the next launch or the next
      // token renewal: a file attached or edited offline sat on this device
      // alone, however soon the network came back. Both passes are
      // non-interactive, so without a token they simply wait as before.
      const resume = () => {
        if (_pendingHint && drive.isDriveConnected() && drive.hasDriveToken()) void runPendingAttachmentWork();
      };
      window.addEventListener('online', resume);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
    });
  }
  setTimeout(() => { void expireSnapshotsThenCollect(true); }, 8000);
  // Not only at boot: a tab or an installed app can stay open for weeks, and
  // a snapshot must be gone a month after it was taken, not a month after the
  // last launch. Hourly is plenty for a thirty-day limit, and costs one key
  // listing when nothing has expired.
  _expiryTimer ??= setInterval(() => { void expireSnapshotsThenCollect(false); }, 60 * 60 * 1000);
}

let _expiryTimer: ReturnType<typeof setInterval> | null = null;

/** Snapshots expire first, and here, because what they release is what the
 *  two passes after them are waiting on: the local bytes and the condemned
 *  Drive files only an expired snapshot still named. Here is also the only
 *  kind of place it may run — a user opened, never the recovery screen.
 *
 *  `always`: at boot the two passes run regardless, as they always have. On
 *  the hourly tick only when something expired — otherwise nothing changed
 *  that they could act on, and the sweep reads every snapshot. */
async function expireSnapshotsThenCollect(always: boolean): Promise<void> {
  try {
    const { appState } = await storeModule();
    const { pruneExpiredSnapshots } = await import('./snapshotService');
    const expired = await pruneExpiredSnapshots(appState.value.id);
    if (!always && expired === 0) return;
    void runPendingAttachmentWork();
    void sweepLocalAttachments().then(n => {
      if (n) console.info(`[attachments] freed ${n} local file(s) nothing referenced any more`);
    }).catch(() => {});
  } catch { /* next tick, or next launch */ }
}

async function runPendingAttachmentWork(): Promise<void> {
  try {
    const { failed } = await uploadPendingAttachments();
    const waiting = await purgeCondemnedFiles();
    const { appState } = await storeModule();
    const { ids } = await pendingAttachmentUploads(appState.value);
    _pendingHint = failed > 0 || ids.length > 0 || waiting > 0;
  } catch {
    _pendingHint = true;
  }
}

/** After a conflict settled in THIS device's favour: brings back to Drive the
 *  files that decision resurrected.
 *
 *  The case (measured 2026-10-01 against the real Drive): device A removes an
 *  attachment, which condemns and deletes its Drive file; device B, still on
 *  the older state, keeps its own side of the conflict. The attachment is back
 *  in the library, pointing at a Drive file that no longer exists — B can open
 *  it from its local copy, every other device reads "missing from Drive".
 *
 *  Only the attachments the discarded Drive state no longer had are looked at:
 *  those are the ones another device can have deleted, and asking Drive about
 *  every file of the library after every conflict would be a request per
 *  attachment for nothing. One that is gone and whose bytes are HERE is sent
 *  again under a new Drive id; one whose bytes are not here cannot be helped.
 *  Drive unreachable: nothing is concluded, nothing is touched. */
export async function reuploadResurrected(discarded: AppState): Promise<number> {
  const { appState, mutate } = await storeModule();
  const there = new Set(externalAttachments(discarded).map(x => x.att.external.id));
  const candidates = externalAttachments(appState.value)
    .filter(x => x.att.external.driveFileId && !there.has(x.att.external.id));
  if (candidates.length === 0) return 0;
  const drive = await driveModule();
  const held = new Set(await heldAttachmentIds());
  const resend = new Set<string>();
  for (const { att } of candidates) {
    let size: number | 'gone';
    try { size = await drive.companionFileSize(att.external.driveFileId!, false); }
    catch { return 0; }
    if (size === 'gone' && held.has(att.external.id)) resend.add(att.external.id);
  }
  if (resend.size === 0) return 0;
  await mutate(s => {
    for (const card of Object.values(s.cards ?? {})) {
      for (const a of card.content?.attachments ?? []) {
        if (a.type === 'file' && a.external && resend.has(a.external.id)) delete a.external.driveFileId;
      }
    }
  });
  for (const id of resend) {
    try { await uploadAttachment(id, false); }
    catch (e) { _pendingHint = true; console.warn('[attachments] re-upload of ' + id + ' left in the backlog', e); }
  }
  return resend.size;
}

/** Sends a freshly attached file up, without ever raising a token window: this
 *  runs off the back of an attachment being added, not of a button that asked
 *  for Drive. A failure just leaves it in the backlog. */
export function uploadAttachmentSoon(att: Attachment): void {
  if (att.type !== 'file' || !att.external || att.external.driveFileId) return;
  const id = att.external.id;
  void uploadAttachment(id, false).catch((e: unknown) => {
    _pendingHint = true;
    console.warn('[attachments] background upload failed, left in the backlog', e);
  });
}

/** Condemns the Drive copies of everything hanging off `cards`, for a whole
 *  card being deleted. Same act as removing one attachment, in bulk.
 *
 *  Nothing local is dropped here either — the sweep owns that, because it is
 *  the only thing that counts a snapshot as a reference. */
export async function condemnCardAttachments(cards: Iterable<Card>): Promise<void> {
  for (const { att } of externalFilesIn(cards)) await condemnAttachmentFile(att);
}

// There is deliberately no "forget this attachment's bytes" any more. It
// existed, and it was wrong: deleting an attachment dropped its local row at
// once, stepping straight over the protection sweepLocalAttachments is built
// on — a snapshot taken before the deletion still names those bytes, and
// restoring it has to give the file back. One owner for local deletion, and it
// is the one that reads the snapshots.

/** Local copy of utils' base64ToBlob, kept private here so this module does not
 *  drag the whole utils surface into the places that only resolve attachments. */
function base64ToBlobLocal(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}
