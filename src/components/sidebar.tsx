import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { AppContext, AppState, Route, Folder, Deck } from '../types';
import { generateId, addTouchDragSupport, availabilityColor, pct } from '../utils';
import { promptModal } from './modal';
import { findParentFolder } from '../services/deckService';
import { deckAvailability, deckEase } from '../services/knowledgeService';
import { t } from '../services/i18nService';

// Folders are expanded by default; this tracks the ones manually collapsed —
// kept module-level (not component state) so it survives navigation/remounts,
// same lifetime as before this file's Preact conversion (2026-08-26).
const collapsedSignal = signal<Set<string>>(new Set());
let lastAutoExpandedRoute: string | null = null;

/** All mutations go through here so every writer produces a fresh Set —
 *  signals only notify subscribers on a new `.value` assignment, mutating
 *  the existing Set in place wouldn't re-render anything reading it. */
function updateCollapsed(mutate: (next: Set<string>) => void): void {
  const next = new Set(collapsedSignal.value);
  mutate(next);
  collapsedSignal.value = next;
}

// ── Drag & Drop state ─────────────────────────────────────────────────────────
// Deliberately plain module variables, not Preact state: dragover/dragleave
// can fire many times a second during a single gesture, and all they ever
// need to do is toggle a CSS class on the exact row under the pointer —
// direct DOM manipulation via the row's own ref does that without forcing a
// re-render on every pointer move.

let dragState: { type: 'folder' | 'deck'; id: string } | null = null;
let dropIndicatorEl: HTMLElement | null = null;

function clearDropIndicators(): void {
  if (dropIndicatorEl) {
    dropIndicatorEl.classList.remove('drop-before', 'drop-after', 'drop-into');
    dropIndicatorEl = null;
  }
}

function setDropIndicator(el: HTMLElement, zone: 'before' | 'after' | 'into'): void {
  if (dropIndicatorEl === el && el.classList.contains(`drop-${zone}`)) return;
  clearDropIndicators();
  el.classList.add(`drop-${zone}`);
  dropIndicatorEl = el;
}

function getDropZone(e: DragEvent, el: HTMLElement, isFolder: boolean): 'before' | 'after' | 'into' {
  const rect = el.getBoundingClientRect();
  const relY = (e.clientY - rect.top) / rect.height;
  if (isFolder) {
    if (relY < 0.33) return 'before';
    if (relY > 0.67) return 'after';
    return 'into';
  }
  return relY < 0.5 ? 'before' : 'after';
}

// ── Drag & Drop mutation helpers (pure — no DOM) ────────────────────────────────

function removeFromParent(s: AppState, _type: 'folder' | 'deck', id: string): void {
  s.rootFolderIds = s.rootFolderIds.filter((x: string) => x !== id);
  s.rootDeckIds   = s.rootDeckIds.filter((x: string) => x !== id);
  for (const f of Object.values(s.folders) as Folder[]) {
    f.folderIds = f.folderIds.filter(x => x !== id);
    f.deckIds   = f.deckIds.filter(x => x !== id);
  }
}

function isFolderDescendant(s: AppState, ancestorId: string, targetId: string): boolean {
  const folder = s.folders[ancestorId];
  if (!folder) return false;
  if (folder.folderIds.includes(targetId)) return true;
  return folder.folderIds.some(subId => isFolderDescendant(s, subId, targetId));
}

function insertItem(
  s: AppState,
  drag: { type: 'folder' | 'deck'; id: string },
  target: { type: 'folder' | 'deck'; id: string },
  zone: 'before' | 'after' | 'into'
): void {
  if (zone === 'into') {
    if (target.type !== 'folder') return;
    const tf = s.folders[target.id];
    if (!tf) return;
    if (drag.type === 'folder') tf.folderIds.push(drag.id);
    else tf.deckIds.push(drag.id);
    return;
  }

  const before = zone === 'before';

  const tryInsertInto = (arr: string[], targetId: string, itemId: string, before: boolean): boolean => {
    const idx = arr.indexOf(targetId);
    if (idx === -1) return false;
    arr.splice(before ? idx : idx + 1, 0, itemId);
    return true;
  };

  if (drag.type === target.type) {
    const rootArr = drag.type === 'folder' ? s.rootFolderIds : s.rootDeckIds;
    if (!tryInsertInto(rootArr, target.id, drag.id, before)) {
      for (const f of Object.values(s.folders) as Folder[]) {
        const arr = drag.type === 'folder' ? f.folderIds : f.deckIds;
        if (tryInsertInto(arr, target.id, drag.id, before)) break;
      }
    }
  } else {
    const parentId = findParentFolder(target.id, target.type, s);
    if (drag.type === 'folder') {
      if (parentId) s.folders[parentId]!.folderIds.push(drag.id);
      else s.rootFolderIds.push(drag.id);
    } else {
      if (parentId) s.folders[parentId]!.deckIds.push(drag.id);
      else s.rootDeckIds.push(drag.id);
    }
  }
}

function moveSidebarItem(
  s: AppState,
  drag: { type: 'folder' | 'deck'; id: string },
  target: { type: 'folder' | 'deck'; id: string },
  zone: 'before' | 'after' | 'into'
): void {
  if (drag.id === target.id) return;
  if (drag.type === 'folder' && target.type === 'folder') {
    if (isFolderDescendant(s, drag.id, target.id)) return;
  }
  removeFromParent(s, drag.type, drag.id);
  insertItem(s, drag, target, zone);
}

/** Attaches the native HTML5 drag-and-drop listeners (+ touch-drag polyfill)
 *  directly to a row's DOM node via its ref, once per mount — rows are
 *  key()ed by their own id, so Preact always fully unmounts/remounts rather
 *  than reusing the node across a different item, same lifetime the vanilla
 *  version got implicitly from rebuilding the whole tree on every change. */
function useDragHandlers(ref: RefObject<HTMLElement>, type: 'folder' | 'deck', id: string, isFolder: boolean, ctx: AppContext): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.draggable = true;

    const onDragStart = (e: DragEvent) => {
      dragState = { type, id };
      e.dataTransfer?.setData('text/plain', id);
      setTimeout(() => el.classList.add('opacity-40'), 0);
    };
    const onDragEnd = () => {
      dragState = null;
      el.classList.remove('opacity-40');
      clearDropIndicators();
    };
    const onDragOver = (e: DragEvent) => {
      if (!dragState || dragState.id === id) return;
      e.preventDefault();
      e.stopPropagation();
      setDropIndicator(el, getDropZone(e, el, isFolder));
    };
    const onDragLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node)) clearDropIndicators();
    };
    const onDrop = (e: DragEvent) => {
      if (!dragState) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = getDropZone(e, el, isFolder);
      clearDropIndicators();
      const ds = dragState;
      dragState = null;
      if (ds.id === id) return;
      ctx.mutate(s => moveSidebarItem(s, ds, { type, id }, zone));
    };

    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragend', onDragEnd);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    addTouchDragSupport(el);
    // eslint-disable-next-line
  }, [id]);
}

// ── Expand / active helpers ───────────────────────────────────────────────────

function expandAncestors(collapsed: Set<string>, id: string, type: 'deck' | 'folder', user: AppState): void {
  let current: string | null = findParentFolder(id, type, user);
  while (current) {
    collapsed.delete(current);
    current = findParentFolder(current, 'folder', user);
  }
}

function collectAllFolderIds(user: AppState): string[] {
  const ids: string[] = [];
  const visit = (folderIds: string[]) => {
    for (const id of folderIds) {
      const f = user.folders[id];
      if (!f) continue;
      ids.push(id);
      visit(f.folderIds);
    }
  };
  visit(user.rootFolderIds);
  return ids;
}

function isActive(route: Route, type: 'folder' | 'deck', id: string | null = null): boolean {
  if (type === 'folder') return route.view === 'folder' && route.folderId === id;
  return (route.view === 'deck' || route.view === 'study') && 'deckId' in route && route.deckId === id;
}

// ── Icon button ────────────────────────────────────────────────────────────────

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: preact.ComponentChildren }) {
  return (
    <button
      class="w-6 h-6 flex items-center justify-center rounded text-dim hover:text-primary hover:bg-elevated transition-colors cursor-pointer border-none bg-transparent"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ── Tree items ───────────────────────────────────────────────────────────────

function DeckItem({ ctx, deck, depth }: { ctx: AppContext; deck: Deck; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragHandlers(ref, 'deck', deck.id, false, ctx);
  const active = isActive(ctx.route, 'deck', deck.id);

  return (
    <div
      ref={ref}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      class={`flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer group transition-colors text-sm ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`}
      onClick={() => ctx.navigate({ view: 'deck', deckId: deck.id })}
    >
      <span class={`shrink-0 flex items-center ${active ? 'text-accent' : 'text-dim opacity-70'}`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
        </svg>
      </span>
      <span class="truncate flex-1">{deck.name}</span>
      {deck.entries.length > 0 && (() => {
        const user = ctx.user;
        const profileId = user.currentProfileId;
        const w = user.weightByImportance ?? true;
        const avail = deckAvailability(user, profileId, deck, user.cards, user.cardWorks, w);
        const ease  = deckEase(profileId, deck, user.cards, user.cardWorks, w);
        return (
          <span class="flex gap-0.5 items-center shrink-0">
            <span class={`w-2 h-2 rounded-full ${availabilityColor(avail)}`} title={t('deck.dot.recall', { pct: pct(avail) })} />
            <span
              class={`w-2 h-2 rounded-full ${ease === 0 ? 'bg-border' : ease >= 0.6 ? 'bg-success' : ease >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
              title={ease === 0 ? t('deck.neverReviewed') : t('deck.dot.ease', { pct: pct(ease) })}
            />
          </span>
        );
      })()}
    </div>
  );
}

function FolderItem({ ctx, folder, depth }: { ctx: AppContext; folder: Folder; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragHandlers(ref, 'folder', folder.id, true, ctx);
  const active = isActive(ctx.route, 'folder', folder.id);
  const isOpen = !collapsedSignal.value.has(folder.id);

  return (
    <div>
      <div
        ref={ref}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        class={`flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer transition-colors text-sm ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`}
        onClick={() => ctx.navigate({ view: 'folder', folderId: folder.id })}
      >
        <span
          class={`shrink-0 flex items-center cursor-pointer ${active ? 'text-accent' : 'text-dim'}`}
          onClick={(e) => {
            e.stopPropagation();
            updateCollapsed(next => { if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); });
          }}
        >
          {isOpen ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </span>
        <span class="truncate flex-1 font-medium">{folder.name}</span>
      </div>

      {isOpen && (
        <div>
          {folder.folderIds.map(subId => {
            const sub = ctx.user.folders[subId];
            return sub ? <FolderItem key={sub.id} ctx={ctx} folder={sub} depth={depth + 1} /> : null;
          })}
          {folder.deckIds.map(deckId => {
            const deck = ctx.user.decks[deckId];
            return deck ? <DeckItem key={deck.id} ctx={ctx} deck={deck} depth={depth + 1} /> : null;
          })}
        </div>
      )}
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export function showCreateDeckModal(ctx: AppContext, parentFolderId: string | null): void {
  promptModal(t('modal.newDeck.title'), t('modal.newDeck.label'), '', name => {
    const id = generateId();
    ctx.mutate(s => {
      s.decks[id] = { id, name, entries: [] };
      if (parentFolderId) s.folders[parentFolderId]!.deckIds.push(id);
      else s.rootDeckIds.push(id);
    });
  });
}

export function Sidebar({ ctx }: { ctx: AppContext }) {
  const { route, user } = ctx;
  const routeKey = JSON.stringify(route);

  // Auto-expand the path to whatever the route currently points at — once
  // per distinct route, same "only when it actually changed" guard the
  // vanilla version had (routeKey comparison).
  useEffect(() => {
    if (routeKey === lastAutoExpandedRoute) return;
    lastAutoExpandedRoute = routeKey;
    updateCollapsed(next => {
      if ((route.view === 'deck' || route.view === 'study') && route.deckId) {
        expandAncestors(next, route.deckId, 'deck', user);
      }
      if (route.view === 'folder' && route.folderId) {
        next.delete(route.folderId);
        expandAncestors(next, route.folderId, 'folder', user);
      }
    });
    // eslint-disable-next-line
  }, [routeKey]);

  return (
    <aside class="flex flex-col h-full bg-surface border-r border-border w-full">
      <div class="shrink-0 px-2 py-1 flex items-center justify-end gap-0.5 border-b border-border">
        <IconBtn title={t('sidebar.expandAll')} onClick={() => { collapsedSignal.value = new Set(); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="7 13 12 18 17 13" /><polyline points="7 6 12 11 17 6" />
          </svg>
        </IconBtn>
        <IconBtn title={t('sidebar.collapseAll')} onClick={() => { collapsedSignal.value = new Set(collectAllFolderIds(user)); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="17 11 12 6 7 11" /><polyline points="17 18 12 13 7 18" />
          </svg>
        </IconBtn>
      </div>

      <div class="flex-1 overflow-y-auto py-1 px-2 space-y-0.5">
        {user.rootFolderIds.map(id => {
          const folder = user.folders[id];
          return folder ? <FolderItem key={folder.id} ctx={ctx} folder={folder} depth={0} /> : null;
        })}
        {user.rootDeckIds.map(id => {
          const deck = user.decks[id];
          return deck ? <DeckItem key={deck.id} ctx={ctx} deck={deck} depth={0} /> : null;
        })}
      </div>

      <div class="border-t border-border shrink-0 px-3 py-2 flex items-center justify-between">
        <span class="text-[10px] text-dim select-none">{t('sidebar.new')}</span>
        <div class="flex items-center gap-1">
          <IconBtn
            title={t('sidebar.newFolder')}
            onClick={() => promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
              ctx.mutate(s => {
                const id = generateId();
                s.folders[id] = { id, name, folderIds: [], deckIds: [] };
                s.rootFolderIds.push(id);
              });
            })}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </IconBtn>
          <IconBtn title={t('sidebar.newDeck')} onClick={() => showCreateDeckModal(ctx, null)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
            </svg>
          </IconBtn>
        </div>
      </div>
    </aside>
  );
}
