import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { AppContext, AppState, Route, Folder, Deck } from '../types';
import { generateId, addTouchDragSupport, availabilityColor, pct } from '../utils';
import { promptModal } from './modal';
import { DeckIcon, FolderIcon, FolderOpenIcon, ExpandAllIcon, CollapseAllIcon, PlusIcon } from './icons';
import { IconButton } from './ui';
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

/** Opens every folder above a deck, so its row can be shown — what a guided
 *  walkthrough needs when it points at a deck the user may have folded away. */
export function revealDeckInSidebar(deckId: string, user: AppState): void {
  updateCollapsed(next => expandAncestors(next, deckId, 'deck', user));
}

/** The decks in the order the panel lists them: each folder's sub-folders,
 *  then its decks, and the decks at the root last. */
export function decksInSidebarOrder(user: AppState): string[] {
  const out: string[] = [];
  const visit = (folderIds: string[]) => {
    for (const id of folderIds) {
      const f = user.folders[id];
      if (!f) continue;
      visit(f.folderIds);
      out.push(...f.deckIds);
    }
  };
  visit(user.rootFolderIds);
  return [...out, ...user.rootDeckIds];
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

/** A row of the tree: as tall as a target (32 px), the same for a folder and
 *  a deck, and the selection tint of the rest of the app. */
const ROW_CLASS = 'flex items-center gap-1.5 min-h-8 pr-2 rounded-md cursor-pointer transition-colors text-sm';
const rowState = (active: boolean) => active ? 'bg-accent/10 text-accent' : 'text-muted hover:text-primary hover:bg-elevated';

// ── Tree items ───────────────────────────────────────────────────────────────

function DeckItem({ ctx, deck, depth }: { ctx: AppContext; deck: Deck; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragHandlers(ref, 'deck', deck.id, false, ctx);
  const active = isActive(ctx.route, 'deck', deck.id);

  return (
    <div
      ref={ref}
      data-tour={`sidebar-deck-${deck.id}`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      class={`${ROW_CLASS} group ${rowState(active)}`}
      onClick={() => ctx.navigate({ view: 'deck', deckId: deck.id })}
    >
      {/* As wide as a folder's toggle, so the names of a folder and a deck at
          the same depth start at the same place. */}
      <span class={`shrink-0 flex items-center justify-center w-6 ${active ? 'text-accent' : 'text-dim'}`}>
        <DeckIcon size={14} />
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
            <span class={`w-2 h-2 rounded-full ${availabilityColor(avail, ease === 0)}`} title={ease === 0 ? t('deck.neverReviewed') : t('deck.dot.recall', { pct: pct(avail) })} />
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
        class={`${ROW_CLASS} ${rowState(active)}`}
        onClick={() => ctx.navigate({ view: 'folder', folderId: folder.id })}
      >
        {/* The folder's own icon folds it: a 24 × 32 target on the row's
            height, apart from the name, which opens it. */}
        <span
          role="button"
          aria-expanded={isOpen}
          aria-label={t(isOpen ? 'sidebar.folder.collapse' : 'sidebar.folder.expand')}
          title={t(isOpen ? 'sidebar.folder.collapse' : 'sidebar.folder.expand')}
          class={`shrink-0 flex items-center justify-center w-6 min-h-8 rounded-md cursor-pointer hover:bg-border/60 ${active ? 'text-accent' : 'text-dim'}`}
          onClick={(e) => {
            e.stopPropagation();
            updateCollapsed(next => { if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); });
          }}
        >
          {isOpen ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}
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
      {/* The two bars, top and bottom, are one height (a 32 px target in a
          4 px margin) and one material, so the tree sits between two equal
          edges. */}
      <div class="shrink-0 px-2 py-1 flex items-center justify-end gap-0.5 border-b border-border">
        <IconButton label={t('sidebar.expandAll')} onClick={() => { collapsedSignal.value = new Set(); }}>
          <ExpandAllIcon size={14} />
        </IconButton>
        <IconButton label={t('sidebar.collapseAll')} onClick={() => { collapsedSignal.value = new Set(collectAllFolderIds(user)); }}>
          <CollapseAllIcon size={14} />
        </IconButton>
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

      {/* Creation, at the foot of the tree: two named buttons, + and the
          tree's own folder and deck icons, the words the folder page uses.
          It was a 10 px "New…" beside two bare 24 px icons — the only text of
          the sidebar under its 14 px, and the only targets under 32.
          A narrow sidebar drops the WORDS, never the buttons' size (the user,
          2026-11-11): a container query on this bar (styles.css,
          .sidebar-new), so the names go before they would be cut, and the
          icons say the rest — the full name is the tooltip. */}
      <div class="sidebar-new border-t border-border shrink-0 px-2 py-1 flex items-center gap-1">
        <button
          type="button"
          class="btn-ghost flex-1 min-w-0 min-h-8 px-2 inline-flex items-center justify-center gap-1.5 text-xs"
          title={t('modal.newFolder.title')}
          aria-label={t('modal.newFolder.title')}
          onClick={() => promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
            ctx.mutate(s => {
              const id = generateId();
              s.folders[id] = { id, name, folderIds: [], deckIds: [] };
              s.rootFolderIds.push(id);
            });
          })}
        >
          <span class="shrink-0 flex"><PlusIcon size={12} /></span><span class="shrink-0 flex"><FolderIcon size={14} /></span><span class="sidebar-new-label whitespace-nowrap">{t('sidebar.newFolder')}</span>
        </button>
        <button
          type="button"
          class="btn-ghost flex-1 min-w-0 min-h-8 px-2 inline-flex items-center justify-center gap-1.5 text-xs"
          title={t('modal.newDeck.title')}
          aria-label={t('modal.newDeck.title')}
          onClick={() => showCreateDeckModal(ctx, null)}
        >
          <span class="shrink-0 flex"><PlusIcon size={12} /></span><span class="shrink-0 flex"><DeckIcon size={14} /></span><span class="sidebar-new-label whitespace-nowrap">{t('sidebar.newDeck')}</span>
        </button>
      </div>
    </aside>
  );
}
