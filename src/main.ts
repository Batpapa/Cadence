import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, dumpRawDatabase, loadUser, saveUser, getAllUserIds, loadLegacyState, deleteLegacyState, loadAllUsers, getLastUserId, setLastUserId, deleteUser, touchUserOrder, removeUserFromOrder } from './db';
import { emptyState } from './utils';
import { appState, routeSignal, goBack, goForward, loadSavedRoute, initRoutePersistence } from './store';
import { ensureCurrentUser, ensureCurrentProfile, detectLanguage } from './services/userService';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage } from './services/i18nService';
import { initPWA } from './services/pwaService';
import { initDriveClient, isDriveConnected, loadFromCloud, reconcileDriveData, initDriveVisibilitySync, initDriveForUser, clearDriveStateForUser } from './services/driveService';
import { initSessionDbForUser } from './session/db';
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

screen.orientation?.unlock?.();

export async function createAndOpenUser(name: string, root: HTMLElement): Promise<void> {
  const user = emptyState();
  user.name = name;
  user.language = detectLanguage();
  ensureCurrentUser(user);
  ensureCurrentProfile(user);
  initDriveForUser(user.id);
  initSessionDbForUser(user.id);
  await saveUser(user);
  setLastUserId(user.id);
  touchUserOrder(user.id);
  setLanguage(user.language);
  appState.value = user;
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
    async (id) => { clearDriveStateForUser(id); removeUserFromOrder(id); await deleteUser(id); await showUserSelector(root); },
  );
}

export async function openUser(id: string, root: HTMLElement): Promise<void> {
  initDriveForUser(id);
  initSessionDbForUser(id);

  const saved = await loadUser(id);
  if (!saved) return;
  migrateState(saved);
  ensureCurrentUser(saved);
  ensureCurrentProfile(saved);
  setLanguage(saved.language);
  await saveUser(saved);
  setLastUserId(id);
  touchUserOrder(id);
  appState.value = saved;
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
      initSessionDbForUser(user.id);
      await saveUser(user);
      await deleteLegacyState();
      setLastUserId(user.id);
      setLanguage(user.language);
      appState.value = user;
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
    <div class="p-8 max-w-lg mx-auto space-y-4">
      <h1 class="text-lg font-semibold text-center">Recovery</h1>
      ${message
        ? `<p class="text-danger font-mono text-sm text-center">Failed to initialize: ${escapeHtml(message)}</p>
           <p class="text-xs text-muted text-center">This can happen if another tab got stuck holding your local data open, or if it became corrupted.</p>
           <div class="flex justify-center"><button id="recovery-retry" class="btn-primary text-sm">Retry</button></div>`
        : `<p class="text-xs text-muted text-center">Download your data below, then use "Report a bug" to send it over.</p>`}
      <div id="recovery-users" class="space-y-2"></div>
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
    for (const id of ids) {
      const user = await loadUser(id);
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 p-2 rounded border border-border';
      const label = document.createElement('span');
      label.className = 'flex items-baseline gap-2 min-w-0';
      const nameTag = document.createElement('span');
      nameTag.className = 'text-sm truncate';
      nameTag.textContent = user?.name ?? 'Unnamed';
      const idTag = document.createElement('span');
      idTag.className = 'text-xs text-muted font-mono truncate';
      idTag.textContent = id;
      label.append(nameTag, idTag);
      const btn = document.createElement('button');
      btn.className = 'btn-ghost text-xs shrink-0';
      btn.textContent = 'Download';
      btn.onclick = () => {
        const safeName = (user?.name ?? 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        downloadJson(user ?? { id }, `cadence-user-${safeName}-${id}.json`);
      };
      row.append(label, btn);
      usersEl.appendChild(row);
    }
  } catch (listErr) {
    console.error('Recovery: failed to list users:', listErr);
    usersEl.innerHTML = `<p class="text-xs text-muted text-center">Couldn't list individual users — try "Download full raw dump" instead.</p>`;
  }
}

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

function finishBoot(root: HTMLElement): void {
  applyTheme();
  applyZoom();
  initPWA();
  initDriveVisibilitySync();

  // isDriveConnected() is a plain localStorage read — checking it first avoids
  // ever loading the Google Identity script (and its request to Google) for the
  // majority of sessions that have never connected Drive.
  if (isDriveConnected()) {
    void initDriveClient().then(async () => {
      try {
        // Same three-way reconciliation as the manual connect flow: fast-forwards
        // apply silently, real divergences raise the explicit conflict modal.
        const result = reconcileDriveData(await loadFromCloud());
        if (result.action === 'apply') {
          await applyDriveState(result.state, result.driveTs);
        } else if (result.action === 'conflict') {
          showDriveConflictModal(result.state, result.driveTs);
        }
      } catch { /* offline or transient failure — keep local data */ }
    });
  }

  mountApp(root);
  registerCommandPalette(getContext);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
  });
}
