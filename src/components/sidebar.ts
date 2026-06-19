import type { AppContext, AppState, Route, Folder, Deck } from '../types';
import { generateId, addTouchDragSupport, availabilityColor, pct } from '../utils';
import { promptModal } from './modal';
import { findParentFolder } from '../services/deckService';
import { deckAvailability, deckEase } from '../services/knowledgeService';
import { t } from '../services/i18nService';

// Folders are expanded by default; this set tracks the ones manually collapsed.
const collapsed = new Set<string>();
let lastAutoExpandedRoute: string | null = null;

// ── Drag & Drop state ─────────────────────────────────────────────────────────

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

// ── Drag & Drop mutation helpers ──────────────────────────────────────────────

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

// ── Drag handler attachment ───────────────────────────────────────────────────

function addDragHandlers(
  el: HTMLElement,
  type: 'folder' | 'deck',
  id: string,
  isFolder: boolean,
  ctx: AppContext
): void {
  el.draggable = true;

  el.addEventListener('dragstart', (e) => {
    dragState = { type, id };
    e.dataTransfer?.setData('text/plain', id);
    setTimeout(() => el.classList.add('opacity-40'), 0);
  });

  el.addEventListener('dragend', () => {
    dragState = null;
    el.classList.remove('opacity-40');
    clearDropIndicators();
  });

  el.addEventListener('dragover', (e) => {
    if (!dragState || dragState.id === id) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = getDropZone(e, el, isFolder);
    setDropIndicator(el, zone);
  });

  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget as Node)) {
      clearDropIndicators();
    }
  });

  el.addEventListener('drop', (e) => {
    if (!dragState) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = getDropZone(e, el, isFolder);
    clearDropIndicators();
    const ds = dragState;
    dragState = null;
    if (ds.id === id) return;
    ctx.mutate(s => moveSidebarItem(s, ds, { type, id }, zone));
  });
}

// ── Expand / active helpers ───────────────────────────────────────────────────

function expandAncestors(id: string, type: 'deck' | 'folder', user: AppState): void {
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

// ── Tree item renderers ───────────────────────────────────────────────────────

function renderDeckItem(ctx: AppContext, deck: Deck, depth: number): HTMLElement {
  const active = isActive(ctx.route, 'deck', deck.id);
  const el = document.createElement('div');
  el.style.paddingLeft = `${depth * 12 + 8}px`;
  el.className = `flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer group transition-colors text-sm
    ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`;
  const icon = document.createElement('span');
  icon.className = `shrink-0 flex items-center ${active ? 'text-accent' : 'text-dim opacity-70'}`;
  icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
  const name = document.createElement('span'); name.className = 'truncate flex-1'; name.textContent = deck.name;

  el.append(icon, name);

  if (deck.entries.length > 0) {
    const user = ctx.user;
    const profileId = ctx.user.currentProfileId;
    const w = user.weightByImportance ?? true;
    const avail = deckAvailability(user, profileId, deck, ctx.user.cards, ctx.user.cardWorks, w);
    const ease  = deckEase(profileId, deck, ctx.user.cards, ctx.user.cardWorks, w);
    const dots  = document.createElement('span');
    dots.className = 'flex gap-0.5 items-center shrink-0';
    const recallDot = document.createElement('span');
    recallDot.className = `w-2 h-2 rounded-full ${availabilityColor(avail)}`;
    recallDot.title = t('deck.dot.recall', { pct: pct(avail) });
    const easeDot = document.createElement('span');
    easeDot.className = `w-2 h-2 rounded-full ${ease === 0 ? 'bg-border' : ease >= 0.6 ? 'bg-success' : ease >= 0.35 ? 'bg-warn' : 'bg-danger'}`;
    easeDot.title = ease === 0 ? t('deck.neverReviewed') : t('deck.dot.ease', { pct: pct(ease) });
    dots.append(recallDot, easeDot);
    el.appendChild(dots);
  }

  el.onclick = () => ctx.navigate({ view: 'deck', deckId: deck.id });

  addDragHandlers(el, 'deck', deck.id, false, ctx);
  addTouchDragSupport(el);
  return el;
}

function renderFolderItem(ctx: AppContext, folder: Folder, depth: number): HTMLElement {
  const active = isActive(ctx.route, 'folder', folder.id);
  const isOpen = !collapsed.has(folder.id);
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.style.paddingLeft = `${depth * 12 + 8}px`;
  row.className = `flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer transition-colors text-sm
    ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`;

  const svgFolderClosed = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const svgFolderOpen  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`;

  const folderIcon = document.createElement('span');
  folderIcon.className = `shrink-0 flex items-center cursor-pointer ${active ? 'text-accent' : 'text-dim'}`;
  folderIcon.innerHTML = isOpen ? svgFolderOpen : svgFolderClosed;

  folderIcon.onclick = (e) => {
    e.stopPropagation();
    if (collapsed.has(folder.id)) collapsed.delete(folder.id); else collapsed.add(folder.id);
    const sidebar = wrap.closest('aside');
    if (sidebar) sidebar.replaceWith(renderSidebar(ctx));
  };

  const name = document.createElement('span'); name.className = 'truncate flex-1 font-medium'; name.textContent = folder.name;

  const actions = document.createElement('div'); actions.className = 'hidden group-hover:flex items-center gap-0.5 shrink-0';

  row.append(folderIcon, name);
  row.onclick = () => ctx.navigate({ view: 'folder', folderId: folder.id });

  addDragHandlers(row, 'folder', folder.id, true, ctx);
  addTouchDragSupport(row);

  wrap.appendChild(row);

  if (isOpen) {
    const children = document.createElement('div');
    for (const subId of folder.folderIds) { const sub = ctx.user.folders[subId]; if (sub) children.appendChild(renderFolderItem(ctx, sub, depth + 1)); }
    for (const deckId of folder.deckIds) { const deck = ctx.user.decks[deckId]; if (deck) children.appendChild(renderDeckItem(ctx, deck, depth + 1)); }
    wrap.appendChild(children);
  }
  return wrap;
}


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

export function renderSidebar(ctx: AppContext): HTMLElement {
  const { route, user } = ctx;
  const routeKey = JSON.stringify(route);
  if (routeKey !== lastAutoExpandedRoute) {
    lastAutoExpandedRoute = routeKey;
    if ((route.view === 'deck' || route.view === 'study') && 'deckId' in route) {
      expandAncestors(route.deckId, 'deck', user);
    }
    if (route.view === 'folder' && route.folderId) {
      collapsed.delete(route.folderId);
      expandAncestors(route.folderId, 'folder', user);
    }
  }

  const aside = document.createElement('aside');
  aside.className = 'flex flex-col h-full bg-surface border-r border-border w-full';

  const mkIconBtn = (svgString: string, title: string, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.className = 'w-6 h-6 flex items-center justify-center rounded text-dim hover:text-primary hover:bg-elevated transition-colors cursor-pointer border-none bg-transparent';
    btn.title = title;
    btn.innerHTML = svgString;
    btn.onclick = onClick;
    return btn;
  };

  const svgExpandAll   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>`;
  const svgCollapseAll = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/></svg>`;

  const top = document.createElement('div');
  top.className = 'shrink-0 px-2 py-1 flex items-center justify-end gap-0.5 border-b border-border';
  top.append(
    mkIconBtn(svgExpandAll, t('sidebar.expandAll'), () => {
      collapsed.clear();
      aside.replaceWith(renderSidebar(ctx));
    }),
    mkIconBtn(svgCollapseAll, t('sidebar.collapseAll'), () => {
      for (const id of collectAllFolderIds(user)) collapsed.add(id);
      aside.replaceWith(renderSidebar(ctx));
    }),
  );

  const tree = document.createElement('div');
  tree.className = 'flex-1 overflow-y-auto py-1 px-2 space-y-0.5';
  for (const folderId of user.rootFolderIds) { const folder = user.folders[folderId]; if (folder) tree.appendChild(renderFolderItem(ctx, folder, 0)); }
  for (const deckId of user.rootDeckIds) { const deck = user.decks[deckId]; if (deck) tree.appendChild(renderDeckItem(ctx, deck, 0)); }

  const bottom = document.createElement('div');
  bottom.className = 'border-t border-border shrink-0 px-3 py-2 flex items-center justify-between';

  const newLabel = document.createElement('span');
  newLabel.className = 'text-[10px] text-dim select-none';
  newLabel.textContent = t('sidebar.new');

  const newBtns = document.createElement('div');
  newBtns.className = 'flex items-center gap-1';

  const svgFolder = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const svgDeck   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;

  newBtns.appendChild(mkIconBtn(svgFolder, t('sidebar.newFolder'), () =>
    promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
      ctx.mutate(s => {
        const id = generateId();
        s.folders[id] = { id, name, folderIds: [], deckIds: [] };
        s.rootFolderIds.push(id);
      });
    })
  ));
  newBtns.appendChild(mkIconBtn(svgDeck, t('sidebar.newDeck'), () => showCreateDeckModal(ctx, null)));

  bottom.append(newLabel, newBtns);
  aside.append(top, tree, bottom);
  return aside;
}
