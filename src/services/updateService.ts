import { signal } from '@preact/signals';

/** Who this running bundle is. See buildInfo() in webpack.config.js. */
export interface BuildInfo { version: string; commit: string; dirty: boolean; build: string }

export const APP_BUILD: BuildInfo = __APP_VERSION__;

/** "2026.09.29 · a698284" — the date people can say out loud, the commit
 *  support can look up. `-dev` marks a local build with uncommitted changes,
 *  whose commit id does not describe the code that is running. */
export function versionLabel(b: BuildInfo = APP_BUILD): string {
  return `${b.version} · ${b.commit}${b.dirty ? '-dev' : ''}`;
}

export function commitUrl(b: BuildInfo = APP_BUILD): string | null {
  return b.commit === 'unknown' ? null : `https://github.com/Batpapa/Cadence/commit/${b.commit}`;
}

/** The deployed build, once it differs from this one AND its boot files are
 *  on this device. Null otherwise — including while they are still coming
 *  down, so nothing ever offers a reload that could land on half an app. */
export const updateReady = signal<BuildInfo | null>(null);

/** Why nothing else did the job (2026-09-30, a tablet that never got a
 *  release): the app had no update path at all. A new version arrived only if
 *  a navigation happened to reach the network — and an Android PWA woken from
 *  sleep does not navigate, it resumes the page it had; one cold-started
 *  before its Wi-Fi is back gets the cached shell from sw.js and runs the old
 *  build all session. `registration.update()` would not help either: sw.js is
 *  byte-identical across deploys, so the browser never sees a new worker. */

const VERSION_URL = './version.json';

/** A successful check makes the next one wait this long. Failures do not: the
 *  `online` event right after one is exactly the moment worth trying again. */
const MIN_INTERVAL_MS = 60_000;
const PERIOD_MS = 30 * 60_000;

let lastSuccess = 0;
let inFlight = false;
let pruned = false;

interface Deployed extends BuildInfo {
  assets: string[];
  /** Every file the build ships. Absent from version.json before 2026-10-01. */
  files?: string[];
}

function isDeployed(x: unknown): x is Deployed {
  const d = x as Deployed;
  return !!d && typeof d.build === 'string' && typeof d.version === 'string'
    && typeof d.commit === 'string' && Array.isArray(d.assets);
}

/** Fetches the new build's boot files through the service worker, whose
 *  cache-first branch keeps them. Without this, the reload is the moment they
 *  come down: the navigation caches the new shell, and a connection lost
 *  before the bundle follows leaves a shell pointing at a file this device
 *  does not have — a white screen now and at every offline launch after. That
 *  is the 2026-08-26 offline failure by another road, and the one thing this
 *  must not reintroduce.
 *
 *  The latin font subsets too, as sw.js's install does and for the same
 *  reason: a face is only requested once one of its glyphs is painted, so
 *  otherwise a font whose hash moved would be missing offline.
 *
 *  Uncontrolled page (no worker yet, or none supported): nothing can go
 *  offline-stale, so there is nothing to warm. */
async function warm(assets: string[]): Promise<void> {
  if (!navigator.serviceWorker?.controller) return;
  const get = async (url: string): Promise<Response | null> => {
    if (await caches.match(url)) return null;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res;
  };
  for (const asset of assets) {
    const url = new URL(asset, location.href).href;
    const res = await get(url);
    // Read to the end: the worker stores its copy as the body streams through.
    const body = res ? await res.text() : null;
    if (!url.endsWith('.css')) continue;
    const css = body ?? await (await caches.match(url))!.text();
    const fonts = [...css.matchAll(/url\(([^)]+\.woff2)\)/g)]
      .map(m => new URL(m[1].replace(/["']/g, ''), url).href)
      .filter(u => /latin/.test(u));
    for (const font of new Set(fonts)) {
      const f = await get(font);
      if (f) await f.arrayBuffer();
    }
  }
}

/** Drops from the service worker's cache everything the deployed build does
 *  not ship. sw.js caches every same-origin file cache-first under one name
 *  that never changes, and its `activate` only deletes OTHER cache names — so
 *  until this, every release's bundle and lazy chunks stayed on every device
 *  for good, about a megabyte more per deploy.
 *
 *  Only ever called when this page IS the deployed build, which is the one
 *  moment its list is both current and complete: every chunk this page could
 *  still lazily ask for is in it. With an update pending the page's own chunks
 *  are not in the new list, and the new build's are being warmed — so nothing
 *  is pruned then, and the next check after the reload does it.
 *
 *  Kept: the shell and any navigation cached under it (`./`, `./?mode=…`).
 *  The cost, accepted: another tab still open on an old build loses the chunks
 *  it has not loaded yet — and that tab is being offered the update anyway. */
async function pruneCache(deployed: Deployed): Promise<void> {
  const files = deployed.files;
  if (!files?.length || typeof caches === 'undefined') return;
  const abs = (f: string) => new URL(f, location.href).href;
  const keep = new Set(files.map(abs));
  // A list that does not even contain its own boot files is not one to delete by.
  if (!deployed.assets.every(a => keep.has(abs(a)))) return;
  keep.add(abs('./'));
  for (const name of await caches.keys()) {
    if (!name.startsWith('cadence-')) continue;
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const u = new URL(req.url);
      if (u.origin !== location.origin || keep.has(u.origin + u.pathname)) continue;
      await cache.delete(req);
    }
  }
}

async function checkForUpdate(): Promise<void> {
  if (inFlight || Date.now() - lastSuccess < MIN_INTERVAL_MS) return;
  inFlight = true;
  try {
    // no-store, and sw.js never caches this file: its whole point is to say
    // what is deployed now. Offline, this throws and nothing is offered.
    const res = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const deployed: unknown = await res.json();
    lastSuccess = Date.now();
    if (!isDeployed(deployed)) return;
    if (deployed.build === APP_BUILD.build) {
      // Once per page is plenty: the deployed list does not change under it.
      if (!pruned) { pruned = true; await pruneCache(deployed); }
      return;
    }
    if (deployed.build === updateReady.value?.build) return;
    await warm(deployed.assets);
    updateReady.value = { version: deployed.version, commit: deployed.commit, dirty: !!deployed.dirty, build: deployed.build };
  } catch {
    // Offline, or the connection dropped while warming: retried on the next
    // trigger, and the offer only ever appears once everything is here.
  } finally {
    inFlight = false;
  }
}

/** Top-level, alongside the service worker registration and behind the same
 *  hostname gate: the dev server has no worker and its version never moves.
 *  Checks on load, on coming back to the foreground (the resumed-from-sleep
 *  case), on the network returning (the cold-start-before-Wi-Fi case), and
 *  every half hour while visible. */
export function initUpdateCheck(): void {
  if (location.hostname === 'localhost') return;
  const visibleCheck = () => { if (document.visibilityState === 'visible') void checkForUpdate(); };
  window.addEventListener('load', () => void checkForUpdate());
  window.addEventListener('online', () => void checkForUpdate());
  document.addEventListener('visibilitychange', visibleCheck);
  setInterval(visibleCheck, PERIOD_MS);
}

/** A plain reload: the navigation goes to the network first (sw.js), and the
 *  files it asks for are already cached. Should the network vanish in
 *  between, the worker serves the old shell, whose files are all still there. */
export function applyUpdate(): void {
  location.reload();
}
