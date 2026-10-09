import { App } from '@capacitor/app';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import type { BundleInfo } from '@capgo/capacitor-updater';
import { APP_BUILD, updateReady } from '../services/updateService';

/**
 * Over-the-air updates for the Android app — the native half of
 * services/updateService.ts, feeding the same `updateReady` signal and so the
 * same header pill.
 *
 * The app carries its own copy of the web app; a deploy reaches it through a
 * zip of the build that the Pages workflow publishes next to version.json
 * (scripts/ota-bundle.js). Here: read the DEPLOYED version.json, download that
 * zip (checksum checked by the plugin), and switch to it. Switching swaps the
 * WebView onto the new files; the plugin falls back to the previous bundle by
 * itself if the new one never reports a successful start (`markAppReady`,
 * within its 10 s).
 *
 * Two ways in. In the background (`check`): the pill appears once a bundle is
 * fully here. At a page start — a cold launch, or the pull-to-refresh, which
 * reloads the page (`updateAtPageStart`): the new version straight away, as
 * the PWA gets it, behind a "downloading the update" screen if need be.
 *
 * Imported dynamically, and only when isNative().
 */

interface DeployedNative {
  build: string;
  version: string;
  commit: string;
  dirty?: boolean;
  native?: { bundle: string; sha256: string; minNativeBuild: number };
}

type DeployedBundle = DeployedNative & { native: NonNullable<DeployedNative['native']> };

/** Where the PWA lives — the canonical link of index.html, as for the share
 *  modal: inside the app `location` is https://localhost. */
function deployedBase(): string | null {
  return document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null;
}

/** When a build was made: the base-36 timestamp ending its `build` id
 *  (webpack.config.js). */
function builtAt(build: string): number {
  return parseInt(build.slice(build.lastIndexOf('-') + 1), 36);
}

const MIN_INTERVAL_MS = 60_000;
const PERIOD_MS = 30 * 60_000;
/** How long a page start waits for version.json before starting on what it
 *  has: a launch in a pub with one bar of signal must not hang on it. */
const START_PROBE_MS = 1500;

let lastSuccess = 0;
let inFlight = false;
/** The downloaded bundle the pill would apply. */
let readyBundleId: string | null = null;

/** Resolves to `fallback` if `p` has not settled within `ms`. */
function within<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))]);
}

/** The running bundle started properly. Without this the plugin takes a
 *  freshly applied bundle for a broken one and rolls back. Called once the
 *  app or the user selector is on screen — not earlier, so that a bundle
 *  that cannot boot does get rolled back. */
export function markAppReady(): void {
  void CapacitorUpdater.notifyAppReady().catch(() => { /* bundled build: nothing to confirm */ });
}

/** Development only, never in a committed build (`dirty`): a version.json to
 *  pretend was deployed, read from localStorage — the one way to rehearse an
 *  update on a device without deploying one. */
const OTA_TEST_KEY = 'cadence.otaTestDeployed';

async function fetchDeployed(base: string): Promise<DeployedNative | null> {
  if (APP_BUILD.dirty) {
    const test = localStorage.getItem(OTA_TEST_KEY);
    return test ? JSON.parse(test) as DeployedNative : null;
  }
  const res = await fetch(new URL('version.json', base).href, { cache: 'no-store' });
  return res.ok ? await res.json() as DeployedNative : null;
}

/** Whether this deployed build is one to move to. */
async function isNewer(deployed: DeployedNative): Promise<boolean> {
  if (!deployed.native || typeof deployed.build !== 'string') return false;
  if (deployed.build === APP_BUILD.build) return false;
  // Unlike the PWA, the app may run a build made elsewhere than the deploy:
  // a released APK. Built from the deployed commit, it is the same code under
  // another build id — nothing to offer. Built from a later commit than the
  // one deployed, the deploy is OLDER — never offered as an update.
  if (deployed.commit === APP_BUILD.commit || !(builtAt(deployed.build) > builtAt(APP_BUILD.build))) return false;
  // An APK older than what the bundle needs would load code calling into
  // native features it does not have: leave it on what it has.
  const { build: nativeBuild } = await App.getInfo();
  return Number(nativeBuild) >= deployed.native.minNativeBuild;
}

/** One download per deployed build, shared: a page start that stopped waiting
 *  for it (`Later`) leaves it running, and the background check that follows
 *  joins it instead of starting another. Once here, it is what the pill offers. */
let download: { build: string; done: Promise<BundleInfo> } | null = null;

function downloadDeployed(deployed: DeployedBundle, base: string): Promise<BundleInfo> {
  if (download?.build === deployed.build) return download.done;
  const done = CapacitorUpdater.download({
    url: new URL(deployed.native.bundle, base).href,
    version: deployed.build,
    checksum: deployed.native.sha256,
  }).then(bundle => {
    readyBundleId = bundle.id;
    updateReady.value = { version: deployed.version, commit: deployed.commit, dirty: !!deployed.dirty, build: deployed.build };
    return bundle;
  });
  // A failure (offline, checksum) is tried again by the next check.
  done.catch(() => { if (download?.done === done) download = null; });
  download = { build: deployed.build, done };
  return done;
}

/** A bundle already here for that build, and not one that failed to start
 *  (`error`: the plugin rolled it back — taking it again would fail every
 *  launch). */
async function downloadedFor(build: string): Promise<BundleInfo | null> {
  const { bundles } = await CapacitorUpdater.list();
  return bundles.find(b => b.version === build && (b.status === 'success' || b.status === 'pending')) ?? null;
}

async function check(): Promise<void> {
  if (inFlight || Date.now() - lastSuccess < MIN_INTERVAL_MS) return;
  const base = deployedBase();
  if (!base) return;
  inFlight = true;
  try {
    const deployed = await fetchDeployed(base);
    if (!deployed) return;
    lastSuccess = Date.now();
    if (deployed.build === updateReady.value?.build || !await isNewer(deployed)) return;
    await downloadDeployed(deployed as DeployedBundle, base);
  } catch (err) {
    // Offline, or a download that failed its checksum: tried again on the
    // next trigger, and nothing is offered until a bundle is fully here.
    console.warn('[ota] check failed', err);
  } finally {
    inFlight = false;
  }
}

/** Same triggers as the web check: start, back to the foreground, network
 *  back, and every half hour while visible.
 *
 *  Not for a local build with uncommitted changes (`dirty`): that is a
 *  development install, which the deployed build must not be offered to
 *  replace — it may well be older than what is being tested. Unless a test
 *  deploy is set (OTA_TEST_KEY). */
export function initNativeUpdateCheck(): void {
  if (APP_BUILD.dirty && !localStorage.getItem(OTA_TEST_KEY)) return;
  const visibleCheck = () => { if (document.visibilityState === 'visible') void check(); };
  void check();
  window.addEventListener('online', () => void check());
  document.addEventListener('visibilitychange', visibleCheck);
  setInterval(visibleCheck, PERIOD_MS);
}

/** At a page start, before anything is on screen: moves to the deployed
 *  version if it is newer (2026-10-09 — users reopened the app, or pulled to
 *  refresh, and still had the old version until they found the pill; the PWA
 *  gets the new one by itself on both). When it switches, the page reloads
 *  and this never returns.
 *
 *  The bundle already downloaded for that build is taken as it is; otherwise
 *  it is downloaded now, behind the update screen (updateOverlay.tsx), whose
 *  `Later` lets the app start on what it has — the download carries on, and
 *  the pill offers it once done. No answer from version.json within
 *  START_PROBE_MS: a bundle downloaded earlier is still taken if it is newer,
 *  so that an update fetched yesterday arrives offline.
 *
 *  Here, and not through the plugin's own `next()`: that one applies when the
 *  app goes to the BACKGROUND, which is the screen turning off during a live
 *  recording — the reload would end it. A page start has nothing running to
 *  lose: a cold launch, or the pull-to-refresh, which is off during a
 *  recording (appShell.ts). A return from the background never comes through
 *  here. */
export async function updateAtPageStart(root: HTMLElement): Promise<void> {
  const base = deployedBase();
  if (!base) return;
  try {
    const deployed = await within(START_PROBE_MS, fetchDeployed(base).catch(() => null), null);
    let target: BundleInfo | null;
    if (deployed) {
      if (!await isNewer(deployed)) return;
      target = await downloadedFor(deployed.build)
        ?? await downloadBehindOverlay(deployed as DeployedBundle, base, root);
    } else {
      target = await newestDownloaded();
    }
    if (!target) return;
    // The switch ends this page; its promise may never settle. Still here
    // after a few seconds means it did not happen.
    await within(4000, CapacitorUpdater.set({ id: target.id }).then(() => new Promise<void>(() => {})), undefined);
  } catch (err) {
    console.warn('[ota] could not update at page start', err);
  }
}

/** The update screen stays a plain background this long into the download
 *  before saying anything: on a good connection the download is over first,
 *  and the launch only looks a little longer than usual (the user's choice). */
const DETAIL_AFTER_MS = 2000;

/** The download, behind the update screen. Null when the user chose `Later`,
 *  or the download failed. */
async function downloadBehindOverlay(deployed: DeployedBundle, base: string, root: HTMLElement): Promise<BundleInfo | null> {
  const { showUpdateOverlay } = await import('./updateOverlay');
  let later = () => {};
  const skipped = new Promise<null>(r => { later = () => r(null); });
  const overlay = showUpdateOverlay(root, () => later());
  const listener = await CapacitorUpdater.addListener('download', e => {
    if (e.bundle.version === deployed.build) overlay.progress(e.percent);
  });
  const detail = setTimeout(() => overlay.detail(), DETAIL_AFTER_MS);
  try {
    return await Promise.race([downloadDeployed(deployed, base).catch(() => null), skipped]);
  } finally {
    clearTimeout(detail);
    void listener.remove();
    overlay.close();
  }
}

/** Offline, or version.json too slow: the newest bundle an earlier run
 *  downloaded, if it is newer than this one. */
async function newestDownloaded(): Promise<BundleInfo | null> {
  const listed = await within(1500, Promise.all([CapacitorUpdater.list(), CapacitorUpdater.current()]), null);
  if (!listed) return null;
  const [{ bundles }, { bundle: current }] = listed;
  const mine = builtAt(APP_BUILD.build);
  return bundles
    .filter(b => (b.status === 'success' || b.status === 'pending') && b.id !== current.id && builtAt(b.version) > mine)
    .sort((a, b) => builtAt(b.version) - builtAt(a.version))[0] ?? null;
}

/** The pill's action: switch to the downloaded bundle, which reloads the app. */
export async function applyNativeUpdate(): Promise<void> {
  if (!readyBundleId) return;
  await CapacitorUpdater.set({ id: readyBundleId });
}
