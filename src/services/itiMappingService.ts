import { loadItiMappingDb, saveItiMappingDb, type ItiMappingDb } from './itiMappingDb';

// ── IrishTuneInfo⇒TheSession mapping sync ────────────────────────────────────
// TheSession.org maintains a "collection" (id 4, "Irishtune.info") pairing every
// IrishTuneInfo tune with its TheSession equivalent, paginated JSON, fetchable
// client-side (no server proxy needed, same discovery as the Trending module's
// GitHub dump). Only needs re-syncing in full when the collection's `total`
// changes — otherwise a single page-1 fetch confirms nothing changed. Modeled
// on trendingSyncService.ts: paginate, checkpoint IndexedDB periodically so an
// interrupted first sync doesn't lose all progress, no internal retry (a thrown
// fetch error just propagates — the caller treats any failure as "no mapping
// known" and must never let it block the underlying IrishTuneInfo import).

const COLLECTION_URL = 'https://thesession.org/tunes/collections/4';
const PER_PAGE = 50;
const CHECKPOINT_EVERY_N_PAGES = 10;
const ITI_ID_RE = /\/tune\/(\d+)/;

interface RawCollectionTune {
  id: number;
  name: string;
  identifier: string;
}

interface RawCollectionPage {
  total: number;
  pages: number;
  tunes: RawCollectionTune[];
}

async function fetchCollectionPage(page: number): Promise<RawCollectionPage> {
  const res = await fetch(`${COLLECTION_URL}?format=json&perpage=${PER_PAGE}&page=${page}`);
  if (!res.ok) throw new Error(`TheSession collection fetch failed: ${res.status}`);
  return (await res.json()) as RawCollectionPage;
}

function applyPage(byItiId: Record<number, { sessionId: number; name: string }>, page: RawCollectionPage): void {
  for (const tune of page.tunes) {
    const m = ITI_ID_RE.exec(tune.identifier);
    if (!m) continue;
    const itiId = parseInt(m[1]!, 10);
    byItiId[itiId] = { sessionId: tune.id, name: tune.name };
  }
}

export interface MappingSyncProgress {
  done: number;
  total: number;
}

/** Loads the local mapping, checks the collection's current `total` against it,
 *  and — only if that changed (or nothing is stored yet) — repaginates the whole
 *  collection to rebuild the mapping. Safe to call whenever a mapping lookup is
 *  needed: the common case costs exactly one HTTP request. */
export async function ensureItiMapping(onProgress?: (p: MappingSyncProgress) => void): Promise<ItiMappingDb> {
  const local = await loadItiMappingDb();
  const first = await fetchCollectionPage(1);

  if (first.total === local.total && Object.keys(local.byItiId).length > 0) {
    return local;
  }

  const byItiId: Record<number, { sessionId: number; name: string }> = {};
  applyPage(byItiId, first);
  onProgress?.({ done: 1, total: first.pages });

  for (let page = 2; page <= first.pages; page++) {
    const data = await fetchCollectionPage(page);
    applyPage(byItiId, data);
    onProgress?.({ done: page, total: first.pages });

    if (page % CHECKPOINT_EVERY_N_PAGES === 0) {
      await saveItiMappingDb({ total: local.total, byItiId });
    }
  }

  const result: ItiMappingDb = { total: first.total, byItiId };
  await saveItiMappingDb(result);
  return result;
}
