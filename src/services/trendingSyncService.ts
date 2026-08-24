import { loadPopularityDb, savePopularityDb, type PopularityDb } from '../trending/db';

// ── TheSession popularity history sync ────────────────────────────────────────
// Ports Program.cs (TheSession_PopularityHistory) to the browser: both
// api.github.com and raw.githubusercontent.com send `Access-Control-Allow-Origin: *`,
// so the whole adactio/TheSession-data history is fetchable client-side with no
// server proxy. json/tune_popularity.json gets one commit a week — a full history
// crawl (first-ever sync on a device) is ~360 raw fetches (~740 KB each, ~267 MB
// total). To avoid holding all of that in memory at once, commits are processed in
// small batches: each batch is fetched, folded into the compact `PopularityDb`
// (numbers only), then dropped before the next batch starts. Later syncs on the
// same device just replay this exact same function on the handful of commits
// published since the last run (usually 0-1) — no separate "incremental" path.

const OWNER = 'adactio';
const REPO = 'TheSession-data';
const FILE_PATH = 'json/tune_popularity.json';
const API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const BATCH_SIZE = 10;
const CHECKPOINT_EVERY_N_BATCHES = 5;

interface Commit {
  sha: string;
  date: string;
}

interface RawTuneEntry {
  name: string;
  tune_id: string;
  tunebooks: string | number;
}

/** `onPage` fires after each page lands, with the running commit count so
 *  far — the UI has SOMETHING to show ("N found so far, still counting")
 *  during this walk instead of a frozen 0/0, since the real total (how many
 *  are actually still PENDING) can't be known until this whole walk finishes
 *  and gets compared against what's already synced (see
 *  syncPopularityHistory). */
async function fetchAllCommits(onPage?: (foundSoFar: number) => void): Promise<Commit[]> {
  const commits: Commit[] = [];
  for (let page = 1; ; page++) {
    const url = `${API_BASE}/repos/${OWNER}/${REPO}/commits?path=${encodeURIComponent(FILE_PATH)}&per_page=100&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GitHub commits fetch failed: ${res.status}`);
    const data = (await res.json()) as Array<{ sha: string; commit: { committer: { date: string } } }>;
    if (data.length === 0) break;
    for (const c of data) commits.push({ sha: c.sha, date: c.commit.committer.date });
    onPage?.(commits.length);
    if (data.length < 100) break;
  }
  commits.reverse(); // API returns newest-first; process oldest-first like Program.cs.
  return commits;
}

async function fetchSnapshot(sha: string): Promise<RawTuneEntry[]> {
  const url = `${RAW_BASE}/${OWNER}/${REPO}/${sha}/${FILE_PATH}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Snapshot fetch failed (${sha}): ${res.status}`);
  return (await res.json()) as RawTuneEntry[];
}

/** Appends this snapshot's values to every known tuneId (null if absent this week),
 *  backfills brand-new tuneIds with leading nulls — same logic as Program.cs's ApplySnapshot. */
function applySnapshot(dbState: PopularityDb, date: string, entries: RawTuneEntry[]): void {
  const prevCount = dbState.snapshots.length;
  const seen = new Map<string, number>();
  for (const e of entries) {
    const count = typeof e.tunebooks === 'string' ? parseInt(e.tunebooks, 10) : e.tunebooks;
    seen.set(e.tune_id, count);
    dbState.names[e.tune_id] = e.name;
  }

  dbState.snapshots.push(date);
  for (const [id, values] of Object.entries(dbState.tunes)) {
    values.push(seen.has(id) ? seen.get(id)! : null);
  }
  for (const id of seen.keys()) {
    if (!(id in dbState.tunes)) {
      dbState.tunes[id] = [...new Array<null>(prevCount).fill(null), seen.get(id)!];
    }
  }
}

export type SyncProgress =
  // Still walking the commit-history pages — the eventual pending TOTAL
  // isn't known yet (it depends on comparing against what's already synced,
  // only possible once the full list is in), so this phase reports a running
  // count instead of a done/total fraction.
  | { phase: 'checking'; found: number }
  | { phase: 'syncing'; done: number; total: number };

/** Loads the local history, fetches+applies any commit published since the last
 *  sync (all of them, batched, on a device's very first run), persists after every
 *  few batches so an interrupted first sync doesn't lose all progress, and returns
 *  the up-to-date PopularityDb. Safe to call on every module open — a no-op fetch
 *  of the commit list plus 0-1 snapshot fetches once already caught up. */
export async function syncPopularityHistory(onProgress?: (p: SyncProgress) => void): Promise<PopularityDb> {
  const dbState = await loadPopularityDb();
  const known = new Set(dbState.snapshots);

  const allCommits = await fetchAllCommits(found => onProgress?.({ phase: 'checking', found }));
  const pending = allCommits.filter(c => !known.has(c.date));
  if (pending.length === 0) return dbState;

  const total = pending.length;
  let done = 0;
  onProgress?.({ phase: 'syncing', done, total });

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const snapshots = await Promise.all(batch.map(c => fetchSnapshot(c.sha)));
    for (let j = 0; j < batch.length; j++) {
      applySnapshot(dbState, batch[j]!.date, snapshots[j]!);
    }
    done += batch.length;
    onProgress?.({ phase: 'syncing', done, total });

    const batchIndex = Math.floor(i / BATCH_SIZE);
    if ((batchIndex + 1) % CHECKPOINT_EVERY_N_BATCHES === 0) {
      await savePopularityDb(dbState);
    }
  }

  await savePopularityDb(dbState);
  return dbState;
}
