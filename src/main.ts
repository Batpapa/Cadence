import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, loadState, saveState, loadLegacyState } from './db';
import { emptyState } from './utils';
import { appState, goBack, goForward } from './store';
import { ensureCurrentUser, ensureCurrentProfile, getCurrentUser } from './services/userService';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage } from './services/i18nService';
import { initPWA } from './services/pwaService';
import { initDriveClient, isDriveConnected, loadFromCloud, getLocalTimestamp, initDriveVisibilitySync } from './services/driveService';
import { migrateState } from './services/migration';
import { applyZoom } from './services/zoomService';
import { applyTheme } from './services/themeService';
import { mountApp, mountWorkspaceSelector } from './appRoot';
import { getContext } from './store';
import { getWorkspaces, getLastWorkspaceId, setLastWorkspace, upsertWorkspace } from './services/metaService';
import type { AppState } from './types';

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

async function openWorkspace(workspaceId: string): Promise<void> {
  await initDb(workspaceId);
  const saved = await loadState();
  const state = saved ?? emptyState();
  migrateState(state);
  ensureCurrentUser(state);
  ensureCurrentProfile(state);
  setLanguage(getCurrentUser(state).language);
  await saveState(state);
  appState.value = state;
  setLastWorkspace(workspaceId);

  // Keep meta descriptor in sync (name, ownerGoogleId)
  const user = getCurrentUser(state);
  upsertWorkspace({ id: workspaceId, name: 'Default', ownerGoogleId: user.ownerGoogleId });
}

async function createWorkspace(name: string): Promise<string> {
  const state = emptyState();
  ensureCurrentUser(state);
  ensureCurrentProfile(state);
  const workspaceId = state.currentUserId;
  upsertWorkspace({ id: workspaceId, name });
  await initDb(workspaceId);
  await saveState(state);
  return workspaceId;
}

(async () => {
  const root = document.getElementById('app')!;
  try {
    const workspaces = getWorkspaces();

    // ── Migration: first run of new version ────────────────────────────────────
    if (workspaces.length === 0) {
      const legacy = await loadLegacyState();
      if (legacy) {
        migrateState(legacy);
        ensureCurrentUser(legacy);
        ensureCurrentProfile(legacy);
        const workspaceId = legacy.currentUserId;
        upsertWorkspace({ id: workspaceId, name: 'Default', ownerGoogleId: legacy.users[workspaceId]?.ownerGoogleId });
        await initDb(workspaceId);
        await saveState(legacy);
        appState.value = legacy;
        setLanguage(getCurrentUser(legacy).language);
        setLastWorkspace(workspaceId);
        indexedDB.deleteDatabase('cadence');
      } else {
        // Fresh install
        const workspaceId = await createWorkspace('Default');
        appState.value = (await loadState())!;
        setLanguage(getCurrentUser(appState.value).language);
        setLastWorkspace(workspaceId);
      }
      finishBoot(root);
      return;
    }

    // ── Multiple workspaces: show selector ─────────────────────────────────────
    if (workspaces.length > 1) {
      const lastId = getLastWorkspaceId();
      mountWorkspaceSelector(root, workspaces, lastId, async (id) => {
        await openWorkspace(id);
        finishBoot(root);
      }, async (name) => {
        const id = await createWorkspace(name);
        await openWorkspace(id);
        finishBoot(root);
      });
      return;
    }

    // ── Single workspace: auto-open ────────────────────────────────────────────
    await openWorkspace(workspaces[0]!.id);
    finishBoot(root);

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
        const { _lastModified: _, ...clean } = driveData as AppState & { _lastModified?: number };
        migrateState(clean as AppState);
        appState.value = { ...appState.value, ...clean } as AppState;
        await saveState(appState.value);
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
