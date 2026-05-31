import { render } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { getContext, routeSignal } from './store';
import { renderSidebar } from './components/sidebar';
import { FolderView } from './views/folder';
import { DeckView } from './views/deck';
import { CardView } from './views/card';
import { LibraryView } from './views/library';
import { StudyView } from './views/study';
import { t } from './services/i18nService';
import type { WorkspaceDescriptor } from './services/metaService';

// Routes to the appropriate Preact component.
// key= on stateful views forces a remount when the ID changes (resets local state).
function ContentSwitch() {
  const route = routeSignal.value;
  if (route.view === 'study')   return <StudyView deckId={route.deckId} strategy={route.strategy} currentCardId={route.currentCardId} />;
  if (route.view === 'deck')    return <DeckView   key={route.deckId}   deckId={route.deckId} />;
  if (route.view === 'library') return <LibraryView />;
  if (route.view === 'card')    return <CardView   key={route.cardId}   cardId={route.cardId} />;
  if (route.view === 'folder')  return <FolderView key={route.folderId ?? 'root'} folderId={route.folderId} />;
  const _: never = route; return _;
}

function AppRoot() {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const ctx = getContext();

  useLayoutEffect(() => {
    sidebarRef.current!.replaceChildren(renderSidebar(ctx));
  });

  return (
    <div class="flex flex-1 overflow-hidden">
      <div ref={sidebarRef} class="shrink-0 flex overflow-hidden" />
      <main class="flex-1 overflow-hidden bg-bg">
        <ContentSwitch />
      </main>
    </div>
  );
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = '';
  render(<AppRoot />, root);
}

// ── Workspace selector ────────────────────────────────────────────────────────

function WorkspaceSelector({ workspaces, lastId, onSelect, onCreate }: {
  workspaces: WorkspaceDescriptor[];
  lastId?: string;
  onSelect: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}) {
  const [loading, setLoading]     = useState<string | null>(null);
  const [creating, setCreating]   = useState(false);
  const [newName,  setNewName]    = useState('');

  const select = async (id: string) => {
    setLoading(id);
    await onSelect(id);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setLoading('new');
    await onCreate(name);
  };

  return (
    <div class="fixed inset-0 bg-bg flex items-center justify-center">
      <div class="w-full max-w-sm mx-4 space-y-3">
        <h1 class="text-sm font-semibold text-muted uppercase tracking-widest text-center mb-4">
          {t('workspace.selector.title')}
        </h1>

        {workspaces.map(w => (
          <button
            key={w.id}
            disabled={!!loading}
            onClick={() => void select(w.id)}
            class={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors cursor-pointer text-left ${
              w.id === lastId
                ? 'border-accent/30 bg-accent/5 hover:bg-accent/10'
                : 'border-border bg-elevated hover:border-muted hover:bg-surface'
            } ${loading === w.id ? 'opacity-60' : ''}`}
          >
            <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background:rgb(var(--color-accent-ch)/0.18)">
              <span class="text-xs font-mono font-bold text-accent">
                {w.name.slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-primary truncate">{w.name}</div>
              {w.ownerEmail && <div class="text-xs text-dim truncate">{w.ownerEmail}</div>}
            </div>
            {w.id === lastId && <span class="text-xs text-accent shrink-0">●</span>}
          </button>
        ))}

        {creating ? (
          <div class="flex gap-2">
            <input
              autoFocus
              type="text"
              value={newName}
              placeholder={t('workspace.selector.namePlaceholder')}
              class="input flex-1 text-sm"
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  void create();
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
            />
            <button class="btn-primary text-sm px-3" disabled={!!loading || !newName.trim()} onClick={() => void create()}>
              {t('common.confirm')}
            </button>
          </div>
        ) : (
          <button
            class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-sm"
            onClick={() => setCreating(true)}
          >
            + {t('workspace.selector.new')}
          </button>
        )}
      </div>
    </div>
  );
}

export function mountWorkspaceSelector(
  root: HTMLElement,
  workspaces: WorkspaceDescriptor[],
  lastId: string | undefined,
  onSelect: (id: string) => Promise<void>,
  onCreate: (name: string) => Promise<void>,
): void {
  root.innerHTML = '';
  render(
    <WorkspaceSelector workspaces={workspaces} lastId={lastId} onSelect={onSelect} onCreate={onCreate} />,
    root,
  );
}
