import { openDB, type IDBPDatabase } from 'idb';
import type { AppContext } from '../types';
import type { Analysis } from '../session/model';
import { importAnalysis } from './sessionShareService';
import { tuneAnalyserOffered } from './extensions';

// ── Analyses carried from the standalone analyser into an account ────────────
// (2026-10-26) TuneAnalyser/ keeps nothing; its "Sign in to Cadence to keep
// them" link hands what it analysed to the app. The two are the same site,
// so nothing goes through a server: the page puts its finished analyses —
// what they found and their sound — in this database, and opens the app's
// sign-in. The next user opened there (signed in, picked, or just created)
// gets them in their analyser, at the root of its list. The app stays where
// it opens: finding them is left to the user (the author's call — a reason to
// look around).
//
// The database IS the pending state: anything in it is waiting for the next
// user, and leaves it once imported. No flag beside it to fall out of step.

const DB_NAME = 'cadence-standalone-handoff';
const STORE = 'analyses';

interface Staged {
  session: Analysis;
  audio: Blob | null;
}

let _db: IDBPDatabase | null = null;

async function db(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore(STORE, { autoIncrement: true });
    },
  });
  return _db;
}

/** The standalone page's side. ADDED to whatever an earlier click left there
 *  unclaimed, never in place of it: the page gives its analyses up when it
 *  stages them (analyser.tsx's handOver), so those are found nowhere else. */
export async function stageAnalyses(items: ReadonlyArray<Staged>): Promise<void> {
  // A copy of the bytes, not the Blob read from the analyser's own database:
  // WebKit can store a blob that came out of IndexedDB wrongly when it goes
  // back in (audio/webmSliceRepair.ts). Made BEFORE the transaction opens: one
  // that waits on anything but its own requests (arrayBuffer here) is closed
  // by the browser — "The transaction has finished" (2026-10-26).
  const copies: Staged[] = await Promise.all(items.map(async item => ({
    session: item.session,
    audio: item.audio ? new Blob([await item.audio.arrayBuffer()], { type: item.audio.type }) : null,
  })));
  const tx = (await db()).transaction(STORE, 'readwrite');
  for (const copy of copies) await tx.store.add(copy);
  await tx.done;
}

/** Whether analyses are waiting for the next user opened. */
export async function hasStagedAnalyses(): Promise<boolean> {
  return (await (await db()).count(STORE)) > 0;
}

/** The app's side, once a user is open. Each analysis is removed as soon as
 *  it is in: one failing half-way leaves only the ones not yet imported,
 *  tried again with the next user opened, none of them twice. */
export async function importStagedAnalyses(ctx: AppContext): Promise<void> {
  const d = await db();
  const keys = await d.getAllKeys(STORE);
  if (keys.length === 0) return;

  // They were brought here to be kept in the analyser: a user who has it
  // switched off (a new user starts so) gets it switched on, or they would
  // be in a module nowhere to be seen.
  if (!tuneAnalyserOffered()) {
    await ctx.mutate(s => {
      s.extensions = { ...s.extensions, irishTrad: true };
      s.extensionOptions = { ...s.extensionOptions, irishTrad: { ...s.extensionOptions?.irishTrad, tuneAnalyser: true } };
    });
  }

  for (const key of keys) {
    const item = await d.get(STORE, key) as Staged | undefined;
    if (item) await importAnalysis(item.session, item.audio);
    await d.delete(STORE, key);
  }
}
