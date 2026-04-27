import type { AppContext, AppState, Route, Folder, Deck } from '../types';
import { generateId, emptyState, helpIcon, trashIcon, addTouchDragSupport } from '../utils';
import { promptModal, confirmModal, closeModal, showModal } from './modal';
import { getCurrentUser, updateUser, ensureCurrentUser, ensureCurrentProfile } from '../services/userService';
import { findParentFolder } from '../services/deckService';
import { showCommandPalette } from './commandPalette';
import { showHelpModal } from './help';
import { exportBackup, parseImport } from '../services/importExport';
import { t, setLanguage } from '../services/i18nService';
import { isStandalone, isIOS, canInstall, triggerInstall } from '../services/pwaService';
import { isDriveFeatureEnabled, getDriveStatus, onStatusChange, connectDrive, disconnectDrive, manualSync, type DriveStatus } from '../services/driveService';
import type { Lang } from '../services/i18nService';
import { getContext, mutate } from '../store';
import { migrateState } from '../services/migration';

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
  row.className = `flex items-center gap-1.5 py-1 pr-2 rounded cursor-pointer group transition-colors text-sm
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

  const addFolderBtn = mkIconBtn('+F', t('sidebar.addSubfolder'));
  addFolderBtn.onclick = (e) => { e.stopPropagation(); promptModal(t('modal.newSubfolder.title'), t('modal.newFolder.label'), '', n => { ctx.mutate(s => { const id = generateId(); s.folders[id] = { userId: s.currentUserId, id, name: n, folderIds: [], deckIds: [] }; s.folders[folder.id]!.folderIds.push(id); }); }); };

  const addDeckBtn = mkIconBtn('+D', t('sidebar.addDeck'));
  addDeckBtn.onclick = (e) => { e.stopPropagation(); showCreateDeckModal(ctx, folder.id); };

  actions.append(addFolderBtn, addDeckBtn);
  row.append(folderIcon, name, actions);
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

function showSettingsModal(ctx: AppContext): void {
  type SectionId = 'study' | 'user' | 'data' | 'about';

  // ── Overlay & dialog ──────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden';
  dialog.style.cssText = 'width:560px; max-width:90vw; height:520px; max-height:90vh;';

  let driveUnsub: (() => void) | null = null;

  const closeSettings = () => {
    if (driveUnsub) { driveUnsub(); driveUnsub = null; }
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeSettings(); });

  // Header
  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0';
  const titleEl = document.createElement('span');
  titleEl.className = 'text-sm font-semibold text-primary'; titleEl.textContent = t('settings.title');
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer';
  closeBtn.textContent = '✕'; closeBtn.onclick = closeSettings;
  header.append(titleEl, closeBtn);

  // Nav + content wrapper
  const bodyEl = document.createElement('div');
  bodyEl.className = 'flex flex-1 overflow-hidden';
  bodyEl.style.minHeight = '0';

  const navEl = document.createElement('div');
  navEl.className = 'shrink-0 flex flex-col gap-0.5 p-2 bg-surface border-r border-border overflow-y-auto';
  navEl.style.width = '148px';

  const content = document.createElement('div');
  content.className = 'flex-1 overflow-y-auto p-5 space-y-4';

  bodyEl.append(navEl, content);
  dialog.append(header, bodyEl);
  overlay.appendChild(dialog);

  // ── Sections definition ───────────────────────────────────────────────────────
  const SECTIONS: Array<{ id: SectionId; icon: string; labelKey: string }> = [
    {
      id: 'study',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
      labelKey: 'settings.study',
    },
    {
      id: 'user',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      labelKey: 'settings.user',
    },
    {
      id: 'data',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
      labelKey: 'settings.data',
    },
    {
      id: 'about',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
      labelKey: 'settings.about',
    },
  ];

  let activeSection: SectionId = 'study';

  const renderNav = () => {
    navEl.innerHTML = '';
    for (const sec of SECTIONS) {
      const btn = document.createElement('button');
      const isActive = sec.id === activeSection;
      btn.className = `flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${
        isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-elevated hover:text-primary'
      }`;
      const iconEl = document.createElement('span');
      iconEl.className = 'shrink-0 flex items-center';
      iconEl.innerHTML = sec.icon;
      const labelEl = document.createElement('span'); labelEl.className = `text-sm ${isActive ? 'font-medium' : ''}`; labelEl.textContent = t(sec.labelKey);
      btn.append(iconEl, labelEl);
      btn.onclick = () => { activeSection = sec.id; renderNav(); renderContent(); };
      navEl.appendChild(btn);
    }
  };

  // ── Layout helpers ────────────────────────────────────────────────────────────
  const mkRow = (label: string, hint: string | null, control: HTMLElement): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-4 py-2.5';
    const left = document.createElement('div');
    const lbl = document.createElement('div'); lbl.className = 'text-sm text-primary'; lbl.textContent = label; left.appendChild(lbl);
    if (hint) { const h = document.createElement('div'); h.className = 'text-xs text-dim mt-0.5 leading-relaxed'; h.textContent = hint; left.appendChild(h); }
    row.append(left, control); return row;
  };

  const mkToggle = (checked: boolean, onChange: (v: boolean) => void): HTMLElement => {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'width:34px; height:18px; display:block; position:relative; cursor:pointer; flex-shrink:0;';
    const track = document.createElement('div');
    track.style.cssText = `width:34px; height:18px; border-radius:99px; background:${checked ? '#8b7cf8' : '#252525'}; transition:background 0.15s;`;
    const thumb = document.createElement('div');
    thumb.style.cssText = `position:absolute; top:2px; left:${checked ? '16px' : '2px'}; width:14px; height:14px; border-radius:50%; background:white; transition:left 0.15s; box-shadow:0 1px 3px rgba(0,0,0,0.3);`;
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = checked;
    inp.style.cssText = 'position:absolute; opacity:0; inset:0; cursor:pointer;';
    inp.onchange = () => {
      const v = inp.checked;
      track.style.background = v ? '#8b7cf8' : '#252525';
      thumb.style.left = v ? '16px' : '2px';
      onChange(v);
    };
    lbl.append(track, thumb, inp); return lbl;
  };

  // ── Section content renderer ──────────────────────────────────────────────────
  const renderContent = () => {
    if (driveUnsub) { driveUnsub(); driveUnsub = null; }
    content.innerHTML = '';
    const freshState = getContext().state;
    const freshUser  = getCurrentUser(freshState);
    const saveField  = (patch: Parameters<typeof updateUser>[1]) => ctx.mutate(s => updateUser(s, patch));

    // ── Study ──
    if (activeSection === 'study') {
      const threshInp = document.createElement('input');
      threshInp.type = 'number'; threshInp.min = '0'; threshInp.max = '100'; threshInp.step = '1';
      threshInp.value = String(Math.round(freshUser.availabilityThreshold * 100));
      threshInp.className = 'input w-16 text-right font-mono text-sm';
      threshInp.addEventListener('blur', () => {
        const pct = parseFloat(threshInp.value);
        if (!isNaN(pct) && pct >= 0 && pct <= 100) saveField({ availabilityThreshold: pct / 100 });
        else threshInp.value = String(Math.round(freshUser.availabilityThreshold * 100));
      });
      threshInp.addEventListener('keydown', e => { if (e.key === 'Enter') threshInp.blur(); if (e.key === 'Escape') closeSettings(); });
      content.appendChild(mkRow(t('settings.availabilityThreshold'), t('settings.availabilityThresholdHint'), threshInp));

      content.appendChild(mkRow(
        t('settings.weightByImportance'), t('settings.weightByImportanceHint'),
        mkToggle(freshUser.weightByImportance ?? true, v => saveField({ weightByImportance: v })),
      ));

      const sep = document.createElement('hr'); sep.className = 'border-border'; content.appendChild(sep);
      const profList = document.createElement('div'); profList.className = 'space-y-1';

      const renderProfilesList = () => {
        profList.innerHTML = '';
        const ps = getContext().state;
        const cu = getCurrentUser(ps);
        const canDelete = (cu.profileIds?.length ?? 0) > 1;
        for (const pid of cu.profileIds ?? []) {
          const profile = ps.profiles[pid]; if (!profile) continue;
          const isActive = pid === ps.currentProfileId;
          const row = document.createElement('div');
          row.className = `flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
            isActive ? 'border-accent/25 bg-accent/5' : 'border-border bg-bg hover:border-muted'
          }`;
          const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'active-profile';
          radio.checked = isActive; radio.className = 'cursor-pointer accent-[var(--color-accent)] shrink-0';
          radio.onchange = () => {
            ctx.mutate(s => { s.currentProfileId = pid; }).then(() => {
              const freshCtx = getContext();
              if (freshCtx.route.view === 'study') freshCtx.navigate({ view: 'study', deckId: freshCtx.route.deckId, strategy: freshCtx.route.strategy });
              renderProfilesList();
            });
          };
          const nameEl = document.createElement('span');
          nameEl.className = `text-sm flex-1 truncate cursor-text ${isActive ? 'text-accent font-medium' : 'text-primary'}`;
          nameEl.textContent = profile.name; nameEl.title = t('settings.profiles.clickToRename');
          nameEl.onclick = () => {
            const inp = document.createElement('input'); inp.type = 'text'; inp.value = profile.name;
            inp.className = 'text-sm bg-transparent border-b border-accent outline-none flex-1 min-w-0';
            nameEl.replaceWith(inp); inp.focus(); inp.select();
            const commit = () => {
              const val = inp.value.trim();
              if (val && val !== profile.name) ctx.mutate(s => { s.profiles[pid]!.name = val; }).then(renderProfilesList);
              else renderProfilesList();
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } if (e.key === 'Escape') renderProfilesList(); });
          };
          row.append(radio, nameEl);
          if (canDelete) {
            const delBtn = document.createElement('button'); delBtn.className = 'btn-danger px-2 shrink-0'; delBtn.title = t('settings.profiles.delete.title');
            delBtn.appendChild(trashIcon(12));
            delBtn.onclick = () => confirmModal(t('settings.profiles.delete.title'), t('settings.profiles.delete.message', { name: profile.name }), t('common.delete'), () => {
              ctx.mutate(s => {
                const u = s.users[s.currentUserId]!;
                u.profileIds = (u.profileIds ?? []).filter(id => id !== pid);
                if (s.currentProfileId === pid) s.currentProfileId = u.profileIds[0] ?? '';
                for (const key of Object.keys(s.cardWorks)) { if (key.startsWith(`${pid}:`)) delete s.cardWorks[key]; }
                delete s.profiles[pid];
              }).then(renderProfilesList);
            });
            row.appendChild(delBtn);
          }
          profList.appendChild(row);
        }
      };
      renderProfilesList();
      content.appendChild(profList);

      // Inline add
      const addRow2 = document.createElement('div'); addRow2.className = 'mt-2';
      const addBtn2 = document.createElement('button'); addBtn2.className = 'btn-ghost text-xs w-full'; addBtn2.textContent = t('settings.profiles.add');
      const addInp2 = document.createElement('input'); addInp2.type = 'text'; addInp2.placeholder = t('settings.profiles.nameLabel'); addInp2.className = 'input text-xs w-full hidden';
      const commitAdd = () => {
        const name = addInp2.value.trim();
        addInp2.value = ''; addInp2.classList.add('hidden'); addBtn2.classList.remove('hidden');
        if (!name) return;
        const pid = generateId();
        ctx.mutate(s => {
          s.profiles[pid] = { id: pid, name };
          const u = s.users[s.currentUserId]!;
          if (!u.profileIds) u.profileIds = [];
          u.profileIds.push(pid);
        }).then(renderProfilesList);
      };
      addBtn2.onclick = () => { addBtn2.classList.add('hidden'); addInp2.classList.remove('hidden'); addInp2.focus(); };
      addInp2.addEventListener('blur', commitAdd);
      addInp2.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } if (e.key === 'Escape') { addInp2.value = ''; addInp2.blur(); } });
      addRow2.append(addBtn2, addInp2);
      content.appendChild(addRow2);
      const sepEnd = document.createElement('hr'); sepEnd.className = 'border-border'; content.appendChild(sepEnd);

    // ── User ──
    } else if (activeSection === 'user') {
      const langSel = document.createElement('select'); langSel.className = 'input text-sm w-32';
      [{ value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }].forEach(({ value, label }) => {
        const opt = document.createElement('option'); opt.value = value; opt.textContent = label;
        if (freshUser.language === value) opt.selected = true;
        langSel.appendChild(opt);
      });
      langSel.addEventListener('change', () => {
        const newLang = langSel.value as Lang;
        setLanguage(newLang);
        void ctx.mutate(s => updateUser(s, { language: newLang }));
        closeSettings();
        showSettingsModal(getContext());
      });
      content.appendChild(mkRow(t('settings.language'), null, langSel));
      const sepLang = document.createElement('hr'); sepLang.className = 'border-border'; content.appendChild(sepLang);

    // ── Data ──
    } else if (activeSection === 'data') {
      const dataRow = document.createElement('div'); dataRow.className = 'grid grid-cols-3 gap-2';
      const exportSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
      const importSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
      const exportBtn = document.createElement('button'); exportBtn.className = 'btn-ghost text-xs inline-flex items-center justify-center gap-1.5'; exportBtn.innerHTML = `${exportSvg}${t('settings.export')}`;
      exportBtn.onclick = () => exportBackup(getContext().state);
      const importLabel = document.createElement('label'); importLabel.className = 'btn-ghost text-xs cursor-pointer inline-flex items-center justify-center gap-1.5'; importLabel.innerHTML = `${importSvg}${t('settings.import')}`;
      const importInput = document.createElement('input'); importInput.type = 'file'; importInput.accept = 'application/json'; importInput.className = 'hidden';
      importInput.onchange = async () => {
        const file = importInput.files?.[0]; if (!file) return;
        try {
          const newState = await parseImport(file);
          confirmModal(t('settings.import.title'), t('settings.import.message'), t('settings.import.confirm'), async () => {
            ensureCurrentUser(newState); ensureCurrentProfile(newState);
            closeModal(); closeSettings();
            await ctx.mutate(s => { Object.assign(s, newState); });
            ctx.navigate({ view: 'folder', folderId: null });
          });
        } catch (e) { alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`); }
        importInput.value = '';
      };
      const resetBtn = document.createElement('button'); resetBtn.className = 'btn-danger text-xs'; resetBtn.textContent = t('settings.reset');
      resetBtn.onclick = () => confirmModal(t('settings.reset.title'), t('settings.reset.message'), t('settings.reset.confirm'), async () => {
        const fresh = emptyState(); ensureCurrentUser(fresh); ensureCurrentProfile(fresh);
        closeModal(); closeSettings();
        await ctx.mutate(s => { Object.assign(s, fresh); });
        ctx.navigate({ view: 'folder', folderId: null });
      });
      importLabel.appendChild(importInput);
      dataRow.append(exportBtn, importLabel, resetBtn);
      content.appendChild(dataRow);

      if (isDriveFeatureEnabled()) {
        const driveSep = document.createElement('hr'); driveSep.className = 'border-border'; content.appendChild(driveSep);
        const driveStatusEl = document.createElement('span'); driveStatusEl.className = 'text-xs';
        const driveBtn = document.createElement('button'); driveBtn.className = 'btn-ghost text-xs shrink-0';
        const driveControl = document.createElement('div'); driveControl.className = 'flex items-center gap-2';
        driveControl.append(driveStatusEl, driveBtn);

        const applyDriveState = async (state: AppState) => {
          migrateState(state);
          await mutate(s => Object.assign(s, state));
        };

        const handleConnect = async () => {
          try {
            const result = await connectDrive();
            if (result.action === 'apply') {
              await applyDriveState(result.state);
            } else if (result.action === 'conflict') {
              const body = document.createElement('p');
              body.className = 'text-sm text-muted leading-relaxed';
              body.textContent = t('settings.sync.conflict.message');
              showModal(t('settings.sync.conflict.title'), body, [
                { label: t('settings.sync.conflict.keepLocal'), onClick: closeModal },
                { label: t('settings.sync.conflict.useDrive'),  onClick: async () => { closeModal(); await applyDriveState(result.state); } },
              ], false);
            }
          } catch {}
        };

        const updateDriveUI = (s: DriveStatus) => {
          switch (s) {
            case 'disconnected': driveStatusEl.textContent = ''; driveBtn.textContent = t('settings.sync.connect'); driveBtn.className = 'btn-primary text-xs shrink-0'; driveBtn.disabled = false; driveBtn.onclick = () => { void handleConnect(); }; break;
            case 'connecting':   driveStatusEl.textContent = t('settings.sync.connecting'); driveStatusEl.className = 'text-xs text-muted'; driveBtn.textContent = ''; driveBtn.disabled = true; break;
            case 'connected':    driveStatusEl.textContent = '● ' + t('settings.sync.connected'); driveStatusEl.className = 'text-xs text-green-500'; driveBtn.textContent = t('settings.sync.disconnect'); driveBtn.className = 'btn-ghost text-xs shrink-0'; driveBtn.disabled = false; driveBtn.onclick = () => disconnectDrive(); break;
            case 'syncing':      driveStatusEl.textContent = '○ ' + t('settings.sync.syncing'); driveStatusEl.className = 'text-xs text-muted'; driveBtn.disabled = true; break;
            case 'error':        driveStatusEl.textContent = '✕ ' + t('settings.sync.error'); driveStatusEl.className = 'text-xs text-danger'; driveBtn.textContent = t('settings.sync.reconnect'); driveBtn.className = 'btn-ghost text-xs shrink-0'; driveBtn.disabled = false; driveBtn.onclick = () => { void handleConnect(); }; break;
          }
        };

        updateDriveUI(getDriveStatus());
        driveUnsub = onStatusChange(updateDriveUI);
        content.appendChild(mkRow('Google Drive', null, driveControl));
      }
      const sepData = document.createElement('hr'); sepData.className = 'border-border'; content.appendChild(sepData);

    // ── About ──
    } else if (activeSection === 'about') {
      const aboutBlock = document.createElement('div'); aboutBlock.className = 'space-y-1.5';
      const mkAboutLine = (textKey: string, href?: string) => {
        const p = document.createElement('p'); p.className = 'text-xs text-muted';
        if (href) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.className = 'text-accent hover:underline'; a.textContent = t(textKey); p.appendChild(a); }
        else p.textContent = t(textKey);
        return p;
      };
      aboutBlock.append(mkAboutLine('settings.aboutLine1'), mkAboutLine('settings.aboutLine2'), mkAboutLine('settings.aboutLine3', 'https://github.com/Batpapa/Cadence'));
      content.appendChild(aboutBlock);

      if (!isStandalone()) {
        const div = document.createElement('hr'); div.className = 'border-border'; content.appendChild(div);
        if (isIOS()) {
          const hint = document.createElement('p'); hint.className = 'text-xs text-muted leading-relaxed'; hint.textContent = t('settings.installIOS'); content.appendChild(hint);
        } else if (canInstall()) {
          const installBtn = document.createElement('button'); installBtn.className = 'btn-primary w-full text-sm'; installBtn.textContent = t('settings.install');
          installBtn.onclick = () => { void triggerInstall(); closeSettings(); };
          const installHint = document.createElement('p'); installHint.className = 'text-xs text-dim mt-1'; installHint.textContent = t('settings.installHint');
          content.append(installBtn, installHint);
        }
      }
    }
  };

  renderNav();
  renderContent();
  document.body.appendChild(overlay);
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
  nav.appendChild(mkRow(svgLib,  t('sidebar.allCards'), isActive(ctx.route, 'library'),       () => ctx.navigate({ view: 'library' })));

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
