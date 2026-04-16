import type { AppContext, AppState, Route, Folder, Deck } from '../types';
import { generateId, emptyState } from '../utils';
import { promptModal, confirmModal, showModal, closeModal } from './modal';
import { getCurrentUser, updateUser, ensureCurrentUser } from '../services/userService';
import { findParentFolder } from '../services/deckService';
import { deckKnowledgeBuckets } from '../services/knowledgeService';
import { showCommandPalette } from './commandPalette';
import { exportFull, exportContent, parseImport } from '../services/importExport';

const expanded = new Set<string>();

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

function removeFromParent(s: AppState, type: 'folder' | 'deck', id: string): void {
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
    // Same type: insert into the same array as the target
    const rootArr = drag.type === 'folder' ? s.rootFolderIds : s.rootDeckIds;
    if (!tryInsertInto(rootArr, target.id, drag.id, before)) {
      for (const f of Object.values(s.folders) as Folder[]) {
        const arr = drag.type === 'folder' ? f.folderIds : f.deckIds;
        if (tryInsertInto(arr, target.id, drag.id, before)) break;
      }
    }
  } else {
    // Cross-type: add to the same parent container as the target
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
  // Cycle guard: can't drop a folder into one of its descendants
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

/** Expand all ancestor folders of a deck so it's visible in the tree. */
function expandAncestors(deckId: string, state: AppState): void {
  let current: string | null = findParentFolder(deckId, 'deck', state);
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

function mkIconBtn(text: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'px-1 py-0.5 text-[10px] text-dim hover:text-primary transition-colors cursor-pointer rounded hover:bg-border';
  btn.textContent = text; btn.title = title; return btn;
}

// ── Tree item renderers ───────────────────────────────────────────────────────

function renderDeckItem(ctx: AppContext, deck: Deck, depth: number): HTMLElement {
  const active = isActive(ctx.route, 'deck', deck.id);
  const el = document.createElement('div');
  el.style.paddingLeft = `${depth * 12 + 8}px`;
  el.className = `flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer group transition-colors text-sm
    ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`;
  const icon = document.createElement('span'); icon.className = 'text-xs opacity-60 shrink-0'; icon.textContent = '▪';
  const name = document.createElement('span'); name.className = 'truncate flex-1'; name.textContent = deck.name;

  // Mini knowledge distribution bar (weighted by card importance)
  const user = getCurrentUser(ctx.state);
  const { buckets, total } = deckKnowledgeBuckets(user, deck, ctx.state.cards, ctx.state.cardWorks, user.weightByImportance ?? true);
  const miniBar = document.createElement('div');
  miniBar.className = 'flex h-1 w-10 rounded overflow-hidden shrink-0 opacity-60 group-hover:opacity-100 transition-opacity bg-border';
  if (total > 0) {
    for (const [i, cls] of (['bg-danger', 'bg-warn', 'bg-success/60', 'bg-success'] as const).entries()) {
      const w = buckets[i]! / total;
      if (w === 0) continue;
      const s = document.createElement('div'); s.className = cls; s.style.width = `${w * 100}%`;
      miniBar.appendChild(s);
    }
  }

  el.append(icon, name, miniBar);
  el.onclick = () => ctx.navigate({ view: 'deck', deckId: deck.id });

  addDragHandlers(el, 'deck', deck.id, false, ctx);
  return el;
}

function renderFolderItem(ctx: AppContext, folder: Folder, depth: number): HTMLElement {
  const active = isActive(ctx.route, 'folder', folder.id);
  const isOpen = expanded.has(folder.id);
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.style.paddingLeft = `${depth * 12 + 8}px`;
  row.className = `flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer group transition-colors text-sm
    ${active ? 'bg-elevated text-primary' : 'text-muted hover:text-primary hover:bg-elevated'}`;

  const toggle = document.createElement('span');
  toggle.className = 'text-xs shrink-0'; toggle.textContent = isOpen ? '▾' : '▸';

  const toggleExpand = () => {
    if (expanded.has(folder.id)) expanded.delete(folder.id); else expanded.add(folder.id);
    const sidebar = wrap.closest('aside');
    if (sidebar) sidebar.replaceWith(renderSidebar(ctx));
  };
  toggle.onclick = (e) => { e.stopPropagation(); toggleExpand(); };

  const name = document.createElement('span'); name.className = 'truncate flex-1 font-medium'; name.textContent = folder.name;

  const actions = document.createElement('div'); actions.className = 'hidden group-hover:flex items-center gap-0.5 shrink-0';

  const addFolderBtn = mkIconBtn('+F', 'Add subfolder');
  addFolderBtn.onclick = (e) => { e.stopPropagation(); promptModal('New Subfolder', 'Name', '', n => { ctx.mutate(s => { const id = generateId(); s.folders[id] = { userId: s.currentUserId, id, name: n, folderIds: [], deckIds: [] }; s.folders[folder.id]!.folderIds.push(id); }); }); };

  const addDeckBtn = mkIconBtn('+D', 'Add deck');
  addDeckBtn.onclick = (e) => { e.stopPropagation(); showCreateDeckModal(ctx, folder.id); };

  const renameBtn = mkIconBtn('✎', 'Rename');
  renameBtn.onclick = (e) => { e.stopPropagation(); promptModal('Rename', 'New name', folder.name, n => { ctx.mutate(s => { s.folders[folder.id]!.name = n; }); }); };

  const deleteBtn = mkIconBtn('✕', 'Delete');
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    confirmModal('Delete Folder', `Delete "${folder.name}" and all its contents?`, 'Delete', () => {
      ctx.mutate(s => deleteFolderRecursive(s, folder.id));
      ctx.navigate({ view: 'folder', folderId: null });
    });
  };

  actions.append(addFolderBtn, addDeckBtn, renameBtn, deleteBtn);
  row.append(toggle, name, actions);
  row.onclick = () => ctx.navigate({ view: 'folder', folderId: folder.id });

  addDragHandlers(row, 'folder', folder.id, true, ctx);

  wrap.appendChild(row);

  if (isOpen) {
    const children = document.createElement('div');
    for (const subId of folder.folderIds) { const sub = ctx.state.folders[subId]; if (sub) children.appendChild(renderFolderItem(ctx, sub, depth + 1)); }
    for (const deckId of folder.deckIds) { const deck = ctx.state.decks[deckId]; if (deck) children.appendChild(renderDeckItem(ctx, deck, depth + 1)); }
    wrap.appendChild(children);
  }
  return wrap;
}

function deleteFolderRecursive(s: AppState, folderId: string): void {
  const folder = s.folders[folderId];
  if (!folder) return;
  for (const subId of folder.folderIds) deleteFolderRecursive(s, subId);
  for (const deckId of folder.deckIds) delete s.decks[deckId];
  delete s.folders[folderId];
  s.rootFolderIds = s.rootFolderIds.filter((id: string) => id !== folderId);
  for (const f of Object.values(s.folders) as Folder[]) f.folderIds = f.folderIds.filter((id: string) => id !== folderId);
}

export function showCreateDeckModal(ctx: AppContext, parentFolderId: string | null): void {
  promptModal('New Deck', 'Deck name', '', name => {
    const id = generateId();
    ctx.mutate(s => {
      s.decks[id] = { id, name, entries: [] };
      if (parentFolderId) s.folders[parentFolderId]!.deckIds.push(id);
      else s.rootDeckIds.push(id);
    }).then(() => ctx.navigate({ view: 'deck', deckId: id }));
  });
}

function showUserSettings(ctx: AppContext): void {
  const user = getCurrentUser(ctx.state);

  const body = document.createElement('div'); body.className = 'space-y-4';

  const mkField = (label: string, hint: string, inputFn: (inp: HTMLInputElement) => void): HTMLInputElement => {
    const wrap = document.createElement('div'); wrap.className = 'space-y-1';
    const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = label;
    const inp = document.createElement('input'); inp.className = 'input';
    inputFn(inp);
    wrap.append(lbl, inp);
    if (hint) { const hintEl = document.createElement('p'); hintEl.className = 'text-xs text-dim leading-relaxed'; hintEl.textContent = hint; wrap.appendChild(hintEl); }
    body.appendChild(wrap);
    return inp;
  };

  const nameInp = mkField('Name', '', inp => { inp.type = 'text'; inp.value = user.name; });

  const mastInp = mkField(
    'Mastery threshold (%)',
    'Cards above this knowledge score are considered mastered and skipped during study sessions.',
    inp => { inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '1'; inp.value = String(Math.round(user.masteryThreshold * 100)); }
  );

  // Weight by importance toggle
  const weightWrap = document.createElement('div'); weightWrap.className = 'space-y-1';
  const weightLbl = document.createElement('label'); weightLbl.className = 'flex items-center gap-2 cursor-pointer';
  const weightChk = document.createElement('input'); weightChk.type = 'checkbox'; weightChk.className = 'card-checkbox'; weightChk.checked = user.weightByImportance ?? true;
  const weightText = document.createElement('span'); weightText.className = 'label mb-0'; weightText.textContent = 'Weight by importance';
  weightLbl.append(weightChk, weightText);
  const weightHint = document.createElement('p'); weightHint.className = 'text-xs text-dim leading-relaxed';
  weightHint.textContent = 'When enabled, a card contributes to deck knowledge proportionally to its importance rather than equally.';
  weightWrap.append(weightLbl, weightHint);
  body.appendChild(weightWrap);

  const confirm = () => {
    const masteryPct = parseFloat(mastInp.value);
    if (isNaN(masteryPct) || masteryPct < 0 || masteryPct > 100) return;
    closeModal();
    ctx.mutate(s => updateUser(s, {
      name: nameInp.value.trim() || user.name,
      masteryThreshold: masteryPct / 100,
      weightByImportance: weightChk.checked,
    }));
  };

  [nameInp, mastInp].forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') closeModal(); });
  });

  showModal('Profile settings', body, [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Save', primary: true, onClick: confirm },
  ]);
  setTimeout(() => nameInp.focus(), 30);
}

export function renderSidebar(ctx: AppContext): HTMLElement {
  const { route, state } = ctx;
  if ((route.view === 'deck' || route.view === 'study') && 'deckId' in route) {
    expandAncestors(route.deckId, state);
  }

  const aside = document.createElement('aside');
  aside.className = 'flex flex-col h-full bg-surface border-r border-border w-56 shrink-0 overflow-hidden';

  // Logo + user
  const top = document.createElement('div');
  top.className = 'px-4 py-3 border-b border-border shrink-0 flex items-center justify-between';
  const logo = document.createElement('span');
  logo.className = 'font-mono text-xs font-semibold tracking-[0.25em] text-muted uppercase select-none';
  logo.textContent = 'Cadence';

  const user = getCurrentUser(ctx.state);
  const userBtn = document.createElement('button');
  userBtn.className = 'text-xs text-dim hover:text-primary transition-colors cursor-pointer truncate max-w-[80px]';
  userBtn.textContent = user.name;
  userBtn.title = 'Profile settings';
  userBtn.onclick = () => showUserSettings(ctx);
  const searchBtn = document.createElement('button');
  searchBtn.className = 'inline-flex items-center text-dim hover:text-primary transition-colors cursor-pointer shrink-0';
  searchBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  searchBtn.title = 'Search [Ctrl+K]';
  searchBtn.onclick = () => showCommandPalette(() => ctx);

  const logoGroup = document.createElement('div');
  logoGroup.className = 'flex items-center gap-2';
  logoGroup.append(logo, searchBtn);

  top.append(logoGroup, userBtn);

  // Nav links
  const nav = document.createElement('div');
  nav.className = 'px-2 mt-2 space-y-0.5 shrink-0';

  const mkRow = (icon: string, label: string, active: boolean, onClick: () => void) => {
    const row = document.createElement('div');
    row.className = `flex items-center gap-2 px-3 py-1.5 rounded cursor-pointer text-sm transition-colors ${active ? 'bg-elevated text-primary' : 'text-muted hover:text-primary hover:bg-elevated'}`;
    row.innerHTML = `<span class="text-xs">${icon}</span><span>${label}</span>`;
    row.onclick = onClick;
    return row;
  };

  nav.appendChild(mkRow('⌂', 'Home', isActive(ctx.route, 'folder', null), () => ctx.navigate({ view: 'folder', folderId: null })));
  nav.appendChild(mkRow('≡', 'All cards', isActive(ctx.route, 'library'), () => ctx.navigate({ view: 'library' })));

  // Tree
  const tree = document.createElement('div');
  tree.className = 'flex-1 overflow-y-auto py-1 px-2 space-y-0.5';
  for (const folderId of state.rootFolderIds) { const folder = state.folders[folderId]; if (folder) tree.appendChild(renderFolderItem(ctx, folder, 0)); }
  for (const deckId of state.rootDeckIds) { const deck = state.decks[deckId]; if (deck) tree.appendChild(renderDeckItem(ctx, deck, 0)); }

  // Bottom
  const bottom = document.createElement('div');
  bottom.className = 'border-t border-border shrink-0 space-y-1 p-2';

  // Create row
  const createRow = document.createElement('div'); createRow.className = 'grid grid-cols-2 gap-1';
  const addFolderBtn = document.createElement('button'); addFolderBtn.className = 'btn-ghost text-xs'; addFolderBtn.textContent = '+ Folder';
  addFolderBtn.onclick = () => promptModal('New Folder', 'Name', '', name => { ctx.mutate(s => { const id = generateId(); s.folders[id] = { userId: s.currentUserId, id, name, folderIds: [], deckIds: [] }; s.rootFolderIds.push(id); }); });
  const addDeckBtn = document.createElement('button'); addDeckBtn.className = 'btn-ghost text-xs'; addDeckBtn.textContent = '+ Deck';
  addDeckBtn.onclick = () => showCreateDeckModal(ctx, null);
  createRow.append(addFolderBtn, addDeckBtn);

  // Data row
  const dataRow = document.createElement('div'); dataRow.className = 'flex gap-1';

  const exportFullBtn = document.createElement('button');
  exportFullBtn.className = 'btn-ghost text-[10px] flex-1'; exportFullBtn.textContent = '↓ Full';
  exportFullBtn.title = 'Export full backup'; exportFullBtn.onclick = () => exportFull(ctx.state);

  const exportContentBtn = document.createElement('button');
  exportContentBtn.className = 'btn-ghost text-[10px] flex-1'; exportContentBtn.textContent = '↓ Lite';
  exportContentBtn.title = 'Export cards & decks without personal data'; exportContentBtn.onclick = () => exportContent(ctx.state);

  const importLabel = document.createElement('label');
  importLabel.className = 'btn-ghost text-[10px] flex-1 cursor-pointer text-center'; importLabel.textContent = '↑ Import';
  importLabel.title = 'Import backup';
  const importInput = document.createElement('input');
  importInput.type = 'file'; importInput.accept = 'application/json'; importInput.className = 'hidden';
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const newState = await parseImport(file);
      confirmModal('Import backup', 'This will replace all current data. Are you sure?', 'Replace', async () => {
        ensureCurrentUser(newState);
        await ctx.mutate(s => { Object.assign(s, newState); });
        ctx.navigate({ view: 'folder', folderId: null });
      });
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    importInput.value = '';
  };
  importLabel.appendChild(importInput);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn-ghost text-[10px] text-danger hover:bg-danger/10 hover:text-danger flex-1';
  resetBtn.textContent = 'Reset'; resetBtn.title = 'Reset database (keeps user profile)';
  resetBtn.onclick = () => {
    confirmModal('Reset database', 'This will permanently delete all cards, decks, folders and study history. Your user profile will be kept. This cannot be undone.', 'Reset', async () => {
      const user = ctx.state.users[ctx.state.currentUserId];
      const fresh = emptyState();
      if (user) { fresh.users[user.id] = user; fresh.currentUserId = user.id; }
      await ctx.mutate(s => { Object.assign(s, fresh); });
      ctx.navigate({ view: 'folder', folderId: null });
    });
  };

  dataRow.append(exportFullBtn, exportContentBtn, importLabel, resetBtn);
  bottom.append(createRow, dataRow);
  aside.append(top, nav, tree, bottom);
  return aside;
}
