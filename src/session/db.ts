import { openDB, type IDBPDatabase } from 'idb';
import {
  TUNE_ANALYSER_MODULE_KEY,
  type Analysis, type SyncedAudio, type TuneAnalyserModuleData, type WindowResult,
} from './model';
import { generatedSessionName } from './sessionNaming';
import { editSessionTree, forgetSession } from './sessionTree';

// store.ts is imported lazily (dynamic import, below) rather than statically:
// it transitively pulls in services/driveService.ts, which reads
// `sessionStorage` at module-evaluation time (top-level, unconditional) —
// fine in a real browser, but it means a plain `import { appState, mutate }
// from '../store'` here would crash any test file that imports this module
// without ever calling one of the AppState-touching functions below, purely
// because sessionStorage doesn't exist in vitest's default (node) test
// environment. Deferring the import until one of those functions actually
// runs avoids that entirely, at effectively zero runtime cost in the browser
// (ES module imports are cached after the first resolution).
function storeModule(): Promise<typeof import('../store')> {
  return import('../store');
}

/** driveService is deferred for exactly the reason above — it is the module
 *  whose top-level `sessionStorage` read forced storeModule() to be lazy in the
 *  first place, so importing it statically here would reintroduce the very
 *  crash that comment describes. Only the companion-file helpers are used, and
 *  only from the audio paths far below. */
function driveModule(): Promise<typeof import('../services/driveService')> {
  return import('../services/driveService');
}

// ── Session-feature storage ───────────────────────────────────────────────────
// Three places (2026-08-26):
//  - `AppState.modules['tune-analyser']` (types.ts/model.ts): session METADATA
//    + annotations — small, meaningful to back up, so it lives on the synced
//    user blob (Drive, same as cards/decks) instead of its own database.
//  - `cadence-tune-analyser-local-user-{userId}` (one per local user): audio
//    blobs + crash-recovery scratch data (raw per-window results for an
//    in-progress live recording, MediaRecorder chunks) — genuinely local-only
//    (a crash can only be recovered on the device it happened on) and/or too
//    large to want synced, so this never touches AppState.
//  - `cadence-sessions` (one shared instance per device): just the KV store —
//    the (large) downloaded FolkFriend/TheSession tune index. Not personal
//    data, so it's kept shared across every local user rather than
//    re-downloaded per user.
//
// ── Why the storage says "session" and the rest of the app says "analysis" ────
// Deliberate, decided 2026-09-09. Read this before "fixing" any name below.
//
// The product vocabulary was settled that day and the UI and types follow it
// everywhere: an ANALYSIS is the persistent object; its AUDIO is the sound,
// optional and detachable; its DETECTIONS are the recognition results;
// ANALYSING is the process, RECORDING the act of acquiring sound. The word
// "session" was dropped outright — it names a real event in Irish music
// (players in a pub), and asserting that was false for an album, a concert or
// an imported file, which are exactly the same object here.
//
// The STORAGE KEYS were deliberately left behind: the databases and stores
// named just above, `TUNE_ANALYSER_MODULE_KEY`, `TuneAnalyserModuleData.
// sessions` and `Analysis.annotations`. Not an oversight, and not laziness —
// the two storage kinds each have their own reason.
//
// IndexedDB (local): a migration would be honest — versioned, transactional,
// one device, the `upgrade` hook already exists. The cost is the COPY. There is
// no rename API for a database or a store: you open the new one, copy every
// record, then delete the old. The per-user database holds the AUDIO, which
// runs to gigabytes, so the migration transiently doubles the footprint on a
// phone, against a quota that is entitled to refuse — and a refusal midway has
// to leave the original untouched. Real work, real failure mode, for a name.
//
// The synced blob (`sessions`, `annotations`): structurally worse, and this is
// the part that settles it. That blob is a SHARED MUTABLE DOCUMENT on Drive,
// and there is no instant at which every reader is upgraded — the service
// worker keeps its bundle, a device can sit on an old one for days. Device A,
// updated, migrates and writes `detections`; device B, not yet updated, reads
// the same file, finds no `annotations`, shows zero results — and writes back.
// The version/counter machinery from 2026-08-31 guards against two concurrent
// WRITERS, not against a reader that cannot understand the shape; it would
// reconcile the two happily. That is the exact silhouette of the data loss
// that machinery was built after.
//
// Doing it safely means the three-phase dance: ship "read both, write old",
// wait for the fleet, ship "read both, write new", then months later drop the
// old read. Three deploys during which the code carries BOTH names — less
// legible than the single frozen name it was meant to improve. (The project
// already pays that toll once: decideReconcile's transitional branch, due out
// around 2026-11-30.) A cosmetic gain does not buy that.
//
// So: the boundary is the disk. Above it the code says analysis/detection;
// at it and below, the keys say what they have always said. Do not "finish
// the job" — see the frozen-name comments in model.ts.
//
// Works in both window and worker contexts — kvGet/kvSet run inside the
// FolkFriend worker (ffWorker.ts → indexStore.ts), everything else runs on
// the main thread (liveSession.ts, importSession.ts, recovery.ts, …), which
// is required for the AppState-backed functions below (they read/write
// store.ts's appState signal, which only exists on the main thread).

const SHARED_DB_NAME    = 'cadence-sessions';
const SHARED_DB_VERSION = 1;
const KV_STORE = 'kv'; // tune index + metadata

const LOCAL_DB_VERSION = 1;
const DRAFT_STORE   = 'draft';   // session id → Analysis (status:'recording' only — see saveSessionMeta)
const AUDIO_STORE   = 'audio';   // session id → Blob
const WINDOWS_STORE = 'windows'; // session id → WindowResult[] (in-progress live recordings only)
const CHUNKS_STORE  = 'chunks';  // in-flight recording chunks (crash recovery)

// Object store names used by the two now-obsolete legacy shapes this module
// migrates away from — see migrateToFinalShape()'s doc.
const LEGACY_SESSIONS_STORE = 'sessions'; // meta (+ `:audio`/`:windows` suffixed keys) in one store

function localDbName(userId: string): string {
  return `cadence-tune-analyser-local-user-${userId}`;
}

function legacyPerUserDbName(userId: string): string {
  return `cadence-sessions-user-${userId}`;
}

/** Exported so callers that need to check for a user's local database without
 *  going through this module's own routing (main.ts's Recovery screen) can
 *  name it exactly the same way. */
export const userDbName = localDbName;

let _userId: string | null = null;
let _sharedDb: IDBPDatabase | null = null;
let _localDb: IDBPDatabase | null = null;

/** Must be called once the active local user is known (main.ts, alongside
 *  initDriveForUser) before anything in this module touches per-user data —
 *  everything below routes through whichever user was set here. Awaits the
 *  one-time legacy migration (see migrateToFinalShape()) so callers that
 *  await this are guaranteed session data is already in its final home
 *  before they do anything else — critical here, unlike most other init*
 *  calls in main.ts, because this one can involve genuinely irreplaceable
 *  user data (past recordings).
 *
 *  Never rejects because of the migration itself: migrateToFinalShape()
 *  already only deletes legacy data after successfully applying it
 *  elsewhere (so a failure never loses anything), but if it fails for some
 *  OTHER reason (a transient IndexedDB error, one genuinely corrupt legacy
 *  record, …) the right behavior is "skip migrating this time, let the user
 *  keep using the app" — not "block boot forever" (main.ts's caller awaits
 *  this before finishBoot, so a rejection here would dump every affected
 *  user onto the Recovery screen, every single time, until a developer
 *  intervenes). _userId is already set above by this point, so normal
 *  session usage (recording NEW sessions from here on) is unaffected either
 *  way — only the one-time backfill of old data is skipped. */
export async function initSessionDbForUser(userId: string): Promise<void> {
  if (_userId === userId) return;
  _userId = userId;
  // CLOSED, not merely dropped (2026-09-08). Letting the reference go left the
  // previous user's IndexedDB connection open for the life of the tab, and an
  // open connection makes `indexedDB.deleteDatabase` fire `onblocked` instead of
  // deleting — which is why removing a local user appeared to leave its
  // recordings behind even once deleteLocalSessionData was being called.
  _localDb?.close();
  _localDb = null; // force the next localDb() call to open the new user's database
  try {
    await migrateToFinalShape(userId);
  } catch (err) {
    console.error('session/db.ts: legacy session migration failed — skipping for this device/session, nothing was deleted:', err);
  }
}

/** The shared DB's schema version stays 1 forever, deliberately never
 *  bumped: this database is also opened from the FolkFriend worker thread (a
 *  separate JS context with its own copy of this module's state), and a
 *  version bump triggers a versionchange transaction that could race against
 *  the main thread's migration below — whichever side's upgrade transaction
 *  runs first would delete the legacy stores before the other side got a
 *  chance to read them. Never touching the schema at all sidesteps that race
 *  entirely: KV_STORE is created (existence-checked, not oldVersion-gated,
 *  so this is safe however/whenever the DB first came to exist) once and
 *  never altered again, and the legacy sessions store — on devices that
 *  still have it — is drained of its ROWS by migrateToFinalShape() below via
 *  a plain readwrite transaction (no schema change), never deleted as an
 *  object store. */
async function sharedDb(): Promise<IDBPDatabase> {
  if (_sharedDb) return _sharedDb;
  _sharedDb = await openDB(SHARED_DB_NAME, SHARED_DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(KV_STORE)) d.createObjectStore(KV_STORE);
    },
  });
  return _sharedDb;
}

async function localDb(): Promise<IDBPDatabase> {
  if (!_userId) throw new Error('session/db.ts: initSessionDbForUser() not called yet');
  if (_localDb) return _localDb;
  _localDb = await openDB(localDbName(_userId), LOCAL_DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(DRAFT_STORE);
      db.createObjectStore(AUDIO_STORE);
      db.createObjectStore(WINDOWS_STORE);
      db.createObjectStore(CHUNKS_STORE, { autoIncrement: true });
    },
  });
  return _localDb;
}

/** Sessions saved before the `source` field existed were all mic recordings.
 *
 *  The name is backfilled here too, for sessions recorded when it was derived at
 *  display time and so could legitimately be empty. Doing it at the single point
 *  every read passes through is what lets everything downstream simply print
 *  `session.name` — see sessionNaming.ts. Recovery-finalized drafts arrive here
 *  the same way. */
function migrateSession(s: Analysis | undefined): Analysis | undefined {
  if (!s) return s;
  if (s.source === undefined) s.source = 'live';
  if (!s.name) s.name = generatedSessionName(s.source, s.date);
  return s;
}

/** One-time migration onto the current (2026-08-26) storage shape, run once
 *  per user on this device. Two earlier shapes are recognized and merged in:
 *   1. The very first version of this feature: ALL users' sessions mixed
 *      together, unscoped, in the shared `cadence-sessions` database's
 *      LEGACY_SESSIONS_STORE/CHUNKS_STORE (2026-08-26 bug fix). Whichever
 *      local user's Cadence loads first after that fix claims everything
 *      still sitting there — old sessions carry no owner information at all,
 *      so per-session attribution isn't recoverable; this mirrors the
 *      "first to load wins" migration that fix already established.
 *   2. The immediate predecessor of the current shape: a per-user database
 *      (`cadence-sessions-user-{userId}`) holding metadata AND audio
 *      together — correctly scoped per user already, just not yet split
 *      into "small, synced" vs "large, local-only".
 *
 *  Ordering is deliberately READ everything → APPLY everything → only THEN
 *  delete the legacy sources. An earlier version of this deleted each legacy
 *  source as soon as it had been read into memory, before the apply step
 *  (writing to AppState.modules / the new local DB) had actually run — so
 *  any failure during apply (a mutate() error, a quota-exceeded write, …)
 *  would permanently lose whatever had already been read out and deleted,
 *  since it only ever existed in a local variable that was about to be
 *  discarded by the very exception it was ever going to be caught by. With
 *  deletion moved to the very end, a failure anywhere before it leaves BOTH
 *  legacy sources completely untouched — worst case, migration is simply
 *  retried (safely — every apply below is idempotent) on the next boot,
 *  never data loss.
 *
 *  The whole function is also wrapped in a top-level try/catch (see
 *  initSessionDbForUser) so that a migration failure degrades to "skip
 *  migration this time, boot normally" rather than blocking the user out of
 *  their whole app — critical for e.g. one genuinely corrupt legacy record
 *  that would otherwise fail on every single retry forever.
 *
 *  A device with neither legacy shape (a genuinely new user, or one already
 *  migrated) resolves almost instantly — a couple of existence checks and
 *  nothing more to do. */
async function migrateToFinalShape(userId: string): Promise<void> {
  const migratedMeta: Record<string, Analysis> = {};   // finalized → AppState.modules
  const migratedDrafts: Record<string, Analysis> = {}; // status:'recording' → local DRAFT_STORE, never AppState
  const migratedAudio: Array<[string, Blob]> = [];
  const migratedWindows: Array<[string, WindowResult[]]> = [];
  const migratedChunks: unknown[] = [];

  const sortMetaRow = (k: string, v: Analysis) => {
    if (v.status === 'recording') migratedDrafts[k] = v;
    else                           migratedMeta[k] = v;
  };

  // ── Read source 2: the per-user database, if this device has one ─────────
  const perUserName = legacyPerUserDbName(userId);
  const perUserExists = indexedDB.databases ? (await indexedDB.databases()).some(d => d.name === perUserName) : true;
  let perUserHadData = false;
  if (perUserExists) {
    const perUser = await openDB(perUserName);
    try {
      if (perUser.objectStoreNames.contains(LEGACY_SESSIONS_STORE)) {
        const keys   = (await perUser.getAllKeys(LEGACY_SESSIONS_STORE)) as string[];
        const values = await perUser.getAll(LEGACY_SESSIONS_STORE);
        if (keys.length > 0) perUserHadData = true;
        keys.forEach((k, i) => {
          if (k.endsWith(':audio'))        migratedAudio.push([k.slice(0, -':audio'.length), values[i] as Blob]);
          else if (k.endsWith(':windows')) migratedWindows.push([k.slice(0, -':windows'.length), values[i] as WindowResult[]]);
          else                              sortMetaRow(k, values[i] as Analysis);
        });
      }
      if (perUser.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunks = await perUser.getAll(CHUNKS_STORE);
        if (chunks.length > 0) perUserHadData = true;
        migratedChunks.push(...chunks);
      }
    } finally {
      perUser.close();
    }
  }

  // ── Read source 1: the original shared-for-everyone store ────────────────
  const shared = await sharedDb();
  let sharedKeysToDelete: string[] = [];
  let sharedHadChunks = false;
  if (shared.objectStoreNames.contains(LEGACY_SESSIONS_STORE)) {
    const keys   = (await shared.getAllKeys(LEGACY_SESSIONS_STORE)) as string[];
    const values = await shared.getAll(LEGACY_SESSIONS_STORE);
    sharedKeysToDelete = keys;
    keys.forEach((k, i) => {
      if (k.endsWith(':audio'))        migratedAudio.push([k.slice(0, -':audio'.length), values[i] as Blob]);
      else if (k.endsWith(':windows')) migratedWindows.push([k.slice(0, -':windows'.length), values[i] as WindowResult[]]);
      else                              sortMetaRow(k, values[i] as Analysis);
    });
  }
  if (shared.objectStoreNames.contains(CHUNKS_STORE)) {
    const chunks = await shared.getAll(CHUNKS_STORE);
    if (chunks.length > 0) { sharedHadChunks = true; migratedChunks.push(...chunks); }
  }

  if (Object.keys(migratedMeta).length === 0 && Object.keys(migratedDrafts).length === 0
      && migratedAudio.length === 0 && migratedWindows.length === 0 && migratedChunks.length === 0) {
    return; // nothing found in either legacy shape — already migrated, or never had sessions
  }

  // ── Apply: finalized metadata → AppState.modules (one write) ─────────────
  if (Object.keys(migratedMeta).length > 0) {
    const { mutate } = await storeModule();
    await mutate(user => {
      const existing = (user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined)?.sessions ?? {};
      user.modules ??= {};
      user.modules[TUNE_ANALYSER_MODULE_KEY] = {
        sessions: {
          ...Object.fromEntries(Object.entries(migratedMeta).map(([k, v]) => [k, migrateSession(v)!])),
          ...existing, // already-live data (written through the new path) wins on any overlap
        },
      } satisfies TuneAnalyserModuleData;
    });
  }
  // ── Apply: drafts + audio + windows + chunks → local DB only ─────────────
  // A migrated draft (status:'recording') left over from an old device state
  // is by definition an orphan from a crash/refresh that happened before this
  // migration ever ran — recoverOrphanedSessions() (recovery.ts) picks it up
  // from DRAFT_STORE via listDraftSessions() on the very next library load,
  // same as any other orphan, and promotes it into AppState once finalized.
  if (Object.keys(migratedDrafts).length + migratedAudio.length + migratedWindows.length + migratedChunks.length > 0) {
    const d = await localDb();
    const tx = d.transaction([DRAFT_STORE, AUDIO_STORE, WINDOWS_STORE, CHUNKS_STORE], 'readwrite');
    for (const [k, v] of Object.entries(migratedDrafts)) void tx.objectStore(DRAFT_STORE).put(v, k);
    for (const [id, blob] of migratedAudio) void tx.objectStore(AUDIO_STORE).put(blob, id);
    for (const [id, w] of migratedWindows) void tx.objectStore(WINDOWS_STORE).put(w, id);
    for (const c of migratedChunks) void tx.objectStore(CHUNKS_STORE).add(c);
    await tx.done;
  }

  // ── Only now, with everything safely applied, clear the legacy sources ───
  if (sharedKeysToDelete.length > 0) {
    const tx = shared.transaction(LEGACY_SESSIONS_STORE, 'readwrite');
    for (const k of sharedKeysToDelete) void tx.store.delete(k);
    await tx.done;
  }
  if (sharedHadChunks) await shared.clear(CHUNKS_STORE);
  if (perUserExists && perUserHadData) {
    // Fully obsolete once migrated — nothing will ever read this name again
    // (unlike the shared DB above, which stays alive for the KV store).
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(perUserName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve(); // best-effort cleanup — migration itself already succeeded above
      req.onblocked = () => resolve();
    });
  }
}

/** Every playable audio this user's local DB holds, for the recovery screen's
 *  zip download: finalized/imported audio (AUDIO_STORE) plus any orphaned
 *  in-flight recording reassembled from its chunks — the "app crashed
 *  mid-session and won't boot any more" case is exactly what recovery exists
 *  for. Same read-only raw-IDB discipline as dumpUserSessionDatabase: never
 *  goes through the idb layer (it may be what's broken), never creates a
 *  database that isn't there. Draft names ride along so the caller can name
 *  files without touching AppState. */
export async function collectUserSessionAudio(userId: string): Promise<{
  audio: Array<{ sessionId: string; blob: Blob }>;
  orphans: Array<{ recordingId: string; blob: Blob }>;
  draftNames: Record<string, string>;
  draftMimes: Record<string, string>;
} | null> {
  const name = localDbName(userId);
  if (indexedDB.databases) {
    const all = await indexedDB.databases();
    if (!all.some(d => d.name === name)) return null;
  }
  const raw = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexeddb_blocked'));
  });
  try {
    const stores = new Set(Array.from(raw.objectStoreNames));
    const audio: Array<{ sessionId: string; blob: Blob }> = [];
    if (stores.has(AUDIO_STORE)) {
      for (const { key, value } of await dumpRawStore(raw, AUDIO_STORE)) {
        if (value instanceof Blob && value.size > 0) audio.push({ sessionId: String(key), blob: value });
      }
    }
    const haveAudio = new Set(audio.map(a => a.sessionId));
    const orphans: Array<{ recordingId: string; blob: Blob }> = [];
    if (stores.has(CHUNKS_STORE)) {
      const bySession = new Map<string, Array<{ seq: number; blob: Blob }>>();
      for (const { value } of await dumpRawStore(raw, CHUNKS_STORE)) {
        const c = value as { recordingId?: string; seq?: number; blob?: Blob };
        if (!c?.recordingId || !(c.blob instanceof Blob)) continue;
        if (!bySession.has(c.recordingId)) bySession.set(c.recordingId, []);
        bySession.get(c.recordingId)!.push({ seq: c.seq ?? 0, blob: c.blob });
      }
      for (const [recordingId, chunks] of bySession) {
        // A recording whose audio was already finalized doesn't need its chunks.
        if (haveAudio.has(recordingId)) continue;
        chunks.sort((a, b) => a.seq - b.seq);
        const blob = new Blob(chunks.map(c => c.blob), { type: chunks[0]!.blob.type });
        if (blob.size > 0) orphans.push({ recordingId, blob });
      }
    }
    const draftNames: Record<string, string> = {};
    const draftMimes: Record<string, string> = {};
    if (stores.has(DRAFT_STORE)) {
      for (const { key, value } of await dumpRawStore(raw, DRAFT_STORE)) {
        const d = value as { name?: string; mimeType?: string };
        if (d?.name) draftNames[String(key)] = d.name;
        if (d?.mimeType) draftMimes[String(key)] = d.mimeType;
      }
    }
    return { audio, orphans, draftNames, draftMimes };
  } finally {
    raw.close();
  }
}

function dumpRawStore(db: IDBDatabase, storeName: string): Promise<Array<{ key: unknown; value: unknown }>> {
  return new Promise((resolve, reject) => {
    const entries: Array<{ key: unknown; value: unknown }> = [];
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(entries); return; }
      entries.push({ key: cursor.key, value: cursor.value });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ── KV (tune index cache) ─────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await sharedDb()).get(KV_STORE, key);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await sharedDb()).put(KV_STORE, value, key);
}

// ── Recorded sessions (metadata — lives on AppState, see module doc) ──────────

async function moduleData(): Promise<TuneAnalyserModuleData> {
  const { appState } = await storeModule();
  return (appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined) ?? { sessions: {} };
}

/** A draft (status:'recording') is written locally ONLY, never to AppState:
 *  liveSession.ts's persistDraft() calls this on every analysis window while
 *  a tune is being actively tracked (~every ANALYSIS_HOP_S seconds, see
 *  sessionConfig.ts) — routing that through AppState (structuredClone +
 *  IndexedDB write of the WHOLE user blob + a Drive-sync schedule) on every
 *  single window would be a real performance cost for anyone with a
 *  non-trivial card library, for data that isn't even final yet. Only once a
 *  session is actually finalized (status absent/'done' — a clean stop() or a
 *  recovery.ts crash-recovery finalize) does it get "promoted" into the
 *  synced AppState.modules, and any local draft row for it is cleared. */
export async function saveSessionMeta(session: Analysis): Promise<void> {
  if (session.status === 'recording') {
    await (await localDb()).put(DRAFT_STORE, session, session.id);
    return;
  }
  const { mutate } = await storeModule();
  await mutate(user => {
    user.modules ??= {};
    const mod = (user.modules[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined) ?? { sessions: {} };
    mod.sessions[session.id] = session;
    user.modules[TUNE_ANALYSER_MODULE_KEY] = mod;
  });
  await (await localDb()).delete(DRAFT_STORE, session.id); // superseded by the finalized copy above
}

export async function loadSessionMeta(sessionId: string): Promise<Analysis | undefined> {
  const finalized = (await moduleData()).sessions[sessionId];
  if (finalized) return migrateSession(finalized);
  return migrateSession(await (await localDb()).get(DRAFT_STORE, sessionId));
}

export async function deleteSession(sessionId: string): Promise<void> {
  // Its Drive copy first, while the record pointing at it still exists — the
  // reverse order loses the file id and leaves the file orphaned in the user's
  // Drive with nothing left to trace it back. Best-effort by design: a delete
  // that cannot reach Drive right now must not stop the session from going.
  await dropSyncedAudio(sessionId);
  const { mutate } = await storeModule();
  await mutate(user => {
    const mod = user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
    if (mod) delete mod.sessions[sessionId];
    // Tidiness only — every read of the tree already filters against the real
    // list of analyses (sessionTree.ts), so a stale id breaks nothing. It is
    // dropped here simply so the synced blob does not collect them.
    editSessionTree(user, tree => forgetSession(tree, sessionId));
  });
  const d = await localDb();
  await d.delete(DRAFT_STORE, sessionId);
  await d.delete(AUDIO_STORE, sessionId);
  await d.delete(WINDOWS_STORE, sessionId);
}

/** Finalized sessions only (what the library shows) — see saveSessionMeta's
 *  doc for why an in-progress draft never shows up here. */
export async function listSessions(): Promise<Analysis[]> {
  const sessions = Object.values((await moduleData()).sessions).map(s => migrateSession(s)!);
  return sessions.sort(compareSessionsForLibrary);
}

/** Library order: dated sessions first, most recent first; undated ones (imports
 *  whose date the user never set) after them, alphabetically.
 *
 *  Undated used to sort FIRST, on the grounds that a fresh import is the current
 *  work. Reversed on request (2026-09-08), and the old argument no longer holds
 *  anyway: finishing an import navigates straight to that session's summary, so
 *  it is never something that has to be found in this list. Chronological order
 *  is what a library of thirty recordings needs.
 *
 *  Exported for its test — it is the one piece of listSessions that has a rule
 *  worth stating, and the rest of that function needs a store to run at all. */
export function compareSessionsForLibrary(a: Analysis, b: Analysis): number {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return (a.name || '').localeCompare(b.name || '');
}

/** In-progress recording drafts (status:'recording') — used exclusively by
 *  recovery.ts to find orphans left behind by a crash/refresh; never shown
 *  directly in the library (see saveSessionMeta's doc). */
export async function listDraftSessions(): Promise<Analysis[]> {
  const sessions = await (await localDb()).getAll(DRAFT_STORE) as Analysis[];
  return sessions.map(s => migrateSession(s)!);
}

// ── Session audio ─────────────────────────────────────────────────────────────
// The recording always lives in this device's local database. It may ALSO have
// been copied to the user's Drive as a file of its own (model.ts's SyncedAudio),
// which is what makes it playable on their other devices.
//
// The two are not alternatives, they are a cache and a durable copy: uploading
// never removes the local blob, and downloading on another device stores one.
// So no step below can leave a recording existing nowhere, which is the property
// that really matters here — sessions are irreplaceable.
//
// Downloads are never automatic. A recording is tens of megabytes and opening a
// session summary must not spend them; the UI offers the download and this
// module performs it (fetchSyncedAudio), rather than loadSessionAudio quietly
// reaching for the network.

/** Whether this session's recording is on Drive as well as on this device. */
export async function isSessionAudioSynced(sessionId: string): Promise<boolean> {
  return !!(await moduleData()).syncedAudio?.[sessionId];
}

export async function syncedAudioOf(sessionId: string): Promise<SyncedAudio | undefined> {
  return (await moduleData()).syncedAudio?.[sessionId];
}

/** Whether newly saved sessions get copied to Drive. Defaults to ON since
 *  2026-09-09.
 *
 *  It defaulted to off until a user lost every recording on their phone: the
 *  browser is entitled to evict a site's storage wholesale, and the local copy
 *  is the ONLY copy of a recording — the synced blob carries the analysis, never
 *  the sound. Off by default meant the app quietly held the sole copy of the
 *  thing it exists to produce. Costs nothing when Drive is not connected: the
 *  upload simply fails and is logged, the recording stays on the device. */
/** The value an absent flag means. Exported because the settings checkbox
 *  reads the stored field directly — it renders from the module data it
 *  already has rather than awaiting this accessor — and the two disagreeing
 *  would show an unchecked box while every recording uploaded. */
export const SYNC_AUDIO_BY_DEFAULT = true;

export async function syncAudioByDefault(): Promise<boolean> {
  return (await moduleData()).syncAudioByDefault ?? SYNC_AUDIO_BY_DEFAULT;
}

export async function setSyncAudioByDefault(on: boolean): Promise<void> {
  const { mutate } = await storeModule();
  await mutate(user => {
    user.modules ??= {};
    const mod = (user.modules[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined) ?? { sessions: {} };
    // Both values are written, unlike everywhere else in this codebase where
    // absence is the default. It has to be: the default is now ON, so deleting
    // the key on "off" would store the opposite of what the user just asked
    // for, and their choice would be undone at the next read.
    mod.syncAudioByDefault = on;
    user.modules[TUNE_ANALYSER_MODULE_KEY] = mod;
  });
}

async function recordSyncedAudio(sessionId: string, entry: SyncedAudio): Promise<void> {
  const { mutate } = await storeModule();
  await mutate(user => {
    user.modules ??= {};
    const mod = (user.modules[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined) ?? { sessions: {} };
    mod.syncedAudio ??= {};
    mod.syncedAudio[sessionId] = entry;
    user.modules[TUNE_ANALYSER_MODULE_KEY] = mod;
  });
}

/** Drops the Drive record, and the Drive file with it unless `fileAlreadyGone`
 *  — which is the 404 case, where deleting it again would be noise. */
async function dropSyncedAudio(sessionId: string, fileAlreadyGone = false): Promise<void> {
  const entry = await syncedAudioOf(sessionId);
  if (!entry) return;
  if (!fileAlreadyGone) await (await driveModule()).deleteCompanionFile(entry.fileId);
  const { mutate } = await storeModule();
  await mutate(user => {
    const mod = user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
    if (mod?.syncedAudio) {
      delete mod.syncedAudio[sessionId];
      if (Object.keys(mod.syncedAudio).length === 0) delete mod.syncedAudio;
    }
  });
}

function audioExtensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'webm';
}

/** Name a recording carries on Drive. The session id is in it so that someone
 *  browsing their own Drive can tell two recordings apart, and so an orphan left
 *  behind by a delete that failed offline can still be traced back. */
function companionName(sessionId: string, mimeType: string): string {
  return `cadence-session-${sessionId}.${audioExtensionFor(mimeType)}`;
}

/** Writes the recording to this device. `sync` additionally copies it to Drive;
 *  omitted, the user's standing preference decides.
 *
 *  The local write is awaited; the upload is NOT, because it can take minutes
 *  for a long recording on a phone connection and stopping a session would
 *  appear to hang. Callers that need to know how the upload went — the summary's
 *  own toggle — call uploadSessionAudio directly and await that. */
export async function saveSessionAudio(sessionId: string, audio: Blob, sync?: boolean): Promise<void> {
  await (await localDb()).put(AUDIO_STORE, audio, sessionId);
  // Usage just moved by however long the session was — tens or hundreds of
  // megabytes. Re-read it so the header's capacity warning reflects reality
  // now rather than at the next launch, which is a whole evening too late.
  void (await import('../services/storageService')).refreshStorageEstimate();
  const wantSync = sync ?? await syncAudioByDefault();
  if (!wantSync) return;
  // Never interactive: this runs on its own after a recording is saved, and a
  // consent window raised by something the user did not just click is the
  // behaviour the Drive work spent so long removing.
  void uploadSessionAudio(sessionId, false).catch((e: unknown) => {
    // Nothing is lost: the recording is on this device, and the summary offers
    // the upload again whenever the user wants it.
    console.warn('[sessions] background upload of the recording failed:', e);
  });
}

/** Copies this session's recording to Drive. Resolves once the file is there and
 *  recorded; rejects on any failure, having changed nothing.
 *
 *  `interactive` may raise a consent window, so it is true only when a click led
 *  here — see driveService's getToken. */
export async function uploadSessionAudio(sessionId: string, interactive = true): Promise<void> {
  if (await isSessionAudioSynced(sessionId)) return;
  const audio = await (await localDb()).get(AUDIO_STORE, sessionId) as Blob | undefined;
  if (!audio) throw new Error('no_local_audio');
  const meta = await loadSessionMeta(sessionId);
  const mimeType = audio.type || meta?.mimeType || 'audio/webm';
  const fileId = await (await driveModule())
    .uploadCompanionFile(companionName(sessionId, mimeType), audio, interactive);
  await recordSyncedAudio(sessionId, { fileId, mimeType, bytes: audio.size });
}

/** The recordings this device holds that are NOT on Drive.
 *
 *  Exists because `syncAudioByDefault` only ever applied to sessions saved
 *  after it was switched on. A user who turned it on reasonably expected their
 *  library to follow, found it had not, and reported the sync as broken
 *  (2026-09-10) — it was working exactly as written, which is its own kind of
 *  bug. Nothing else in the app could see, let alone fix, that backlog.
 *
 *  Keyed off the sessions the module knows about rather than off the audio
 *  store: a blob left behind by a deleted session is an orphan, and uploading
 *  orphans to someone's Drive is not a favour. */
export async function pendingAudioUploads(): Promise<{ ids: string[]; bytes: number }> {
  const mod = await moduleData();
  const synced = mod.syncedAudio ?? {};
  const db = await localDb();
  const ids: string[] = [];
  let bytes = 0;
  for (const id of Object.keys(mod.sessions ?? {})) {
    if (synced[id]) continue;
    const blob = await db.get(AUDIO_STORE, id) as Blob | undefined;
    if (!blob) continue;   // recorded elsewhere, or the audio was freed here
    ids.push(id);
    bytes += blob.size;
  }
  return { ids, bytes };
}

/** Uploads that backlog, one at a time, reporting progress.
 *
 *  Sequential on purpose: these are tens of megabytes each on a phone
 *  connection, and a parallel burst would compete with itself and with
 *  whatever else the app is doing. Failures are counted rather than thrown —
 *  one recording that will not upload must not abandon the twenty after it,
 *  and every one of them stays on the device either way. */
export async function uploadPendingAudio(
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; failed: number }> {
  const { ids } = await pendingAudioUploads();
  let ok = 0, failed = 0;
  for (const [i, id] of ids.entries()) {
    try {
      // Only the first may raise a consent window: it is the one the click
      // paid for. After that the token is in hand, and a popup per recording
      // would be indefensible.
      await uploadSessionAudio(id, i === 0);
      ok++;
    } catch (e) {
      console.warn('[sessions] backlog upload failed for ' + id, e);
      failed++;
    }
    onProgress?.(i + 1, ids.length);
  }
  return { ok, failed };
}

/** Deletes the Drive copy, leaving this device's untouched. */
export async function unsyncSessionAudio(sessionId: string): Promise<void> {
  await dropSyncedAudio(sessionId);
}

/** The recording as held on THIS device. Never reaches for the network — see
 *  this section's header. */
export async function loadSessionAudio(sessionId: string): Promise<Blob | undefined> {
  return (await localDb()).get(AUDIO_STORE, sessionId);
}

/** Downloads a recording this device does not have, and caches it locally so the
 *  next playback — and any clip extracted from it — costs nothing.
 *
 *  Returns null when the Drive file is gone: the user may have deleted it from
 *  their own Drive, which is their right. The record is dropped in that case
 *  rather than left pointing at nothing, so the UI stops offering a download
 *  that cannot work. */
export async function fetchSyncedAudio(sessionId: string): Promise<Blob | null> {
  const entry = await syncedAudioOf(sessionId);
  if (!entry) return null;
  const blob = await (await driveModule()).downloadCompanionFile(entry.fileId, true);
  if (!blob) {
    await dropSyncedAudio(sessionId, true);
    return null;
  }
  // Drive can hand back a generic content type; keep the one that was recorded
  // so the <audio> element and the clip decoder get what they expect.
  const typed = blob.type ? blob : new Blob([blob], { type: entry.mimeType });
  await (await localDb()).put(AUDIO_STORE, typed, sessionId);
  return typed;
}

/** Storage-saving: frees THIS device's copy, keeping metadata + annotations.
 *
 *  Local only, deliberately — the two controls divide cleanly: the cloud button
 *  acts on Drive and nothing else, this acts on the device and nothing else.
 *  So with a Drive copy in place this is reversible (the session falls back to
 *  offering the download), and without one it is the end of the recording,
 *  which is what its confirmation has to say. */
export async function forgetSessionAudio(sessionId: string): Promise<void> {
  await (await localDb()).delete(AUDIO_STORE, sessionId);
}

// ── In-progress crash-recovery scratch data (local-only) ───────────────────────

/** Raw per-window recognition results for an in-progress LIVE recording
 *  (2026-08-15) — recovery.ts replays these through a fresh
 *  IncrementalViterbiSegmenter instead of trusting a persisted detection
 *  snapshot, so a crash mid-session can never resurrect a short-lived,
 *  never-confirmed guess (which the live snapshot could contain at any given
 *  instant) as a "real" finalized detection. Overwritten wholesale on every
 *  persistDraft() call, same as the audio blob and the metadata row —
 *  simplest correct thing, not bounded, per the same "recompute is cheap
 *  enough" call made throughout this feature. Local-only, never synced — a
 *  crash can only be recovered on the device it happened on. */
export async function saveSessionWindows(sessionId: string, windows: WindowResult[]): Promise<void> {
  await (await localDb()).put(WINDOWS_STORE, windows, sessionId);
}

export async function loadSessionWindows(sessionId: string): Promise<WindowResult[] | undefined> {
  return (await localDb()).get(WINDOWS_STORE, sessionId);
}

/** Dead weight once a live recording is done (normally or via recovery) —
 *  only ever needed for crash-recovery replay of a still-in-progress session. */
export async function deleteSessionWindows(sessionId: string): Promise<void> {
  await (await localDb()).delete(WINDOWS_STORE, sessionId);
}

// ── Recording chunks (crash recovery, local-only) ───────────────────────────────

export async function appendChunk(recordingId: string, seq: number, blob: Blob): Promise<void> {
  await (await localDb()).add(CHUNKS_STORE, { recordingId, seq, blob });
}

export async function collectChunks(recordingId: string): Promise<Blob[]> {
  const d = await localDb();
  const all = await d.getAll(CHUNKS_STORE) as { recordingId: string; seq: number; blob: Blob }[];
  return all
    .filter(c => c.recordingId === recordingId)
    .sort((a, b) => a.seq - b.seq)
    .map(c => c.blob);
}

export async function clearChunks(recordingId: string): Promise<void> {
  const d = await localDb();
  const tx = d.transaction(CHUNKS_STORE, 'readwrite');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if ((cursor.value as { recordingId: string }).recordingId === recordingId) await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Drops everything this user's local session database holds: finalized audio,
 *  interrupted drafts, their in-flight chunks, and the per-session window
 *  results. For "reset my data", which otherwise leaves two things behind.
 *
 *  Orphan audio is the obvious one — blobs no metadata points at any more, and
 *  recordings are the largest thing this app stores. The other is worse: a
 *  draft interrupted before the reset is, by construction, what
 *  recoverOrphanedSessions promotes into AppState the next time the sessions
 *  library is opened. Left here, a session deleted by a reset would come back
 *  by itself.
 *
 *  The whole database goes rather than each store being cleared: it is named
 *  after the user and holds nothing else, so there is nothing to preserve, and
 *  a dropped database cannot leave a store behind that a later version adds.
 *  Best-effort like the migration's own cleanup — a blocked delete must not
 *  make a reset fail, having already done the part that matters. */
export async function deleteLocalSessionData(userId: string): Promise<void> {
  if (_localDb && _userId === userId) { _localDb.close(); _localDb = null; }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(localDbName(userId));
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => {
      // Only reachable if some connection to this database is still open — the
      // bug initSessionDbForUser's `_localDb?.close()` fixed. Logged rather
      // than swallowed: silently not deleting is exactly what made that one
      // hard to see.
      console.warn(`[sessions] deleting ${localDbName(userId)} was blocked by an open connection`);
      resolve();
    };
  });
}

/** How much local session audio a user has, for a confirmation that is about to
 *  destroy it (removing a local user, resetting). A recording kept in the local
 *  database exists nowhere else, so "your data stays on your other devices" is
 *  true of everything EXCEPT this, and a prompt that does not say so is
 *  promising something it cannot keep.
 *
 *  Counts the local database only, which is the right scope: a recording the
 *  user copied to Drive (model.ts's SyncedAudio) is a file of its own out
 *  there, so it really does survive this and is not what the warning is about.
 *
 *  Reads `Blob.size` only, which is metadata: no audio bytes are copied.
 *
 *  Returns null whenever the answer cannot be established cheaply and safely —
 *  no local database, an unreadable one, or no `indexedDB.databases()` to check
 *  existence with (Safari). That last case is why existence is not probed by
 *  simply opening: `indexedDB.open` CREATES the database it cannot find, and
 *  leaving an empty one behind as a side effect of drawing a warning — for a
 *  user who may well then cancel — is worse than showing the generic wording.
 *  Callers must treat null as "unknown", never as "nothing to lose". */
export async function localSessionAudioStats(
  userId: string,
): Promise<{ count: number; bytes: number } | null> {
  const name = localDbName(userId);
  if (!indexedDB.databases) return null;
  try {
    const all = await indexedDB.databases();
    if (!all.some(d => d.name === name)) return null;
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexeddb_blocked'));
    });
    try {
      if (!raw.objectStoreNames.contains(AUDIO_STORE)) return null;
      let count = 0, bytes = 0;
      for (const { value } of await dumpRawStore(raw, AUDIO_STORE)) {
        if (value instanceof Blob && value.size > 0) { count++; bytes += value.size; }
      }
      return count > 0 ? { count, bytes } : null;
    } finally {
      raw.close();
    }
  } catch {
    return null;
  }
}
