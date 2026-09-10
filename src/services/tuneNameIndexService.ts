import { loadTuneNameIndexDb, saveTuneNameIndexDb, type LocalTune } from './tuneIndexDb';
import { sortByRelevance, normalizeDisplayName } from '../utils';

// ── Local TheSession tune-name search ─────────────────────────────────────────
// Same adactio/TheSession-data repo as trendingSyncService.ts (both
// api.github.com and raw.githubusercontent.com send
// Access-Control-Allow-Origin: *, so this is fetchable client-side with no
// server proxy), but a DIFFERENT sync shape: json/tune_popularity.json gets a
// weekly commit and trendingSyncService replays the whole commit history to
// build a time series. json/tunes.json (~24 MB) has no history we need —
// only ever the LATEST snapshot matters for name search — so this only ever
// fetches once per actual change upstream: a single lightweight "what's the
// latest commit for this path" API call decides whether the full file needs
// re-downloading at all.
//
// tunes.json is a per-SETTING dump (one row per setting, many settings share
// a tune_id) and carries full ABC/date/username/composer per row — far more
// than a name-search index needs. Deduped down to one row per tune_id
// (name/type/meter/mode only) before it ever reaches IndexedDB, so the
// stored index stays a fraction of the 24 MB source despite covering every
// tune.

const OWNER = 'adactio';
const REPO = 'TheSession-data';
const FILE_PATH = 'json/tunes.json';
const API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';

interface RawSettingEntry {
  tune_id: string;
  name: string;
  type: string;
  meter: string;
  mode: string;
}

async function fetchLatestCommitSha(): Promise<string | null> {
  const url = `${API_BASE}/repos/${OWNER}/${REPO}/commits?path=${encodeURIComponent(FILE_PATH)}&per_page=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GitHub commit check failed: ${res.status}`);
  const data = (await res.json()) as Array<{ sha: string }>;
  return data[0]?.sha ?? null;
}

export interface IndexSyncProgress {
  phase: 'checking' | 'downloading' | 'processing';
  loadedBytes?: number;
  totalBytes?: number;
}

async function downloadTunesJson(onProgress?: (p: IndexSyncProgress) => void): Promise<RawSettingEntry[]> {
  const url = `${RAW_BASE}/${OWNER}/${REPO}/main/${FILE_PATH}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`tunes.json fetch failed: ${res.status}`);

  const totalBytes = parseInt(res.headers.get('content-length') ?? '', 10) || undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.length;
    onProgress?.({ phase: 'downloading', loadedBytes, totalBytes });
  }
  const merged = new Uint8Array(loadedBytes);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }

  onProgress?.({ phase: 'processing' });
  return JSON.parse(new TextDecoder().decode(merged)) as RawSettingEntry[];
}

/** One row per tune_id — first setting encountered wins (name/type/meter
 *  virtually never disagree between settings of the same tune; `mode`/key
 *  can differ, but this index isn't used for key-accurate lookups). */
function dedupeToTunes(entries: RawSettingEntry[]): LocalTune[] {
  const byId = new Map<number, LocalTune>();
  for (const e of entries) {
    const id = parseInt(e.tune_id, 10);
    if (Number.isNaN(id) || byId.has(id)) continue;
    byId.set(id, { id, name: e.name, type: e.type, meter: e.meter, mode: e.mode });
  }
  return [...byId.values()];
}

let _memoryIndex: LocalTune[] | null = null;
let _inFlight: Promise<LocalTune[]> | null = null;

/** TheSession-data's tunes.json carries raw library-catalog names ("Kesh,
 *  The") like tune_popularity.json does (see trendingService.ts) — normalized
 *  here, once, right before the index is memoized, rather than in
 *  dedupeToTunes: `stored.tunes` below is a straight IndexedDB cache keyed
 *  off the upstream commit SHA (this file's own doc: normally only ONE
 *  commit ever touches this file, so a device's cached copy can go a long
 *  time without a reason to re-download) — normalizing only at construction
 *  time would leave an already-cached device's names stuck in catalog order
 *  indefinitely. Doing it here instead covers both the fresh-download and
 *  the load-from-cache path, and only once per tab lifetime (`_memoryIndex`
 *  is memoized), not once per keystroke in searchLocalTuneIndex. */
function normalizeTunes(tunes: LocalTune[]): LocalTune[] {
  return tunes.map(t => ({ ...t, name: normalizeDisplayName(t.name) }));
}

async function syncTuneNameIndex(onProgress?: (p: IndexSyncProgress) => void): Promise<LocalTune[]> {
  onProgress?.({ phase: 'checking' });
  const stored = await loadTuneNameIndexDb();

  let latestSha: string | null = null;
  try {
    latestSha = await fetchLatestCommitSha();
  } catch {
    // Offline or a GitHub API hiccup — fall back to whatever's cached below.
  }

  if (stored.tunes.length > 0 && (latestSha === null || latestSha === stored.commitSha)) {
    _memoryIndex = normalizeTunes(stored.tunes);
    return _memoryIndex;
  }

  const raw = await downloadTunesJson(onProgress);
  const tunes = dedupeToTunes(raw);
  // Stored as fetched (raw catalog-order names) — a faithful mirror of
  // upstream, normalized only at the in-memory presentation boundary above.
  await saveTuneNameIndexDb({ commitSha: latestSha, tunes });
  _memoryIndex = normalizeTunes(tunes);
  return _memoryIndex;
}

/** Loads the local tune-name index, refreshing from adactio/TheSession-data's
 *  json/tunes.json only if a newer commit exists upstream. First-ever call on
 *  a device does a full ~24 MB download; every later call (including on every
 *  subsequent app/import-modal open) is just the one lightweight commit-SHA
 *  check unless TheSession's upstream dump actually changed since. Safe to
 *  call repeatedly/concurrently — in-flight and completed results are both
 *  cached in memory for the life of the tab. */
export function ensureTuneNameIndex(onProgress?: (p: IndexSyncProgress) => void): Promise<LocalTune[]> {
  if (_memoryIndex) return Promise.resolve(_memoryIndex);
  if (!_inFlight) {
    // The by-id lookup is rebuilt on the way out, so a screen that asked for
    // the index because it had none gets the real names as soon as it lands.
    _inFlight = syncTuneNameIndex(onProgress)
      .then(tunes => { buildLookup(tunes); return tunes; })
      .finally(() => { _inFlight = null; });
  }
  return _inFlight;
}

// ── Looking one name up, for the recogniser's sake ───────────────────────────
// The recognition index (folkfriend-non-user-data.json) holds its names
// ENTIRELY in lower case — measured on the real file, 0 capitals across its
// 46 867 aliases — because it is a search index and matching ignores case. So
// a tune imported from TheSession reads "McGoldrick's" while the same tune
// recognised from a recording reads "mcgoldrick's".
//
// THIS index has the real names, keyed by the same TheSession tune id, so the
// answer is a lookup rather than a reconstruction. Guessing the capitals from
// the letters was tried and rejected (2026-09-10): the rules that get
// "McGoldrick's" right are the rules that get someone else's name wrong, and
// they would need revisiting forever.
//
// Deliberately never triggers the 24 MB download: this is a nicety on a screen
// nobody opened to search for a tune. It reads what is already cached, and
// where nothing is cached the recogniser's own lower-case name stands — which
// is what shipped for a year. `ensureTuneNameIndex`, called from the import
// screen, is still the only thing that fetches.

let _nameById: Map<number, string> | null = null;
let _cacheLoad: Promise<boolean> | null = null;

function buildLookup(tunes: LocalTune[]): void {
  _nameById = new Map(tunes.map(t => [t.id, t.name]));
}

/** Reads the already-stored index into a lookup, once, WITHOUT downloading.
 *  Resolves to whether this device actually had one — the caller decides
 *  whether an absent index is worth fetching. */
export function primeCachedTuneNames(): Promise<boolean> {
  if (_nameById) return Promise.resolve(_nameById.size > 0);
  if (!_cacheLoad) {
    _cacheLoad = (async () => {
      try {
        buildLookup(_memoryIndex ?? normalizeTunes((await loadTuneNameIndexDb()).tunes));
      } catch {
        // Storage refused: the lookup simply never answers.
        buildLookup([]);
      }
      return _nameById!.size > 0;
    })();
  }
  return _cacheLoad;
}

/** TheSession's own name for a tune id, or undefined when this device has no
 *  index cached (or the id is not in it — a tune added upstream since the last
 *  sync). Synchronous by design: it is called per rendered row. */
export function cachedTuneName(tuneId: string | number): string | undefined {
  const id = typeof tuneId === 'number' ? tuneId : parseInt(tuneId, 10);
  if (!Number.isFinite(id)) return undefined;
  return _nameById?.get(id);
}

/** Local, offline-capable substring + relevance search — replaces hitting
 *  TheSession's own /tunes/search API, whose ranking/matching quality the
 *  user found unreliable in practice. */
export function searchLocalTuneIndex(tunes: LocalTune[], query: string, limit = 30): LocalTune[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = tunes.filter(t => t.name.toLowerCase().includes(q));
  return sortByRelevance(matches, q).slice(0, limit);
}
