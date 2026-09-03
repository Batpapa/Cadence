import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, dumpRawDatabase, loadUser, saveUser, getAllUserIds, loadLegacyState, deleteLegacyState, loadAllUsers, getLastUserId, setLastUserId, deleteUser, touchUserOrder, removeUserFromOrder } from './db';
import { emptyState } from './utils';
import { appState, commitState, routeSignal, goBack, goForward, loadSavedRoute, initRoutePersistence } from './store';
import { ensureCurrentUser, ensureCurrentProfile, detectLanguage } from './services/userService';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage } from './services/i18nService';
import { initPWA } from './services/pwaService';
import { initDriveClient, isDriveConnected, readDriveFile, reconcileDriveData, initDriveVisibilitySync, initDriveForUser, clearDriveStateForUser, resumePendingSync, setReconcileHook, markReconcileFailed } from './services/driveService';
import { clearSnapshotsForUser } from './services/snapshotService';
import { initSessionDbForUser, collectUserSessionAudio, userDbName } from './session/db';
import { buildZip, audioExtension } from './services/zip';
import { applyDriveState, showDriveConflictModal } from './components/driveConflictModal';
import { migrateState, migrateLegacyToUser } from './services/migration';
import { applyZoom } from './services/zoomService';
import { applyTheme } from './services/themeService';
import { mountApp, mountUserSelector } from './appRoot';
import { showHelpModal } from './components/help';
import { getContext } from './store';
import type { User } from './types';

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

// Top-level, next to the service worker it depends on — NOT from finishBoot().
// `beforeinstallprompt` fires once, shortly after the worker takes control, and
// is lost if no listener exists yet; boot is async and, on the user-selector
// screen, never reaches finishBoot() at all. See pwaService's own comment.
initPWA();

screen.orientation?.unlock?.();

export async function createAndOpenUser(name: string, root: HTMLElement): Promise<void> {
  const user = emptyState();
  user.name = name;
  user.language = detectLanguage();
  ensureCurrentUser(user);
  ensureCurrentProfile(user);
  initDriveForUser(user.id);
  commitState(user);
  await saveUser(user);
  setLastUserId(user.id);
  touchUserOrder(user.id);
  setLanguage(user.language);
  // Must run after appState.value is set — its migration path (a brand-new
  // user never has legacy data, but the check itself still needs the right
  // user in scope) reads/writes AppState via store.ts's mutate().
  await initSessionDbForUser(user.id);
  initRoutePersistence(user.id);
  finishBoot(root);
  setTimeout(() => showHelpModal(getContext()), 0);
}

async function showUserSelector(root: HTMLElement): Promise<void> {
  setLanguage(detectLanguage());
  applyTheme();
  applyZoom();
  const users = await loadAllUsers();
  mountUserSelector(root, users,
    (id)   => openUser(id, root),
    (name) => createAndOpenUser(name, root),
    async (id) => { clearDriveStateForUser(id); await clearSnapshotsForUser(id); removeUserFromOrder(id); await deleteUser(id); await showUserSelector(root); },
  );
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
  // See createAndOpenUser's identical comment — must run after appState.value.
  await initSessionDbForUser(id);
  const savedRoute = loadSavedRoute(saved);
  if (savedRoute) routeSignal.value = savedRoute;
  initRoutePersistence(saved.id);
  finishBoot(root);
}

(async () => {
  const root = document.getElementById('app')!;

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

    // ── Migration: old single-blob AppState → new User store ──────────────────
    const legacy = await loadLegacyState();
    if (legacy && (legacy['currentUserId'] as string)) {
      migrateState(legacy as unknown as User);
      const user = migrateLegacyToUser(legacy);
      ensureCurrentUser(user);
      ensureCurrentProfile(user);
      commitState(user);
      await saveUser(user);
      await deleteLegacyState();
      setLastUserId(user.id);
      setLanguage(user.language);
      // See createAndOpenUser's identical comment — must run after appState.value.
      await initSessionDbForUser(user.id);
      initRoutePersistence(user.id);
      finishBoot(root);
      return;
    }

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

/** Shown either after a real boot failure (initDb() timing out because
 *  another tab/connection deadlocked the IndexedDB upgrade lock — see db.ts —
 *  `err` is set), or on demand via `?mode=recovery` (no `err`) so someone can
 *  be pointed here to self-serve a per-user data download even when their app
 *  otherwise loads fine. Lists every local user by name/id so with 2+ users
 *  on the same device it's clear which one's data is being sent — there is
 *  deliberately no "erase everything" option, since that would destroy
 *  anything not synced to Drive. */
async function showRecoveryScreen(root: HTMLElement, err?: unknown): Promise<void> {
  const message = err !== undefined ? (err instanceof Error ? err.message : String(err)) : null;

  root.innerHTML = `
    <div class="p-8 max-w-3xl mx-auto space-y-4">
      <h1 class="text-lg font-semibold text-center">Recovery</h1>
      ${message
        ? `<p class="text-danger font-mono text-sm text-center">Failed to initialize: ${escapeHtml(message)}</p>
           <p class="text-xs text-muted text-center">This can happen if another tab got stuck holding your local data open, or if it became corrupted.</p>
           <div class="flex justify-center"><button id="recovery-retry" class="btn-primary text-sm">Retry</button></div>`
        : `<p class="text-xs text-muted text-center">Download your data below, then use "Report a bug" to send it over.</p>`}
      <div id="recovery-users" class="space-y-2 overflow-x-auto"></div>
      <div class="flex gap-2 justify-center pt-2 border-t border-border">
        <button id="recovery-raw" class="btn-ghost text-sm">Download full raw dump</button>
        <button id="recovery-report" class="btn-ghost text-sm">Report a bug on GitHub</button>
      </div>
    </div>`;

  document.getElementById('recovery-retry')?.addEventListener('click', () => location.reload());
  document.getElementById('recovery-raw')?.addEventListener('click', () => { void downloadRawDump(message); });
  document.getElementById('recovery-report')?.addEventListener('click', () => { void reportBug(message); });

  const usersEl = document.getElementById('recovery-users')!;
  try {
    // ?mode=recovery skips normal boot entirely, so initDb() was never called
    // in that path — a real boot failure (message set) already tried and
    // failed, so skip straight to listing (which will itself throw below).
    if (!message) await initDb();
    const ids = await getAllUserIds();
    if (ids.length === 0) {
      usersEl.innerHTML = `<p class="text-xs text-muted text-center">No local users found on this device.</p>`;
      return;
    }
    // One batched lookup instead of a per-user existence check — tells us
    // which users actually have a session database on this device, so the
    // "Download sessions" button only shows up where there's something to get.
    const sessionDbNames = indexedDB.databases ? new Set((await indexedDB.databases()).map(d => d.name)) : null;

    for (const id of ids) {
      const user = await loadUser(id);
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 p-2 rounded border border-border whitespace-nowrap';
      const idTag = document.createElement('span');
      // Always shown in full, never wrapped/truncated — the one thing this
      // screen exists to make legible for debugging.
      idTag.className = 'text-xs text-muted font-mono select-all shrink-0';
      idTag.textContent = id;
      const nameTag = document.createElement('span');
      nameTag.className = 'text-sm truncate min-w-0 flex-1';
      nameTag.textContent = user?.name ?? 'Unnamed';

      const safeName = (user?.name ?? 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const btns = document.createElement('span');
      btns.className = 'flex gap-1 shrink-0';

      const btn = document.createElement('button');
      btn.className = 'btn-ghost text-xs shrink-0 inline-flex items-center gap-1.5';
      btn.innerHTML = `${EXPORT_SVG}Data`;
      // Downloaded as .cdb, id stripped — the exact shape Settings → Backup →
      // Import accepts, so recovery-to-restore is: download here, import there.
      btn.onclick = () => {
        const { id: _id, ...data } = (user ?? { id }) as Record<string, unknown> & { id?: string };
        downloadJson(data, `cadence-user-${safeName}-${id}.cdb`);
      };
      btns.appendChild(btn);

      // `?.has` may be true, false, or unknown (Safari lacks databases()) —
      // when unknown, still offer the button and let the click itself
      // discover there's nothing there (collectUserSessionAudio returns null).
      if (sessionDbNames === null || sessionDbNames.has(userDbName(id))) {
        const audioBtn = document.createElement('button');
        audioBtn.className = 'btn-ghost text-xs shrink-0 inline-flex items-center gap-1.5';
        audioBtn.innerHTML = `${EXPORT_SVG}Audio`;
        audioBtn.onclick = () => { void downloadSessionAudioZip(id, safeName, user); };
        btns.appendChild(audioBtn);
      }

      row.append(idTag, nameTag, btns);
      usersEl.appendChild(row);
    }
  } catch (listErr) {
    console.error('Recovery: failed to list users:', listErr);
    usersEl.innerHTML = `<p class="text-xs text-muted text-center">Couldn't list individual users — try "Download full raw dump" instead.</p>`;
  }
}

/** Every audio this user has on this device, zipped: finalized sessions,
 *  imports, and crash-orphaned recordings reassembled from their chunks. A
 *  raw DB dump was useless here — Blobs JSON-serialize to {} — where actual
 *  files play anywhere. Session names come from AppState metadata when
 *  available, from the local draft otherwise, from the id as a last resort. */
async function downloadSessionAudioZip(id: string, safeName: string, user: Awaited<ReturnType<typeof loadUser>>): Promise<void> {
  try {
    const collected = await collectUserSessionAudio(id);
    if (!collected || (collected.audio.length === 0 && collected.orphans.length === 0)) {
      alert('No session audio found for this user.');
      return;
    }
    const metaSessions = ((user?.modules?.['tune-analyser'] as { sessions?: Record<string, { name?: string; mimeType?: string }> } | undefined)?.sessions) ?? {};
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
    const seen = new Map<string, number>();
    const unique = (base: string): string => {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}-${n}`;
    };
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    for (const { sessionId, blob } of collected.audio) {
      const meta = metaSessions[sessionId];
      const nice = clean(meta?.name ?? collected.draftNames[sessionId] ?? sessionId);
      const ext = audioExtension(blob.type || meta?.mimeType || collected.draftMimes[sessionId]);
      entries.push({ name: `${unique(nice)}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    for (const { recordingId, blob } of collected.orphans) {
      const nice = clean(collected.draftNames[recordingId] ?? recordingId);
      const ext = audioExtension(blob.type || collected.draftMimes[recordingId]);
      entries.push({ name: `recovered-${unique(nice)}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const zip = buildZip(entries);
    const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cadence-audio-${safeName}-${id}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Recovery: audio zip failed:', e);
    alert(`Couldn't collect this user's audio: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Same icon as the "Export" button in settingsModal.ts, for the same action.
const EXPORT_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, c => map[c]!);
}

/** Best-effort dump of every object store across every user (see db.ts) —
 *  works even when per-user listing above failed, since it reads via cursors
 *  on the raw IndexedDB API instead of through the (possibly broken) idb/User
 *  layer. */
async function downloadRawDump(message: string | null): Promise<void> {
  try {
    const dump = await dumpRawDatabase();
    const filename = `cadence-raw-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    downloadJson({ error: message, userAgent: navigator.userAgent, capturedAt: new Date().toISOString(), data: dump }, filename);
  } catch (dumpErr) {
    console.error('Failed to generate raw dump:', dumpErr);
    alert("Couldn't read the local database at all — sorry, there's nothing to download.");
  }
}

/** Opens a prefilled GitHub issue; the user still needs to manually drag in
 *  whichever downloaded file(s) apply. */
function reportBug(message: string | null): void {
  const title = message ? `Boot crash: ${message}` : 'Bug report';
  const body =
    `Please drag in the file(s) you downloaded from the Recovery screen.\n\n` +
    (message ? `Technical error:\n\`\`\`\n${message}\n\`\`\`\n\n` : '') +
    `What were you doing right before this happened?\n`;
  window.open(
    `https://github.com/Batpapa/Cadence/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
    '_blank', 'noopener'
  );
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

function finishBoot(root: HTMLElement): void {
  applyTheme();
  applyZoom();
  initDriveVisibilitySync();

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
      }
    })();
  }

  mountApp(root);
  registerCommandPalette(getContext);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
  });
}
