import './styles.css';
import 'abcjs/abcjs-audio.css';
import { initDb, loadState, saveState } from './db';
import { emptyState } from './utils';
import type { AppState, AppContext, Route } from './types';
import { renderSidebar } from './components/sidebar';
import { renderFolderView } from './views/folderView';
import { renderDeckView } from './views/deckView';
import { renderCardView } from './views/cardView';
import { renderStudyView } from './views/studyView';
import { renderLibraryView } from './views/libraryView';
import { ensureCurrentUser, getCurrentUser } from './services/userService';
import { registerCommandPalette } from './components/commandPalette';
import { setLanguage } from './services/i18nService';

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

class App {
  private state: AppState;
  private route: Route = { view: 'folder', folderId: null };
  private history: Route[] = [];
  private future: Route[] = [];
  private sidebarEl!: HTMLElement;
  private contentEl!: HTMLElement;

  constructor(state: AppState) {
    this.state = state;
  }

  get context(): AppContext {
    return {
      state: this.state,
      route: this.route,
      navigate: (route) => this.navigate(route),
      back: () => this.back(),
      forward: () => this.forward(),
      canGoBack: this.history.length > 0,
      canGoForward: this.future.length > 0,
      mutate: (fn) => this.mutate(fn),
      save: (fn) => this.save(fn),
    };
  }

  navigate(route: Route): void {
    this.history.push(this.route);
    if (this.history.length > 50) this.history.shift();
    this.future = [];
    this.route = route;
    this.renderSidebar();
    this.renderContent();
  }

  back(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.route);
    this.route = prev;
    this.renderSidebar();
    this.renderContent();
  }

  forward(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.route);
    this.route = next;
    this.renderSidebar();
    this.renderContent();
  }

  async mutate(fn: (state: AppState) => void): Promise<void> {
    fn(this.state);
    await saveState(this.state);
    this.renderSidebar();
    this.renderContent();
  }

  async save(fn: (state: AppState) => void): Promise<void> {
    fn(this.state);
    await saveState(this.state);
  }

  mount(root: HTMLElement): void {
    root.innerHTML = '';

    const layout = document.createElement('div');
    layout.className = 'flex flex-1 overflow-hidden';

    this.sidebarEl = document.createElement('div');
    this.sidebarEl.className = 'shrink-0 flex overflow-hidden';

    this.contentEl = document.createElement('main');
    this.contentEl.className = 'flex-1 overflow-hidden bg-bg';

    layout.append(this.sidebarEl, this.contentEl);
    root.appendChild(layout);

    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); this.back(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); this.forward(); }
    });

    this.renderSidebar();
    this.renderContent();
  }

  private renderSidebar(): void {
    this.sidebarEl.innerHTML = '';
    this.sidebarEl.appendChild(renderSidebar(this.context));
  }

  private renderContent(): void {
    this.contentEl.innerHTML = '';
    this.contentEl.appendChild(this.buildView());
  }

  private buildView(): HTMLElement {
    const { route } = this;
    switch (route.view) {
      case 'folder':  return renderFolderView(this.context, route.folderId);
      case 'library': return renderLibraryView(this.context);
      case 'deck':    return renderDeckView(this.context, route.deckId);
      case 'card':    return renderCardView(this.context, route.cardId);
      case 'study':   return renderStudyView(this.context, route.deckId, route.strategy, route.currentCardId);
    }
  }
}

// ── Bootstrap ──
(async () => {
  try {
    await initDb();
    const savedState = await loadState();
    const state: AppState = savedState ?? emptyState();
    ensureCurrentUser(state);
    setLanguage(getCurrentUser(state).language ?? 'en');
    await saveState(state); // persist ensured user
    const app = new App(state);
    app.mount(document.getElementById('app')!);
    registerCommandPalette(() => app.context);
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
