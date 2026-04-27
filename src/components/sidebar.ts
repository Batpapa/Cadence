import type { AppContext, AppState, Route, Folder, Deck } from '../types';
import { generateId, helpIcon, addTouchDragSupport } from '../utils';
import { promptModal } from './modal';
import { findParentFolder } from '../services/deckService';
import { showCommandPalette } from './commandPalette';
import { showHelpModal } from './help';
import { t } from '../services/i18nService';
import { isDriveFeatureEnabled, getDriveStatus, onStatusChange, manualSync, type DriveStatus } from '../services/driveService';
import { showSettingsModal } from './settingsModal';

const expanded = new Set<string>();
let lastAutoExpandedRoute: string | null = null;
let driveStatusUnsub: (() => void) | null = null;

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

function expandAncestors(id: string, type: 'deck' | 'folder', state: AppState): void {
  let current: string | null = findParentFolder(id, type, state);
  while (current) {
    expanded.add(current);
    current = findParentFolder(current, 'folder', state);
  }
}

function isActive(route: Route, type: 'folder' | 'deck' | 'library', id: string | null = null): boolean {
  if (type === 'library') return route.view === 'library';
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
  el.onclick = () => ctx.navigate({ view: 'deck', deckId: deck.id });

  addDragHandlers(el, 'deck', deck.id, false, ctx);
  addTouchDragSupport(el);
  return el;
}

function renderFolderItem(ctx: AppContext, folder: Folder, depth: number): HTMLElement {
  const active = isActive(ctx.route, 'folder', folder.id);
  const isOpen = expanded.has(folder.id);
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.style.paddingLeft = `${depth * 12 + 8}px`;
  row.className = `flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer transition-colors text-sm
    ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`;

  const isEmpty = folder.folderIds.length === 0 && folder.deckIds.length === 0;

  const svgFolderClosed = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const svgFolderOpen  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`;

  const folderIcon = document.createElement('span');
  folderIcon.className = `shrink-0 flex items-center ${active ? 'text-accent' : 'text-dim'} ${!isEmpty ? 'cursor-pointer' : ''}`;
  folderIcon.innerHTML = isOpen ? svgFolderOpen : svgFolderClosed;

  if (!isEmpty) {
    folderIcon.onclick = (e) => {
      e.stopPropagation();
      if (expanded.has(folder.id)) expanded.delete(folder.id); else expanded.add(folder.id);
      const sidebar = wrap.closest('aside');
      if (sidebar) sidebar.replaceWith(renderSidebar(ctx));
    };
  }

  const name = document.createElement('span'); name.className = 'truncate flex-1 font-medium'; name.textContent = folder.name;

  const actions = document.createElement('div'); actions.className = 'hidden group-hover:flex items-center gap-0.5 shrink-0';

  row.append(folderIcon, name);
  row.onclick = () => ctx.navigate({ view: 'folder', folderId: folder.id });

  addDragHandlers(row, 'folder', folder.id, true, ctx);
  addTouchDragSupport(row);

  wrap.appendChild(row);

  if (isOpen) {
    const children = document.createElement('div');
    for (const subId of folder.folderIds) { const sub = ctx.state.folders[subId]; if (sub) children.appendChild(renderFolderItem(ctx, sub, depth + 1)); }
    for (const deckId of folder.deckIds) { const deck = ctx.state.decks[deckId]; if (deck) children.appendChild(renderDeckItem(ctx, deck, depth + 1)); }
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
  const { route, state } = ctx;
  const routeKey = JSON.stringify(route);
  if (routeKey !== lastAutoExpandedRoute) {
    lastAutoExpandedRoute = routeKey;
    if ((route.view === 'deck' || route.view === 'study') && 'deckId' in route) {
      expandAncestors(route.deckId, 'deck', state);
    }
    if (route.view === 'folder' && route.folderId) {
      expanded.add(route.folderId);
      expandAncestors(route.folderId, 'folder', state);
    }
  }

  const aside = document.createElement('aside');
  aside.className = 'flex flex-col h-full bg-surface border-r border-border w-56 shrink-0 overflow-hidden';

  const top = document.createElement('div');
  top.className = 'px-4 py-3 border-b border-border shrink-0 flex items-center justify-between';
  const logo = document.createElement('span');
  logo.className = 'font-mono text-xs font-semibold tracking-[0.25em] text-muted uppercase select-none';
  logo.textContent = t('sidebar.logo');

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'inline-flex items-center text-dim hover:text-primary transition-colors cursor-pointer shrink-0';
  settingsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  settingsBtn.title = t('sidebar.settings');
  settingsBtn.onclick = () => showSettingsModal(ctx);

  const searchBtn = document.createElement('button');
  searchBtn.className = 'inline-flex items-center text-dim hover:text-primary transition-colors cursor-pointer shrink-0';
  searchBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  searchBtn.title = t('sidebar.search');
  searchBtn.onclick = () => showCommandPalette(() => ctx);

  const mkNavBtn = (arrow: string, title: string, enabled: boolean, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.className = `inline-flex items-center text-xs transition-colors cursor-pointer shrink-0 ${enabled ? 'text-dim hover:text-primary' : 'text-border cursor-default'}`;
    btn.textContent = arrow; btn.title = title;
    if (enabled) btn.onclick = onClick;
    return btn;
  };

  const backBtn = mkNavBtn('←', t('sidebar.back'),    ctx.canGoBack,    () => ctx.back());
  const fwdBtn  = mkNavBtn('→', t('sidebar.forward'), ctx.canGoForward, () => ctx.forward());

  const helpBtn = document.createElement('button');
  helpBtn.className = 'inline-flex items-center text-dim hover:text-primary transition-colors cursor-pointer shrink-0';
  helpBtn.title = t('sidebar.help');
  helpBtn.appendChild(helpIcon());
  helpBtn.onclick = () => showHelpModal(ctx);

  const iconGroup = document.createElement('div');
  iconGroup.className = 'flex items-center gap-2';

  if (isDriveFeatureEnabled()) {
    const syncBtn = document.createElement('button');
    const cloudUpSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>`;
    syncBtn.innerHTML = cloudUpSvg;

    const applyStatus = (s: DriveStatus) => {
      if (s === 'disconnected' || s === 'connecting') {
        syncBtn.style.display = 'none';
        syncBtn.onclick = null;
        return;
      }
      syncBtn.style.display = '';
      switch (s) {
        case 'pending':
          syncBtn.className = 'inline-flex items-center transition-colors cursor-pointer shrink-0 text-yellow-400';
          syncBtn.title = t('sidebar.sync.pending');
          syncBtn.onclick = () => { void manualSync(); };
          break;
        case 'syncing':
          syncBtn.className = 'inline-flex items-center transition-colors cursor-default shrink-0 text-accent animate-pulse';
          syncBtn.title = t('sidebar.sync.syncing');
          syncBtn.onclick = null;
          break;
        case 'connected':
          syncBtn.className = 'inline-flex items-center transition-colors cursor-default shrink-0 text-green-500';
          syncBtn.title = t('sidebar.sync.connected');
          syncBtn.onclick = null;
          break;
        case 'error':
          syncBtn.className = 'inline-flex items-center transition-colors cursor-pointer shrink-0 text-danger';
          syncBtn.title = t('sidebar.sync.error');
          syncBtn.onclick = () => { void manualSync(); };
          break;
      }
    };

    if (driveStatusUnsub) { driveStatusUnsub(); driveStatusUnsub = null; }
    applyStatus(getDriveStatus());
    driveStatusUnsub = onStatusChange(applyStatus);
    iconGroup.appendChild(syncBtn);
  }

  iconGroup.append(backBtn, fwdBtn, searchBtn, helpBtn, settingsBtn);

  top.append(logo, iconGroup);

  const nav = document.createElement('div');
  nav.className = 'px-2 mt-2 mb-2 space-y-0.5 shrink-0';

  const mkRow = (iconSvg: string, label: string, active: boolean, onClick: () => void) => {
    const row = document.createElement('div');
    row.className = `flex items-center gap-2 px-3 py-1.5 rounded cursor-pointer text-sm transition-colors ${active ? 'bg-accent/10 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`;
    const iconEl = document.createElement('span');
    iconEl.className = `shrink-0 flex items-center ${active ? 'text-accent' : 'text-dim'}`;
    iconEl.innerHTML = iconSvg;
    const labelEl = document.createElement('span'); labelEl.textContent = label;
    row.append(iconEl, labelEl);
    row.onclick = onClick;
    return row;
  };

  const svgHome = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
  const svgLib  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;

  nav.appendChild(mkRow(svgHome, t('sidebar.home'),     isActive(ctx.route, 'folder', null), () => ctx.navigate({ view: 'folder', folderId: null })));
  nav.appendChild(mkRow(svgLib,  t('sidebar.library'),  isActive(ctx.route, 'library'),      () => ctx.navigate({ view: 'library' })));

  const tree = document.createElement('div');
  tree.className = 'flex-1 overflow-y-auto py-1 px-2 space-y-0.5 border-t border-border';
  for (const folderId of state.rootFolderIds) { const folder = state.folders[folderId]; if (folder) tree.appendChild(renderFolderItem(ctx, folder, 0)); }
  for (const deckId of state.rootDeckIds) { const deck = state.decks[deckId]; if (deck) tree.appendChild(renderDeckItem(ctx, deck, 0)); }

  const bottom = document.createElement('div');
  bottom.className = 'border-t border-border shrink-0 px-3 py-2 flex items-center justify-between';

  const newLabel = document.createElement('span');
  newLabel.className = 'text-[10px] text-dim select-none';
  newLabel.textContent = t('sidebar.new');

  const newBtns = document.createElement('div');
  newBtns.className = 'flex items-center gap-1';

  const mkBottomIconBtn = (svgString: string, title: string, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.className = 'w-6 h-6 flex items-center justify-center rounded text-dim hover:text-primary hover:bg-elevated transition-colors cursor-pointer border-none bg-transparent';
    btn.title = title;
    btn.innerHTML = svgString;
    btn.onclick = onClick;
    return btn;
  };

  const svgFolder = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const svgDeck   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;

  newBtns.appendChild(mkBottomIconBtn(svgFolder, t('sidebar.newFolder'), () =>
    promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
      ctx.mutate(s => {
        const id = generateId();
        s.folders[id] = { userId: s.currentUserId, id, name, folderIds: [], deckIds: [] };
        s.rootFolderIds.push(id);
      });
    })
  ));
  newBtns.appendChild(mkBottomIconBtn(svgDeck, t('sidebar.newDeck'), () => showCreateDeckModal(ctx, null)));

  bottom.append(newLabel, newBtns);
  aside.append(top, nav, tree, bottom);
  return aside;
}
