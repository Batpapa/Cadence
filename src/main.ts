import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, loadUser, saveUser, getAllUserIds, loadLegacyState, deleteLegacyState, loadAllUsers, getLastUserId, setLastUserId, deleteUser } from './db';
import { emptyState } from './utils';
import { appState, goBack, goForward } from './store';
import { ensureCurrentUser, ensureCurrentProfile, detectLanguage } from './services/userService';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage } from './services/i18nService';
import { initPWA } from './services/pwaService';
import { initDriveClient, isDriveConnected, loadFromCloud, getLocalTimestamp, initDriveVisibilitySync, getDriveUserId, disconnectDrive } from './services/driveService';
import { migrateState, migrateLegacyToUser, applyExternalData } from './services/migration';
import { applyZoom } from './services/zoomService';
import { applyTheme } from './services/themeService';
import { mountApp, mountUserSelector } from './appRoot';
import { getContext } from './store';
import type { User } from './types';

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

export async function createAndOpenUser(name: string, root: HTMLElement): Promise<void> {
  const user = emptyState();
  user.name = name;
  ensureCurrentUser(user);
  ensureCurrentProfile(user);
  await saveUser(user);
  setLastUserId(user.id);
  setLanguage(user.language);
  appState.value = user;
  finishBoot(root);
}

async function showUserSelector(root: HTMLElement): Promise<void> {
  setLanguage(detectLanguage());
  const users = await loadAllUsers();
  mountUserSelector(root, users,
    (id)   => openUser(id, root),
    (name) => createAndOpenUser(name, root),
    async (id) => { await deleteUser(id); await showUserSelector(root); },
  );
}

export async function openUser(id: string, root: HTMLElement): Promise<void> {
  const driveUserId = getDriveUserId();
  if (driveUserId && driveUserId !== id) disconnectDrive();

  const saved = await loadUser(id);
  if (!saved) return;
  migrateState(saved);
  ensureCurrentUser(saved);
  ensureCurrentProfile(saved);
  setLanguage(saved.language);
  await saveUser(saved);
  setLastUserId(id);
  appState.value = saved;
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
    root.innerHTML = `<div class="p-8 text-danger font-mono text-sm">
      Failed to initialize: ${err instanceof Error ? err.message : String(err)}
    </div>`;
  }
})();

function finishBoot(root: HTMLElement): void {
  applyTheme();
  applyZoom();
  window.addEventListener('resize', applyZoom);
  initPWA();
  initDriveVisibilitySync();

  void initDriveClient().then(async () => {
    if (!isDriveConnected()) return;
    try {
      const driveData = await loadFromCloud();
      if (driveData && (driveData._lastModified ?? 0) > getLocalTimestamp()) {
        const { _lastModified: _, _deviceId: __, ...raw } = driveData;
        const updated = applyExternalData(raw as Record<string, unknown>, appState.value.id);
        appState.value = updated;
        await saveUser(updated);
      }
    } catch { /* silently fall back to local data */ }
  });

  mountApp(root);
  registerCommandPalette(getContext);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
  });
}
