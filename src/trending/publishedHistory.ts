import type { PopularityDb } from './db';

// ── The popularity history as published with the site (2026-10-26) ──────────
// scripts/build-popularity.mjs builds it at every deploy and every Monday:
// data/popularity.json, next to the app. The standalone Trending page reads
// nothing else; the app starts its first sync from it instead of replaying
// ~360 weekly snapshots from GitHub.
//
// Tried where the page is served from first — the deployed site, or the dev
// server with a file built by the script — then on the deployed site itself,
// which GitHub Pages serves to any origin.

const PUBLISHED = 'https://batpapa.github.io/Cadence/data/popularity.json';

const isDb = (d: unknown): d is PopularityDb =>
  typeof d === 'object' && d !== null
  && Array.isArray((d as PopularityDb).snapshots)
  && typeof (d as PopularityDb).tunes === 'object'
  && typeof (d as PopularityDb).names === 'object';

async function tryFetch(url: string): Promise<PopularityDb | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isDb(data) && data.snapshots.length > 0 ? data : null;
  } catch {
    return null;
  }
}

/** `local`: the file's URL relative to the page — `data/popularity.json` from
 *  the app, `../data/popularity.json` from a page one folder down. Null when
 *  neither copy can be had (offline, or not deployed yet). */
export async function fetchPublishedHistory(local: string): Promise<PopularityDb | null> {
  const own = new URL(local, document.baseURI).href;
  return (await tryFetch(own)) ?? (own === PUBLISHED ? null : await tryFetch(PUBLISHED));
}
