import { openDB, type IDBPDatabase } from 'idb';
import { TUNE_ANALYSER_MODULE_KEY, type RecordedSession, type TuneAnalyserModuleData, type WindowResult } from './model';

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
// Works in both window and worker contexts — kvGet/kvSet run inside the
// FolkFriend worker (ffWorker.ts → indexStore.ts), everything else runs on
// the main thread (liveSession.ts, importSession.ts, recovery.ts, …), which
// is required for the AppState-backed functions below (they read/write
// store.ts's appState signal, which only exists on the main thread).

const SHARED_DB_NAME    = 'cadence-sessions';
const SHARED_DB_VERSION = 1;
const KV_STORE = 'kv'; // tune index + metadata

const LOCAL_DB_VERSION = 1;
const DRAFT_STORE   = 'draft';   // session id → RecordedSession (status:'recording' only — see saveSessionMeta)
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

/** Sessions saved before the `source` field existed were all mic recordings. */
function migrateSession(s: RecordedSession | undefined): RecordedSession | undefined {
  if (s && s.source === undefined) s.source = 'live';
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
  const migratedMeta: Record<string, RecordedSession> = {};   // finalized → AppState.modules
  const migratedDrafts: Record<string, RecordedSession> = {}; // status:'recording' → local DRAFT_STORE, never AppState
  const migratedAudio: Array<[string, Blob]> = [];
  const migratedWindows: Array<[string, WindowResult[]]> = [];
  const migratedChunks: unknown[] = [];

  const sortMetaRow = (k: string, v: RecordedSession) => {
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
          else                              sortMetaRow(k, values[i] as RecordedSession);
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
      else                              sortMetaRow(k, values[i] as RecordedSession);
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

/** Best-effort raw dump of a specific user's LOCAL session database (audio +
 *  crash-recovery scratch data only — metadata/annotations live on the
 *  synced AppState now, see the "Download data" button next to this one in
 *  main.ts's Recovery screen). Reads directly via the native IndexedDB API,
 *  independent of localDb()/initSessionDbForUser(), so it works for ANY
 *  local user regardless of who's actually logged in right now. Returns null
 *  if that user has no local database on this device — opening a name that
 *  doesn't exist would silently CREATE an empty one, which this read-only
 *  helper must never do, so existence is checked first. */
export async function dumpUserSessionDatabase(userId: string): Promise<Record<string, Array<{ key: unknown; value: unknown }>> | null> {
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
    const dump: Record<string, Array<{ key: unknown; value: unknown }>> = {};
    for (const storeName of Array.from(raw.objectStoreNames)) {
      dump[storeName] = await dumpRawStore(raw, storeName);
    }
    return dump;
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
export async function saveSessionMeta(session: RecordedSession): Promise<void> {
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

export async function loadSessionMeta(sessionId: string): Promise<RecordedSession | undefined> {
  const finalized = (await moduleData()).sessions[sessionId];
  if (finalized) return migrateSession(finalized);
  return migrateSession(await (await localDb()).get(DRAFT_STORE, sessionId));
}

export async function deleteSession(sessionId: string): Promise<void> {
  const { mutate } = await storeModule();
  await mutate(user => {
    const mod = user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
    if (mod) delete mod.sessions[sessionId];
  });
  const d = await localDb();
  await d.delete(DRAFT_STORE, sessionId);
  await d.delete(AUDIO_STORE, sessionId);
  await d.delete(WINDOWS_STORE, sessionId);
}

/** Finalized sessions only (what the library shows) — see saveSessionMeta's
 *  doc for why an in-progress draft never shows up here. */
export async function listSessions(): Promise<RecordedSession[]> {
  const sessions = Object.values((await moduleData()).sessions).map(s => migrateSession(s)!);
  // Undated sessions (fresh imports) sort first — they're the current work.
  return sessions.sort((a, b) => (b.date ?? '￿').localeCompare(a.date ?? '￿'));
}

/** In-progress recording drafts (status:'recording') — used exclusively by
 *  recovery.ts to find orphans left behind by a crash/refresh; never shown
 *  directly in the library (see saveSessionMeta's doc). */
export async function listDraftSessions(): Promise<RecordedSession[]> {
  const sessions = await (await localDb()).getAll(DRAFT_STORE) as RecordedSession[];
  return sessions.map(s => migrateSession(s)!);
}

// ── Session audio (local-only — see module doc) ────────────────────────────────

export async function saveSessionAudio(sessionId: string, audio: Blob): Promise<void> {
  await (await localDb()).put(AUDIO_STORE, audio, sessionId);
}

export async function loadSessionAudio(sessionId: string): Promise<Blob | undefined> {
  return (await localDb()).get(AUDIO_STORE, sessionId);
}

/** Storage-saving: drops the (large) audio blob, keeps metadata + annotations.
 *  Irreversible — clip attachments can no longer be extracted from this session afterward. */
export async function forgetSessionAudio(sessionId: string): Promise<void> {
  await (await localDb()).delete(AUDIO_STORE, sessionId);
}

// ── In-progress crash-recovery scratch data (local-only) ───────────────────────

/** Raw per-window recognition results for an in-progress LIVE recording
 *  (2026-08-15) — recovery.ts replays these through a fresh
 *  IncrementalViterbiSegmenter instead of trusting a persisted annotation
 *  snapshot, so a crash mid-session can never resurrect a short-lived,
 *  never-confirmed guess (which the live snapshot could contain at any given
 *  instant) as a "real" finalized annotation. Overwritten wholesale on every
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
