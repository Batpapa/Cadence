import { render } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { getContext, routeSignal } from './store';
import { renderSidebar } from './components/sidebar';
import { confirmModal } from './components/modal';
import { t } from './services/i18nService';
import type { User } from './types';
import { FolderView } from './views/folder';
import { DeckView } from './views/deck';
import { CardView } from './views/card';
import { LibraryView } from './views/library';
import { StudyView } from './views/study';

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
  render(null, root);
  render(<AppRoot />, root);
}

// ── User selector ─────────────────────────────────────────────────────────────

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?';

function UserSelector({ users, onSelect, onCreate, onDelete }: {
  users: User[];
  onSelect: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [loading,  setLoading]  = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName,  setNewName]  = useState('');

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

  const confirmDelete = (u: User) => {
    confirmModal(
      t('userSelector.delete.title'),
      t('userSelector.delete.message', { name: u.name }),
      t('userSelector.delete.confirm'),
      () => void onDelete(u.id),
    );
  };

  return (
    <div class="fixed inset-0 bg-bg flex items-center justify-center">
      <div class="w-full max-w-xs mx-4 space-y-2">
        <h1 class="text-xs font-semibold text-muted uppercase tracking-widest text-center mb-5">
          {t('userSelector.title')}
        </h1>

        {users.map(u => (
          <div
            key={u.id}
            class={`group w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-elevated hover:border-muted hover:bg-surface transition-colors ${loading === u.id ? 'opacity-60' : ''}`}
          >
            <button
              disabled={!!loading}
              onClick={() => void select(u.id)}
              class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer text-left"
            >
              <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background:rgb(var(--color-accent-ch)/0.18)">
                <span class="text-xs font-mono font-bold text-accent">{initialsOf(u.name)}</span>
              </div>
              <span class="text-sm font-medium text-primary truncate flex-1">{u.name}</span>
              {u.ownerGoogleId && <span class="text-xs text-dim shrink-0">●</span>}
            </button>
            <button
              disabled={!!loading}
              onClick={() => confirmDelete(u)}
              class="opacity-0 group-hover:opacity-100 shrink-0 text-dim hover:text-danger transition-all cursor-pointer"
              title={t('userSelector.delete.title')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        ))}

        {creating ? (
          <div class="flex gap-2 pt-1">
            <input
              autoFocus
              type="text"
              value={newName}
              placeholder={t('userSelector.namePlaceholder')}
              class="input flex-1 text-sm"
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  void create();
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
            />
            <button
              class="btn-primary text-sm px-3"
              disabled={!!loading || !newName.trim()}
              onClick={() => void create()}
            >
              {t('common.confirm')}
            </button>
          </div>
        ) : (
          <button
            class="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-sm"
            onClick={() => setCreating(true)}
          >
            + {t('userSelector.new')}
          </button>
        )}
      </div>
    </div>
  );
}

export function mountUserSelector(
  root: HTMLElement,
  users: User[],
  onSelect: (id: string) => Promise<void>,
  onCreate: (name: string) => Promise<void>,
  onDelete: (id: string) => Promise<void>,
): void {
  render(<UserSelector users={users} onSelect={onSelect} onCreate={onCreate} onDelete={onDelete} />, root);
}
