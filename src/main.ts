import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, resetDatabase, loadUser, saveUser, getAllUserIds, loadLegacyState, deleteLegacyState, loadAllUsers, getLastUserId, setLastUserId, deleteUser, touchUserOrder, removeUserFromOrder } from './db';
import { emptyState } from './utils';
import { appState, routeSignal, goBack, goForward, loadSavedRoute, initRoutePersistence } from './store';
import { ensureCurrentUser, ensureCurrentProfile, detectLanguage } from './services/userService';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage } from './services/i18nService';
import { initPWA } from './services/pwaService';
import { initDriveClient, isDriveConnected, loadFromCloud, reconcileDriveData, initDriveVisibilitySync, initDriveForUser, clearDriveStateForUser } from './services/driveService';
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
  try {
    await initDb();

    // ── Migration: old single-blob AppState → new User store ──────────────────
    const legacy = await loadLegacyState();
    if (legacy && (legacy['currentUserId'] as string)) {
      migrateState(legacy as unknown as User);
      const user = migrateLegacyToUser(legacy);
      ensureCurrentUser(user);
      ensureCurrentProfile(user);
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
    showBootErrorScreen(root, err);
  }
})();

/** Boot failed to even reach a mounted UI (most commonly initDb() timing out
 *  because another tab/connection deadlocked the IndexedDB upgrade lock — see
 *  db.ts). Give the user a way out instead of a permanently frozen blank app. */
function showBootErrorScreen(root: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  root.innerHTML = `
    <div class="p-8 max-w-md mx-auto text-center space-y-4">
      <p class="text-danger font-mono text-sm">Failed to initialize: ${message}</p>
      <p class="text-xs text-muted">This can happen if another tab got stuck holding your local data open, or if it became corrupted.</p>
      <div class="flex gap-2 justify-center">
        <button id="boot-retry" class="btn-primary text-sm">Retry</button>
        <button id="boot-reset" class="btn-danger text-sm">Reset local data</button>
      </div>
    </div>`;
  document.getElementById('boot-retry')?.addEventListener('click', () => location.reload());
  document.getElementById('boot-reset')?.addEventListener('click', () => {
    void (async () => {
      if (!confirm('This erases all local data on this device that has not been synced to Drive. Continue?')) return;
      await resetDatabase();
      location.reload();
    })();
  });
}

function finishBoot(root: HTMLElement): void {
  applyTheme();
  applyZoom();
  initPWA();
  initDriveVisibilitySync();

  void initDriveClient().then(async () => {
    if (!isDriveConnected()) return;
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

  mountApp(root);
  registerCommandPalette(getContext);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
  });
}
