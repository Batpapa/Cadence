import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, loadUser, saveUser, getAllUserIds, loadAllUsers, getLastUserId, setLastUserId, touchUserOrder } from './db';
import { markBootSettled } from './bootSettled';
import { emptyState } from './services/migration';
import { isTouchPrimaryDevice, isAppleTouchDevice } from './services/device';
import { appState, commitState, applyFromDrive, routeSignal, loadSavedRoute, initRoutePersistence } from './store';
import { ensureCurrentUser, ensureCurrentProfile, welcomeLanguage } from './services/userService';
import { newUserExtensions } from './services/extensions';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage, lastShownLanguage } from './services/i18nService';
import { initPWA } from './services/pwaService';
import { initUpdateCheck } from './services/updateService';
import { swallowReportedSaveRejections } from './services/saveHealth';
import { ensurePersistentStorage } from './services/storageService';
import { initDriveClient, isDriveConnected, readDriveFile, reconcileDriveData, initDriveVisibilitySync, initDriveTokenRenewal, initDriveForUser, resumePendingSync, setReconcileHook, markReconcileFailed, connectDrive, clearDriveStateForUser, getDriveAccountEmail, isDriveFeatureEnabled, isLikelyInAppBrowser, markSyncedAfterApply, syncToCloud, manualSync, localUsersOnSameDrive, adoptDriveConnection, refreshFromDrive, type ConnectResult } from './services/driveService';
import { isTextField } from './services/softKeyboard';
import { sessionRecordingSignal } from './session/ui/sessionStore';
import { initSessionDbForUser, initAudioUploadRetry } from './session/db';
import { initAudioDownloads } from './session/audioDownloads';
import { installCardRecognition } from './session/recognition/cardIndexSource';
import { initAttachmentDbForUser } from './services/attachmentDb';
import { initAttachmentSync } from './services/attachmentStore';
import { applyDriveState, showDriveConflictModal } from './components/driveConflictModal';
import { migrateState, applyExternalData } from './services/migration';
import { applyZoom } from './services/zoomService';
import { applyTheme } from './services/themeService';
import { mountApp } from './appRoot';
import { mountUserSelector, type DriveRecovery } from './userSelector';
import { getContext } from './store';
import { anyOverlayOpen, closeTopOverlay } from './components/overlayStack';
import { isNative } from './native/platform';
import { importStagedAnalyses, hasStagedAnalyses } from './services/standaloneHandoff';
import { showUsageChoiceModal } from './components/usageChoice';
import { showRecoveryScreen } from './recoveryScreen';
import type { User } from './types';

// index.html's bootstrap found a browser too old to run Cadence and is putting
// up a message instead; nothing below may start (see the check there).
if (document.documentElement.dataset.unsupported) throw new Error('Cadence: browser too old');

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

// Top-level too: the welcome screen never reaches finishBoot(), and a resumed
// tablet can sit on it as easily as on the app.
initUpdateCheck();

// A save failure is shown to the user once, by saveHealth; the rejection each
// `void mutate(…)` then leaves behind is not a second, separate error.
swallowReportedSaveRejections();

// Top-level, next to the service worker it depends on — NOT from finishBoot().
// `beforeinstallprompt` fires once, shortly after the worker takes control, and
// is lost if no listener exists yet; boot is async and, on the user-selector
// screen, never reaches finishBoot() at all. See pwaService's own comment.
initPWA();

// Top-level and deliberately not awaited: nothing downstream depends on the
// answer, and boot must not wait on a permission heuristic.
//
// Once per launch is enough, and this is the only automatic call. The
// request is idempotent — it early-returns when already granted — so
// repeating it elsewhere in the same run would do nothing: a browser that
// refused decides on the interaction HISTORY of the site, not on whatever
// the user just clicked, so there is no second moment within a session that
// is worth asking at. A refusal gets its next chance at the next launch, or
// from the button in the storage panel. See storageService.ts for what
// best-effort storage means and why this exists at all.
void ensurePersistentStorage();

// Safari (16.4+) throws, synchronously, when the page is not visible: a tab
// opened in the background, a reload while hidden. Uncaught here, that ended
// the whole module before boot — a blank page, not even the recovery screen.
try { screen.orientation?.unlock?.(); } catch { /* nothing was locked */ }

function blankUser(): User {
  const user = emptyState();
  user.language = welcomeLanguage();
  ensureCurrentUser(user);
  ensureCurrentProfile(user);
  return user;
}

export async function createAndOpenUser(name: string, root: HTMLElement): Promise<void> {
  const user = blankUser();
  user.name = name;
  initDriveForUser(user.id);
  await openBrandNewUser(user, root);
}

/** The opened user's own storage: its analyser database, its attachments'
 *  database and their sync. Every way of opening a user goes through here, so
 *  a store added later is added once.
 *
 *  Must run after appState.value holds this user (commitState): the analyser
 *  database's migration path reads and writes AppState through store.ts's
 *  mutate() — a brand-new user never has legacy data, but the check itself
 *  still needs the right user in scope. */
async function openUserStores(userId: string): Promise<void> {
  await initSessionDbForUser(userId);
  initAttachmentDbForUser(userId);
  initAttachmentSync();
}

/** Everything after the Drive bookkeeping has been initialised for `user`. */
async function openBrandNewUser(user: User, root: HTMLElement): Promise<void> {
  // Extensions off for a new user, written out: absent means on
  // (extensions.ts). Here, the one way in for a user who is really new — NOT
  // in blankUser, whose user a Drive recovery fills by Object.assign: data
  // from before extensions has no such field, and would have inherited this.
  user.extensions = newUserExtensions();
  commitState(user);
  await saveUser(user);
  setLastUserId(user.id);
  touchUserOrder(user.id);
  setLanguage(user.language);
  await openUserStores(user.id);
  initRoutePersistence(user.id);
  // Asked BEFORE finishBoot, which takes the standalone analyser's waiting
  // analyses in: someone bringing those has answered already — their import
  // switches the extension on, and "Default" would then hide them.
  const broughtAnalyses = await hasStagedAnalyses().catch(() => false);
  finishBoot(root);
  // What the new user is here for, then the tour of the interface — once
  // answered, not over the question (2026-10-27: the walkthrough replaced the
  // help's guide here; the guide stays one tab away in the help).
  //
  // At once, where it waited for a `setTimeout(0)` from 2026-06-01 — a need
  // of the modals then, built in the page by hand. A dialog is now only an
  // entry on modal.tsx's stack, shown by the ModalHost that mountApp (in
  // finishBoot, synchronous) has just put up; nothing closes the stack on the
  // way up.
  const discover = () => { void import('./walkthrough/engine').then(m => m.startScenario('discover')); };
  if (broughtAnalyses) discover();
  else showUsageChoiceModal(getContext(), discover);
}

/** The welcome screen's "restore my data" (2026-09-14). Getting one's data
 *  onto a new device used to take knowing the trick: create a throwaway user,
 *  then connect Drive from Settings BEFORE touching anything — one edit first
 *  and the connect raised a conflict screen instead of simply applying Drive.
 *
 *  The user is built in memory and bound to Drive before anything reaches
 *  IndexedDB, so abandoning the flow at any step leaves no stray user behind.
 *  Its edit counter is zero by construction, so a found Drive file is applied
 *  outright — there is nothing local to arbitrate, and nothing to snapshot. */
async function recoverUserFromDrive(root: HTMLElement): Promise<DriveRecovery> {
  const user = blankUser();
  initDriveForUser(user.id);
  // Only localStorage bookkeeping exists for this id until it is kept.
  const discard = () => clearDriveStateForUser(user.id);

  let result: ConnectResult;
  try {
    result = await connectDrive();
  } catch (e) {
    discard();
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('popup_closed') || msg.includes('access_denied')) return { kind: 'cancelled' };
    return { kind: 'failed', inAppBrowser: isLikelyInAppBrowser() };
  }

  // Once the file is found, it identifies the data beyond doubt. A user of this
  // device already bound to it (or to this account) IS the data being looked for,
  // however old its bookkeeping — see localUsersOnSameDrive. Opened even when it
  // had disconnected Drive, and reconnected on the way (adoptDriveConnection).
  if (result.action === 'apply' || result.action === 'conflict' || result.action === 'none') {
    const existing = new Set(await getAllUserIds());
    const known = localUsersOnSameDrive(user.id).find(id => existing.has(id));
    if (known) {
      adoptDriveConnection(user.id, known);
      discard();
      await openUser(known, root);
      return { kind: 'opened' };
    }
  }

  switch (result.action) {
    case 'shared_account':
      // This Google account already syncs a user of this device: that user IS
      // the data being looked for. Its own boot reconciles it with Drive.
      discard();
      await openUser(result.userId, root);
      return { kind: 'opened' };

    case 'wrong_account':
      // Needs a recorded owner, which a user created a moment ago cannot have.
      discard();
      return { kind: 'failed', inAppBrowser: false };

    case 'apply':
    case 'conflict': {
      // 'conflict' cannot come from a zero edit counter either; if it ever
      // did, local still holds nothing, so Drive wins all the same.
      const data = applyExternalData(result.state as unknown as Record<string, unknown>, user.id);
      if (!data.name?.trim()) data.name = getDriveAccountEmail().split('@')[0] || 'Cadence';
      commitState(user);
      await applyFromDrive(s => { Object.assign(s, data); });
      markSyncedAfterApply(result.driveTs, result.version);
      setLastUserId(user.id);
      touchUserOrder(user.id);
      setLanguage(appState.value.language);
      await openUserStores(user.id);
      initRoutePersistence(user.id);
      finishBoot(root);
      return { kind: 'opened' };
    }

    case 'none':
      // Nothing on this account yet. The connection is made and kept only if a
      // name is given: this becomes an ordinary new user, already synced.
      return {
        kind: 'empty',
        email: getDriveAccountEmail(),
        finish: async (name) => {
          user.name = name;
          await openBrandNewUser(user, root);
          // Same as Settings' connect on an empty Drive: push the first copy.
          syncToCloud(appState.value);
          void manualSync();
        },
        cancel: discard,
      };
  }
}

async function showUserSelector(root: HTMLElement): Promise<void> {
  setLanguage(welcomeLanguage());
  applyTheme();
  applyZoom();
  const users = await loadAllUsers();
  // Selecting, creating or restoring, and nothing else: removing a user moved
  // to Settings → User on 2026-09-13 (see settingsModal's removeUserFromDevice).
  mountUserSelector(root, users,
    (id)   => openUser(id, root),
    (name) => createAndOpenUser(name, root),
    isDriveFeatureEnabled() ? () => recoverUserFromDrive(root) : null,
  );
  markNativeBundleReady();
}

export async function openUser(id: string, root: HTMLElement): Promise<void> {
  initDriveForUser(id);

  const saved = await loadUser(id);
  if (!saved) return;
  migrateState(saved);
  ensureCurrentUser(saved);
  ensureCurrentProfile(saved);
  setLanguage(saved.language);
  commitState(saved);
  await saveUser(saved);
  setLastUserId(id);
  touchUserOrder(id);
  await openUserStores(id);
  const savedRoute = loadSavedRoute(saved);
  if (savedRoute) routeSignal.value = savedRoute;
  initRoutePersistence(saved.id);
  finishBoot(root);
}

(async () => {
  const root = document.getElementById('app')!;

  // The Android app reopened, or pulled to refresh, while a newer version is
  // deployed: move to it now, rather than wait for the header's pill — what a
  // PWA gets by itself on both. Nothing below runs then: the switch reloads
  // the page before this returns.
  if (isNative()) {
    // The update screen speaks the language the app last showed, in this
    // device's theme: no user is loaded yet, and the app is about to open on
    // the same one. index.html's bootstrap alone falls back to dark.
    setLanguage(lastShownLanguage() ?? welcomeLanguage());
    applyTheme();
    await (await import('./native/otaUpdate')).updateAtPageStart(root);
  }

  // The Android app's system Back, from the very first screen on — the
  // recovery screen included.
  if (isNative()) void import('./native/appShell').then(m => m.initNativeShell());

  // Manual entry point, e.g. https://.../?mode=recovery — a link you can send
  // someone whose Cadence is misbehaving, so they can self-serve into a
  // per-user data download + bug report without needing a real boot crash
  // (initDb() may well succeed for them). Also doubles as an easy way to
  // test the recovery screen in dev.
  if (new URLSearchParams(location.search).get('mode') === 'recovery') {
    await showRecoveryScreen(root);
    return;
  }

  try {
    await initDb();

    // The single-blob store of before 2026-06-01 is no longer moved into the
    // per-user one: that migration went on 2026-11-26, every user from before
    // then being known and long migrated (db.ts's LEGACY_STORE).

    // ── Normal boot ───────────────────────────────────────────────────────────
    const lastId  = getLastUserId();
    const userIds = await getAllUserIds();

    if (lastId && userIds.includes(lastId)) {
      await openUser(lastId, root);
      return;
    }

    // No active user → show selector
    await showUserSelector(root);

  } catch (err) {
    console.error('Failed to start Cadence:', err);
    void showRecoveryScreen(root, err);
  }
})();

/** Android app: this web bundle reached a usable screen, so the over-the-air
 *  updater must not roll it back (native/otaUpdate.ts). Deliberately not
 *  called on the recovery screen: a bundle that only gets that far is the
 *  broken one the rollback exists for. */
function markNativeBundleReady(): void {
  if (isNative()) void import('./native/otaUpdate').then(m => m.markAppReady());
}

/**
 * Read Drive and settle it against local: fast-forwards apply silently, real
 * divergences raise the explicit conflict modal. Runs at boot — the point being
 * that another device's edits land *before* the user starts editing on top of
 * stale data — and again from the cloud button if that boot attempt failed.
 * Throws if Drive could not be read, so callers can tell "settled" from "never
 * saw it"; the interactive flag is on because both callers are moments where a
 * consent window is allowed (page load, or a click).
 */
async function reconcileWithDrive(interactive = true): Promise<boolean> {
  // initDriveClient() rejects if Google's script never arrives, so it belongs
  // inside the caller's try: on a flaky connection it is the step that fails.
  await initDriveClient();
  // Throws when the file can't be read — treating a failed read as an empty
  // Drive is how local silently becomes the winner over unread data.
  const file = await readDriveFile(interactive);
  const result = reconcileDriveData(file);
  if (result.action === 'apply') {
    // Also discards any buffered upload and settles the status (green) —
    // see markSyncedAfterApply.
    await applyDriveState(result.state, result.driveTs, result.version);
    return false;
  }
  if (result.action === 'conflict') {
    // May resolve without asking anything when the two copies turn out to hold
    // the same content — see showDriveConflictModal. Either way local does not
    // "win" here: the user is mid-decision, or the sync point has just been
    // recorded and there is nothing left to push.
    showDriveConflictModal(result.state, result.driveTs, result.version, result.driveDeviceId);
    return false;
  }
  // 'none' means local is the version to keep. If it also holds edits that
  // never reached Drive (the tab that made them was closed before a flush
  // succeeded), push them now — nothing else would.
  resumePendingSync(appState.value);
  return true;
}

/** How long the page must have been out of sight before coming back re-reads
 *  Drive: switching away for a moment is not leaving. */
const FOREGROUND_REFRESH_AFTER_MS = 30_000;

/**
 * Back in the foreground after a while: take in what another device wrote
 * meanwhile (refreshFromDrive). An installed app is resumed far more often than
 * started, and boot used to be the only read — the computer's edits stayed
 * invisible until a reload, and the first edit here then met them as a conflict
 * (2026-10-06).
 *
 * Not while recording or importing (stop() does its own read before saving),
 * not with a dialog open, not with a text field focused: an apply remounts the
 * views, and what is being typed or edited there would be lost.
 */
function initForegroundDriveRefresh(): void {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (away < FOREGROUND_REFRESH_AFTER_MS) return;
    if (sessionRecordingSignal.value || anyOverlayOpen() || isTextField(document.activeElement)) return;
    void refreshFromDrive();
  });
}

function finishBoot(root: HTMLElement): void {
  applyTheme();
  applyZoom();
  initDriveVisibilitySync();
  initForegroundDriveRefresh();
  initDriveTokenRenewal();

  // isDriveConnected() is a plain localStorage read — checking it first avoids
  // ever loading the Google Identity script (and its request to Google) for the
  // majority of sessions that have never connected Drive.
  // Registered UNCONDITIONALLY — not just when Drive is already connected:
  // every flush now runs a version precondition, and a first-ever connect made
  // in this same session needs the hook for its own first push.
  setReconcileHook(reconcileWithDrive);
  if (isDriveConnected()) {
    void (async () => {
      try {
        // Known-offline needs no round trip: waiting out the Drive client's
        // load timeout would leave the sync button inert for seconds after a
        // reload, which is precisely when someone checks whether their offline
        // edits are safe. Nothing is stale-by-surprise here — the user knows
        // they are offline — so this is not the failure case below.
        if (!navigator.onLine) { resumePendingSync(appState.value); return; }
        await reconcileWithDrive();
      } catch {
        // Reading Drive failed while online — a blocked consent window, a
        // flaky connection. Local data is kept, but it may be behind another
        // device and the user must not be told everything is fine: editing now
        // is what turns "behind" into a divergence to arbitrate.
        markReconcileFailed();
        resumePendingSync(appState.value);
      } finally {
        // Whichever way it went: what waits for boot's work with Drive may go.
        markBootSettled();
      }
    })();
  } else {
    // No Drive to read: boot's work with it is already done.
    markBootSettled();
  }

  mountApp(root);
  markNativeBundleReady();
  registerCommandPalette(getContext);
  // Recordings whose automatic copy to Drive did not go through, sent again.
  initAudioUploadRetry();
  // …and, the other way, the ones on Drive brought here if this device asked.
  initAudioDownloads();
  // The user's tune cards recognised alongside TheSession's index, as the
  // analyser's options say, and their versions readable by its views
  // (cardIndexSource.ts).
  installCardRecognition(() => appState.value);
  // Analyses carried over from the standalone analyser, if its "sign in to
  // keep them" was used (standaloneHandoff.ts): into this user's analyser.
  void importStagedAnalyses(getContext());

  // Alt+← / Alt+→ used to be handled here. Removed on 2026-09-10: they are
  // the browser's OWN shortcut for back and forward, and since the history
  // bridge went in, the native gesture lands on the same popstate handler
  // the buttons do. Intercepting it only to re-issue it was a duplicate that
  // could drift from the platform, never a feature.

  // Escape closes the topmost overlay — ONE listener, asking the one registry
  // that knows what is really on top. Before this (2026-09-10) every overlay
  // ran its own document-level listener, so each could only reason about its
  // own kind: a modal knew about modals and nothing about the lightbox opened
  // over it. Two of them firing on one keypress closed two things.
  //
  // Bubble phase, not capture: an Escape inside an overlay that means
  // something narrower — cancelling an inline rename, closing a dropdown —
  // has to be able to stop it before it gets here, and a capturing listener
  // would beat every one of those to it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (closeTopOverlay()) e.preventDefault();
  });

  // A tap anywhere on a date field opens its picker. Chrome Android 155 draws
  // these fields as the desktop ones (145 did not; measured 2026-10-12): a tap
  // on the text selects the day or the year, and only the small calendar icon
  // opens the picker — "touching the date opens nothing". Touch only: with a
  // mouse, clicking into the text to type is the point of that UI. Not iOS,
  // whose field is a single button that opens its own wheel anyway.
  //
  // The click's default is cancelled only once showPicker() has opened the
  // picker, so that the browser's own opening — the old Android field opens
  // on that same tap — does not try for a second one. If it throws, the tap is
  // left to do whatever it did before.
  if (isTouchPrimaryDevice() && !isAppleTouchDevice()) {
    document.addEventListener('click', (e) => {
      const el = e.target;
      if (e.defaultPrevented || !(el instanceof HTMLInputElement)) return;
      if (!/^(date|datetime-local|time|month)$/.test(el.type) || el.disabled || el.readOnly) return;
      if (typeof el.showPicker !== 'function') return;
      try {
        el.showPicker();
        e.preventDefault();
      } catch { /* left to the browser */ }
    });
  }
}
