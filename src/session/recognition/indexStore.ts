import { kvGet, kvSet } from '../db';
import { TUNE_INDEX_URL, TUNE_INDEX_META_URL, INDEX_MAX_AGE_DAYS } from '../sessionConfig';

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

export type IndexProgress =
  | { phase: 'downloading'; loadedBytes: number; totalBytes: number | null }
  | { phase: 'processing' };

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

  const totalBytes = Number(res.headers.get('Content-Length')) || null;
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
}

let abcMetaPromise: Promise<Map<string, SettingAbcMeta> | null> | null = null;

export function getSettingAbcMeta(settingId: string): Promise<SettingAbcMeta | null> {
  abcMetaPromise ??= (async () => {
    const cached = await kvGet<TuneIndexData>(KV_INDEX);
    if (!cached) return null;
    const map = new Map<string, SettingAbcMeta>();
    for (const id in cached.indexData.settings) {
      const s = cached.indexData.settings[id]!;
      map.set(id, { abc: cached.abcStrings[id] ?? '', meter: s.meter, mode: s.mode, dance: s.dance });
    }
    return map;
  })();
  return abcMetaPromise.then(map => map?.get(settingId) ?? null);
}
