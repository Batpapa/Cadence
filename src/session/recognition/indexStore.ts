import { kvGet, kvSet } from '../db';
import { TUNE_INDEX_URL, TUNE_INDEX_META_URL, INDEX_MAX_AGE_DAYS } from '../sessionConfig';
import { cardVersionHashOf, isCardId } from './cardIndex';

// ── FolkFriend tune index: fetch + IndexedDB cache + ABC strip ────────────────
// Mirrors the official app's strategy: cache in IndexedDB, load cached copy
// immediately, refresh in the background when the remote version is much newer.
// ABC strings are stripped before the index goes to WASM (loading large strings
// into WASM memory is slow and matching only uses `contour`); they are kept in
// a JS-side map for display.

interface IndexSetting {
  tune_id: string;
  meter: string;
  mode: string;
  abc: string;
  dance: string;
  contour: string;
}

export interface TuneIndexData {
  /** Passed to FolkFriendWASM.load_index_from_json_obj (abc fields emptied). */
  indexData: { settings: Record<string, IndexSetting>; aliases: Record<string, string[]> };
  /** settingId → ABC string, kept JS-side. */
  abcStrings: Record<string, string>;
}

interface IndexMeta { v: number }

const KV_INDEX = 'tuneIndex';
const KV_META = 'tuneIndexMeta';
/** The cards' contours, by the hash of their ABC (cardIndex.ts): kept from one
 *  recognition to the next, so only versions added or edited since are
 *  converted again. */
export const KV_CARD_CONTOURS = 'cardContours';

/** What a recognition is doing before it can start, step by step — said rather
 *  than one "loading" line, which, once the cards came in (2026-11-16), could
 *  last long enough to look stuck (the user, 2026-11-16). */
export type IndexProgress =
  /** The engine itself (WASM), before any index. */
  | { phase: 'engine' }
  /** TheSession's index: downloaded the first time, then made ready. */
  | { phase: 'downloading'; loadedBytes: number }
  | { phase: 'processing' }
  /** TheSession's index, read off this device. */
  | { phase: 'loading' }
  /** The indexes searched, merged, going into the engine (ffWorker.ts). */
  | { phase: 'merging' }
  /** The tune cards' ABC, read (cardIndexSource.ts): `done` of `total` files
   *  and links. */
  | { phase: 'cards'; done: number; total: number }
  /** The cards' versions new since the last recognition, converted to
   *  contours (ffWorker.ts's mergeCardIndex). */
  | { phase: 'contours'; done: number; total: number };

async function fetchMeta(): Promise<IndexMeta | null> {
  try {
    const res = await fetch(TUNE_INDEX_META_URL);
    if (!res.ok) return null;
    return await res.json() as IndexMeta;
  } catch {
    return null;
  }
}

async function fetchIndex(onProgress?: (p: IndexProgress) => void): Promise<TuneIndexData> {
  const res = await fetch(TUNE_INDEX_URL);
  if (!res.ok || !res.body) throw new Error(`Tune index download failed: ${res.status}`);

  // No total shown: `Content-Length` here is the gzip-COMPRESSED transfer
  // size (raw.githubusercontent.com compresses this response), while
  // `loadedBytes` below accumulates DECOMPRESSED bytes off the auto-inflated
  // fetch stream — the two are on different scales (measured 2026-08-24:
  // ~8MB compressed header vs ~33MB actual decompressed payload). Showing
  // that header as "of N MB" is actively misleading, not just imprecise, so
  // only the live downloaded count is displayed (see indexProgressText).
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.length;
    onProgress?.({ phase: 'downloading', loadedBytes });
  }
  onProgress?.({ phase: 'processing' });

  const buf = new Uint8Array(loadedBytes);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  const indexData = JSON.parse(new TextDecoder().decode(buf)) as TuneIndexData['indexData'];

  // Strip ABC out of the payload destined for WASM; keep a JS-side map.
  const abcStrings: Record<string, string> = {};
  for (const settingId in indexData.settings) {
    abcStrings[settingId] = indexData.settings[settingId]!.abc;
    indexData.settings[settingId]!.abc = '';
  }
  return { indexData, abcStrings };
}

/**
 * Returns the tune index, downloading it on first use (progress reported),
 * from cache afterwards. When the cached copy is INDEX_MAX_AGE_DAYS behind the
 * remote version, a refresh is kicked off in the background for next time.
 */
export async function loadTuneIndex(onProgress?: (p: IndexProgress) => void): Promise<TuneIndexData> {
  onProgress?.({ phase: 'loading' });
  const cached = await kvGet<TuneIndexData>(KV_INDEX);

  if (cached) {
    void refreshIfStale();
    return cached;
  }

  const downloaded = await fetchIndex(onProgress);
  await kvSet(KV_INDEX, downloaded);
  const meta = await fetchMeta();
  if (meta) await kvSet(KV_META, meta);
  return downloaded;
}

async function refreshIfStale(): Promise<void> {
  try {
    const remote = await fetchMeta();
    if (!remote) return;
    const local = await kvGet<IndexMeta>(KV_META) ?? { v: 0 };
    // Versions are day numbers upstream: the difference is an age in days.
    if (remote.v - local.v < INDEX_MAX_AGE_DAYS) return;
    const downloaded = await fetchIndex();
    await kvSet(KV_INDEX, downloaded);
    await kvSet(KV_META, remote);
  } catch {
    // Offline or transient failure — cached copy stays in use.
  }
}

// ── Setting ABC lookup (main thread) ──────────────────────────────────────────
// The cached index holds the ABC of every FolkFriend setting. Loaded lazily on
// first request (a few seconds for ~55k settings), then kept as a compact map —
// the full index object is released for GC.

export interface SettingAbcMeta {
  abc: string;
  meter: string;
  mode: string;  // e.g. "Dmajor", "Edorian"
  dance: string; // reel, jig, …
  /** TheSession tune id — same numeric id used by theSessionService.ts, not a
   *  FolkFriend-internal renumbering (verified: index setting ids and tune_ids
   *  match TheSession's own /tunes/{id} API 1:1). Combined with the settingId
   *  key, builds the exact-setting URL: /tunes/{tune_id}#setting{settingId}.
   *  Not for a card's version (cardIndex.ts, `card:` setting id): its tune is
   *  the TheSession tune the card is, or `card:<guid>`, and no URL leads to it. */
  tune_id: string;
}

let abcMetaPromise: Promise<Map<string, SettingAbcMeta> | null> | null = null;
let abcMetaMap: Map<string, SettingAbcMeta> | null = null;
let abcMetaLooks = 0;

/** An absent index is NOT kept: only the recognition worker downloads it, and
 *  a device that received its analyses through Drive has never run one. Kept,
 *  that absence greyed every score button until the app restarted, even after
 *  a recognition had brought the index in (seen 2026-10-29 after a reinstall).
 *  So the next call looks again — a missing key costs IndexedDB next to
 *  nothing. */
export function getSettingAbcMeta(settingId: string): Promise<SettingAbcMeta | null> {
  if (isCardId(settingId)) return cardSettingResolver ? cardSettingResolver.load(settingId) : Promise.resolve(null);
  if (!abcMetaPromise) {
    const look = ++abcMetaLooks;
    abcMetaPromise = (async () => {
      const cached = await kvGet<TuneIndexData>(KV_INDEX);
      if (!cached) {
        // Unless a newer look has started meanwhile (noteTuneIndexCached).
        if (look === abcMetaLooks) abcMetaPromise = null;
        return null;
      }
      const map = new Map<string, SettingAbcMeta>();
      for (const id in cached.indexData.settings) {
        const s = cached.indexData.settings[id]!;
        map.set(id, { abc: cached.abcStrings[id] ?? '', meter: s.meter, mode: s.mode, dance: s.dance, tune_id: s.tune_id });
      }
      abcMetaMap = map;
      return map;
    })();
  }
  return abcMetaPromise.then(map => map?.get(settingId) ?? null);
}

const indexCachedListeners = new Set<() => void>();

/** Main thread, from recognitionClient.ts: the worker is ready, so the index
 *  is in IndexedDB now. Whatever found it missing is told to look again. */
export function noteTuneIndexCached(): void {
  if (abcMetaMap) return;
  abcMetaPromise = null;
  for (const listener of indexCachedListeners) listener();
}

/** Called back by noteTuneIndexCached; returns the unsubscribe, effect-style. */
export function onTuneIndexCached(listener: () => void): () => void {
  indexCachedListeners.add(listener);
  return () => { indexCachedListeners.delete(listener); };
}

/** The contour of one setting — one symbol per quaver, repeats unfolded — for
 *  score following (scoreFollow.ts, in its worker), where it competes with
 *  the drawn score. Not kept with the ABC map: ~55k contours would add ~11 MB
 *  to a map every score preview loads, for a feature that needs one at a
 *  time. Read from the cached index the first time — the whole 34 MB has to
 *  come out of IndexedDB for it, most of a second, several on a phone — then
 *  kept under a key of its own, a few hundred bytes, so a tune followed again
 *  starts at once. A contour belongs to its setting for good: the index's
 *  refresh does not touch it. Null when the index is not cached or does not
 *  hold the setting. */
const KV_CONTOUR = (settingId: string) => `tuneContour:${settingId}`;
export async function getSettingContour(settingId: string): Promise<string | null> {
  // A card's version: its contour is in the cards' cache, under its ABC's hash.
  const hash = cardVersionHashOf(settingId);
  if (hash) return (await kvGet<Record<string, string>>(KV_CARD_CONTOURS))?.[hash] || null;
  const kept = await kvGet<string>(KV_CONTOUR(settingId));
  if (kept) return kept;
  const cached = await kvGet<TuneIndexData>(KV_INDEX);
  const contour = cached?.indexData.settings[settingId]?.contour || null;
  if (contour) await kvSet(KV_CONTOUR(settingId), contour).catch(() => { /* a cache, nothing lost */ });
  return contour;
}

/** Synchronous lookup once the map is loaded — undefined while still loading.
 *  Lets UI that re-renders often draw the final state immediately (no flash). */
export function getSettingAbcMetaSync(settingId: string): SettingAbcMeta | null | undefined {
  if (isCardId(settingId)) return cardSettingResolver ? cardSettingResolver.now(settingId) : null;
  if (!abcMetaMap) return undefined;
  return abcMetaMap.get(settingId) ?? null;
}

// ── A card's version (cardIndex.ts) ──────────────────────────────────────────
// Its ABC is on the card, not in the index. Read by the page, which has the
// cards: it installs the reader here (cardIndexSource.ts) rather than this file
// importing the app's state, since the recognition worker loads this file too.
// Without one — the worker, the standalone pages — a card's version is unknown.

interface CardSettingResolver {
  /** From what the page already holds; null when it would have to fetch. */
  now(settingId: string): SettingAbcMeta | null;
  /** Fetching the card's file if it must (an attachment kept out of the state). */
  load(settingId: string): Promise<SettingAbcMeta | null>;
}

let cardSettingResolver: CardSettingResolver | null = null;

export function setCardSettingResolver(resolver: CardSettingResolver): void {
  cardSettingResolver = resolver;
}
