import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, loadState, saveState } from './db';
import { emptyState } from './utils';
import { appState, goBack, goForward } from './store';
import { ensureCurrentUser, ensureCurrentProfile, getCurrentUser } from './services/userService';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage } from './services/i18nService';
import { initPWA } from './services/pwaService';
import { initDriveClient, isDriveConnected, loadFromCloud, getLocalTimestamp, initDriveVisibilitySync } from './services/driveService';
import { migrateState } from './services/migration';
import { applyZoom } from './services/zoomService';
import { mountApp } from './appRoot';
import { getContext } from './store';
import type { AppState } from './types';

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

(async () => {
  try {
    await initDb();
    const savedState = await loadState();
    const state = savedState ?? emptyState();
    migrateState(state);
    ensureCurrentUser(state);
    ensureCurrentProfile(state);
    setLanguage(getCurrentUser(state).language);
    await saveState(state);
    appState.value = state;

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

    mountApp(document.getElementById('app')!);
    registerCommandPalette(getContext);

    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    });

  } catch (err) {
    console.error('Failed to start Cadence:', err);
    const root = document.getElementById('app');
    if (root) {
      root.innerHTML = `<div class="p-8 text-danger font-mono text-sm">
        Failed to initialize: ${err instanceof Error ? err.message : String(err)}
      </div>`;
    }
  }
})();
