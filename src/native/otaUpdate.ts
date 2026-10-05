import { App } from '@capacitor/app';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { APP_BUILD, updateReady } from '../services/updateService';

/**
 * Over-the-air updates for the Android app — the native half of
 * services/updateService.ts, feeding the same `updateReady` signal and so the
 * same header pill.
 *
 * The app carries its own copy of the web app; a deploy reaches it through a
 * zip of the build that the Pages workflow publishes next to version.json
 * (scripts/ota-bundle.js). Here: read the DEPLOYED version.json, download that
 * zip in the background (checksum checked by the plugin), and only then offer
 * it. Applying swaps the WebView onto the new files; the plugin falls back to
 * the previous bundle by itself if the new one never reports a successful
 * start (`markAppReady`, within its 10 s).
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

let lastSuccess = 0;
let inFlight = false;
/** The downloaded bundle the pill would apply. */
let readyBundleId: string | null = null;

/** The running bundle started properly. Without this the plugin takes a
 *  freshly applied bundle for a broken one and rolls back. Called once the
 *  app or the user selector is on screen — not earlier, so that a bundle
 *  that cannot boot does get rolled back. */
export function markAppReady(): void {
  void CapacitorUpdater.notifyAppReady().catch(() => { /* bundled build: nothing to confirm */ });
}

async function check(): Promise<void> {
  if (inFlight || Date.now() - lastSuccess < MIN_INTERVAL_MS) return;
  const base = deployedBase();
  if (!base) return;
  inFlight = true;
  try {
    const res = await fetch(new URL('version.json', base).href, { cache: 'no-store' });
    if (!res.ok) return;
    const deployed = await res.json() as DeployedNative;
    lastSuccess = Date.now();
    if (!deployed.native || typeof deployed.build !== 'string') return;
    if (deployed.build === APP_BUILD.build || deployed.build === updateReady.value?.build) return;
    // Unlike the PWA, the app may run a build made elsewhere than the deploy:
    // a released APK. Built from the deployed commit, it is the same code under
    // another build id — nothing to offer. Built from a later commit than the
    // one deployed, the deploy is OLDER — never offered as an update.
    if (deployed.commit === APP_BUILD.commit || !(builtAt(deployed.build) > builtAt(APP_BUILD.build))) return;
    // An APK older than what the bundle needs would load code calling into
    // native features it does not have: leave it on what it has.
    const { build: nativeBuild } = await App.getInfo();
    if (Number(nativeBuild) < deployed.native.minNativeBuild) return;

    const bundle = await CapacitorUpdater.download({
      url: new URL(deployed.native.bundle, base).href,
      version: deployed.build,
      checksum: deployed.native.sha256,
    });
    readyBundleId = bundle.id;
    updateReady.value = { version: deployed.version, commit: deployed.commit, dirty: !!deployed.dirty, build: deployed.build };
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
 *  replace — it may well be older than what is being tested. */
export function initNativeUpdateCheck(): void {
  if (APP_BUILD.dirty) return;
  const visibleCheck = () => { if (document.visibilityState === 'visible') void check(); };
  void check();
  window.addEventListener('online', () => void check());
  document.addEventListener('visibilitychange', visibleCheck);
  setInterval(visibleCheck, PERIOD_MS);
}

/** The pill's action: switch to the downloaded bundle, which reloads the app. */
export async function applyNativeUpdate(): Promise<void> {
  if (!readyBundleId) return;
  await CapacitorUpdater.set({ id: readyBundleId });
}
