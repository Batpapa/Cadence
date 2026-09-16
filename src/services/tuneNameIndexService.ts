import { loadTuneNameIndexDb, saveTuneNameIndexDb, loadTuneAliasIndexDb, saveTuneAliasIndexDb, type LocalTune } from './tuneIndexDb';
import { rankByRelevance, normalizeDisplayName } from '../utils';

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

async function fetchLatestCommitSha(path: string = FILE_PATH): Promise<string | null> {
  const url = `${API_BASE}/repos/${OWNER}/${REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`;
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

async function downloadJson<T>(path: string, onProgress?: (p: IndexSyncProgress) => void): Promise<T> {
  const url = `${RAW_BASE}/${OWNER}/${REPO}/main/${path}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${path} fetch failed: ${res.status}`);

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
  return JSON.parse(new TextDecoder().decode(merged)) as T;
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

  const raw = await downloadJson<RawSettingEntry[]>(FILE_PATH, onProgress);
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

// ── Aliases, for searching ───────────────────────────────────────────────────
// TheSession's own /tunes/search matches aliases — "put the cake in the
// dresser" finds Cooley's. The local index that replaced it knew only main
// names, so that search had quietly stopped working here. Measured on the dump
// (2026-09-16): 94 % of the aliases of the 500 most popular tunes do not
// contain the tune's name, so no name search can reach them.
//
// json/aliases.json (~2 MB, one row per alias) is synced exactly like
// tunes.json, under its own SHA. It is kept apart from ensureTuneNameIndex,
// which the session analyser also calls just to show names: that screen has
// no use for aliases, and should not download them.
//
// An alias sync that fails is not an error the search reports: names alone
// still search, and the next call tries again.

const ALIAS_FILE_PATH = 'json/aliases.json';

interface RawAliasEntry { tune_id: string; alias: string }

let _aliasMemory: Map<number, string[]> | null = null;
let _aliasInFlight: Promise<Map<number, string[]>> | null = null;

function aliasMap(raw: Record<string, string[]>): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const [id, list] of Object.entries(raw)) map.set(parseInt(id, 10), list.map(normalizeDisplayName));
  return map;
}

async function syncTuneAliasIndex(): Promise<Map<number, string[]>> {
  const stored = await loadTuneAliasIndexDb();
  let latestSha: string | null = null;
  try {
    latestSha = await fetchLatestCommitSha(ALIAS_FILE_PATH);
  } catch {
    // Offline or a GitHub API hiccup — whatever is cached will do.
  }
  const hasStored = Object.keys(stored.aliases).length > 0;
  if (hasStored && (latestSha === null || latestSha === stored.commitSha)) return aliasMap(stored.aliases);

  const rows = await downloadJson<RawAliasEntry[]>(ALIAS_FILE_PATH);
  // Every row kept, in upstream order: duplicates and spelling variants are
  // what a misspelled query lands on.
  const aliases: Record<string, string[]> = {};
  for (const r of rows) {
    if (!r.tune_id || !r.alias) continue;
    (aliases[r.tune_id] ??= []).push(r.alias);
  }
  await saveTuneAliasIndexDb({ commitSha: latestSha, aliases });
  return aliasMap(aliases);
}

function ensureTuneAliasIndex(): Promise<Map<number, string[]>> {
  if (_aliasMemory) return Promise.resolve(_aliasMemory);
  if (!_aliasInFlight) {
    _aliasInFlight = syncTuneAliasIndex()
      .then(map => { _aliasMemory = map; return map; })
      .finally(() => { _aliasInFlight = null; });
  }
  return _aliasInFlight;
}

export interface SearchableTune extends LocalTune {
  aliases?: string[];
}

let _searchable: { tunes: LocalTune[]; aliases: Map<number, string[]>; list: SearchableTune[] } | null = null;

/** The name index with each tune's aliases attached — what the tune search
 *  fields use. Resolves with names alone when the aliases cannot be had. */
export async function ensureTuneSearchIndex(): Promise<SearchableTune[]> {
  const [tunes, aliases] = await Promise.all([
    ensureTuneNameIndex(),
    ensureTuneAliasIndex().catch(() => null),
  ]);
  if (!aliases) return tunes;
  if (_searchable?.tunes !== tunes || _searchable.aliases !== aliases) {
    const list = tunes.map(t => {
      const a = aliases.get(t.id);
      return a ? { ...t, aliases: a } : t;
    });
    _searchable = { tunes, aliases, list };
  }
  return _searchable.list;
}

/** Local, offline-capable substring + relevance search over names and
 *  aliases — replaces hitting TheSession's own /tunes/search API, whose
 *  ranking/matching quality the user found unreliable in practice. `via` is
 *  the alias that found a tune, when its name did not.
 *
 *  Folds every name and alias on each search rather than once at load:
 *  measured at ~5 ms over 25 000 strings, behind a 300 ms debounce. */
export function searchLocalTuneIndex(tunes: SearchableTune[], query: string, limit = 30): Array<SearchableTune & { via?: string }> {
  if (!query.trim()) return [];
  return rankByRelevance(tunes, query)
    .slice(0, limit)
    .map(({ item, via }) => (via === undefined ? item : { ...item, via }));
}
