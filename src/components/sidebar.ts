import type { AppContext, AppState, Route, Folder, Deck } from '../types';
import { generateId, emptyState, helpIcon, addTouchDragSupport } from '../utils';
import { promptModal, confirmModal, showModal, closeModal } from './modal';
import { getCurrentUser, updateUser, ensureCurrentUser } from '../services/userService';
import { findParentFolder } from '../services/deckService';
import { showCommandPalette } from './commandPalette';
import { showHelpModal } from './help';
import { exportBackup, parseImport } from '../services/importExport';
import { t, setLanguage } from '../services/i18nService';
import { isStandalone, isIOS, canInstall, triggerInstall } from '../services/pwaService';
import { isDriveFeatureEnabled, getDriveStatus, onStatusChange, connectDrive, disconnectDrive, manualSync, type DriveStatus } from '../services/driveService';
import type { Lang } from '../services/i18nService';

const expanded = new Set<string>();
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

  const addFolderBtn = mkIconBtn('+F', t('sidebar.addSubfolder'));
  addFolderBtn.onclick = (e) => { e.stopPropagation(); promptModal(t('modal.newSubfolder.title'), t('modal.newFolder.label'), '', n => { ctx.mutate(s => { const id = generateId(); s.folders[id] = { userId: s.currentUserId, id, name: n, folderIds: [], deckIds: [] }; s.folders[folder.id]!.folderIds.push(id); }); }); };

  const addDeckBtn = mkIconBtn('+D', t('sidebar.addDeck'));
  addDeckBtn.onclick = (e) => { e.stopPropagation(); showCreateDeckModal(ctx, folder.id); };

  actions.append(addFolderBtn, addDeckBtn);
  row.append(toggle, name, actions);
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
    }).then(() => ctx.navigate({ view: 'deck', deckId: id }));
  });
}

function showSettingsModal(ctx: AppContext): void {
  const user = getCurrentUser(ctx.state);
  const body = document.createElement('div'); body.className = 'space-y-5';

  // ── Profile ──
  const profileTitle = document.createElement('div'); profileTitle.className = 'section-title'; profileTitle.textContent = t('settings.profile');
  body.appendChild(profileTitle);

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

  const mastInp = mkField(
    t('settings.availabilityThreshold'),
    t('settings.availabilityThresholdHint'),
    inp => { inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '1'; inp.value = String(Math.round(user.availabilityThreshold * 100)); }
  );

  const weightWrap = document.createElement('div'); weightWrap.className = 'space-y-1';
  const weightLbl = document.createElement('label'); weightLbl.className = 'flex items-center gap-2 cursor-pointer';
  const weightChk = document.createElement('input'); weightChk.type = 'checkbox'; weightChk.className = 'card-checkbox'; weightChk.checked = user.weightByImportance ?? true;
  const weightText = document.createElement('span'); weightText.className = 'label mb-0'; weightText.textContent = t('settings.weightByImportance');
  weightLbl.append(weightChk, weightText);
  const weightHint = document.createElement('p'); weightHint.className = 'text-xs text-dim leading-relaxed';
  weightHint.textContent = t('settings.weightByImportanceHint');
  weightWrap.append(weightLbl, weightHint);
  body.appendChild(weightWrap);

  // ── Language ──
  const langWrap = document.createElement('div'); langWrap.className = 'space-y-1';
  const langLbl = document.createElement('label'); langLbl.className = 'label'; langLbl.textContent = t('settings.language');
  const langSel = document.createElement('select'); langSel.className = 'input';
  [{ value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }].forEach(({ value, label }) => {
    const opt = document.createElement('option'); opt.value = value; opt.textContent = label;
    if (user.language === value) opt.selected = true;
    langSel.appendChild(opt);
  });
  langWrap.append(langLbl, langSel);
  body.appendChild(langWrap);

  // ── Divider ──
  const divider = document.createElement('hr'); divider.className = 'border-border';
  body.appendChild(divider);

  // ── Data ──
  const dataTitle = document.createElement('div'); dataTitle.className = 'section-title'; dataTitle.textContent = t('settings.data');
  body.appendChild(dataTitle);

  const dataRow = document.createElement('div'); dataRow.className = 'flex gap-2';

  // Export
  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-ghost text-xs flex-1';
  exportBtn.textContent = t('settings.export');
  exportBtn.onclick = () => exportBackup(ctx.state);
  dataRow.appendChild(exportBtn);

  // Import
  const importLabel = document.createElement('label');
  importLabel.className = 'btn-ghost text-xs flex-1 text-center cursor-pointer';
  importLabel.textContent = t('settings.import');
  const importInput = document.createElement('input');
  importInput.type = 'file'; importInput.accept = 'application/json'; importInput.className = 'hidden';
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const newState = await parseImport(file);
      confirmModal(t('settings.import.title'), t('settings.import.message'), t('settings.import.confirm'), async () => {
        ensureCurrentUser(newState);
        closeModal();
        await ctx.mutate(s => { Object.assign(s, newState); });
        ctx.navigate({ view: 'folder', folderId: null });
      });
    } catch (e) { alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`); }
    importInput.value = '';
  };
  importLabel.appendChild(importInput);
  dataRow.appendChild(importLabel);

  // Reset
  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn-ghost text-xs flex-1 text-danger hover:bg-danger/10 hover:text-danger';
  resetBtn.textContent = t('settings.reset');
  resetBtn.onclick = () => {
    confirmModal(t('settings.reset.title'), t('settings.reset.message'), t('settings.reset.confirm'), async () => {
      const fresh = emptyState();
      ensureCurrentUser(fresh);
      closeModal();
      await ctx.mutate(s => { Object.assign(s, fresh); });
      ctx.navigate({ view: 'folder', folderId: null });
    });
  };
  dataRow.appendChild(resetBtn);

  body.appendChild(dataRow);

  // ── Google Drive Sync ──
  if (isDriveFeatureEnabled()) {
    const dividerSync = document.createElement('hr'); dividerSync.className = 'border-border';
    body.appendChild(dividerSync);
    const syncTitle = document.createElement('div'); syncTitle.className = 'section-title'; syncTitle.textContent = t('settings.sync');
    body.appendChild(syncTitle);

    const driveRow = document.createElement('div'); driveRow.className = 'flex items-center gap-2';
    const driveLabel = document.createElement('span'); driveLabel.className = 'text-xs text-muted flex-1'; driveLabel.textContent = 'Google Drive';
    const driveStatusEl = document.createElement('span'); driveStatusEl.className = 'text-xs';
    const driveBtn = document.createElement('button'); driveBtn.className = 'btn-ghost text-xs shrink-0';

    const updateDriveUI = (s: DriveStatus) => {
      switch (s) {
        case 'disconnected':
          driveStatusEl.textContent = '';
          driveBtn.textContent = t('settings.sync.connect');
          driveBtn.className = 'btn-primary text-xs shrink-0';
          driveBtn.disabled = false;
          driveBtn.onclick = () => { void connectDrive().catch(() => {}); };
          break;
        case 'connecting':
          driveStatusEl.textContent = t('settings.sync.connecting');
          driveStatusEl.className = 'text-xs text-muted';
          driveBtn.textContent = ''; driveBtn.disabled = true;
          break;
        case 'connected':
          driveStatusEl.textContent = '● ' + t('settings.sync.connected');
          driveStatusEl.className = 'text-xs text-green-500';
          driveBtn.textContent = t('settings.sync.disconnect');
          driveBtn.className = 'btn-ghost text-xs shrink-0';
          driveBtn.disabled = false;
          driveBtn.onclick = () => disconnectDrive();
          break;
        case 'syncing':
          driveStatusEl.textContent = '○ ' + t('settings.sync.syncing');
          driveStatusEl.className = 'text-xs text-muted';
          driveBtn.disabled = true;
          break;
        case 'error':
          driveStatusEl.textContent = '✕ ' + t('settings.sync.error');
          driveStatusEl.className = 'text-xs text-danger';
          driveBtn.textContent = t('settings.sync.reconnect');
          driveBtn.className = 'btn-ghost text-xs shrink-0';
          driveBtn.disabled = false;
          driveBtn.onclick = () => { void connectDrive().catch(() => {}); };
          break;
      }
    };

    updateDriveUI(getDriveStatus());
    onStatusChange(updateDriveUI);
    driveRow.append(driveLabel, driveStatusEl, driveBtn);
    body.appendChild(driveRow);
  }

  // ── About ──
  const divider2 = document.createElement('hr'); divider2.className = 'border-border';
  body.appendChild(divider2);

  const aboutTitle = document.createElement('div'); aboutTitle.className = 'section-title'; aboutTitle.textContent = t('settings.about');
  const aboutBlock = document.createElement('div'); aboutBlock.className = 'space-y-1';

  const mkAboutLine = (textKey: string, href?: string) => {
    const p = document.createElement('p'); p.className = 'text-xs text-muted';
    if (href) {
      const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener';
      a.className = 'text-accent hover:underline'; a.textContent = t(textKey);
      p.appendChild(a);
    } else {
      p.textContent = t(textKey);
    }
    return p;
  };

  aboutBlock.append(
    mkAboutLine('settings.aboutLine1'),
    mkAboutLine('settings.aboutLine2'),
    mkAboutLine('settings.aboutLine3', 'https://github.com/Batpapa/Cadence'),
  );
  body.append(aboutTitle, aboutBlock);

  // ── Install ──
  if (!isStandalone()) {
    const divider3 = document.createElement('hr'); divider3.className = 'border-border';
    body.appendChild(divider3);
    const installWrap = document.createElement('div'); installWrap.className = 'space-y-1';
    if (isIOS()) {
      const iosHint = document.createElement('p'); iosHint.className = 'text-xs text-muted leading-relaxed';
      iosHint.textContent = t('settings.installIOS');
      installWrap.appendChild(iosHint);
    } else if (canInstall()) {
      const installBtn = document.createElement('button'); installBtn.className = 'btn-primary w-full text-sm';
      installBtn.textContent = t('settings.install');
      installBtn.onclick = () => { void triggerInstall(); closeModal(); };
      const installHint = document.createElement('p'); installHint.className = 'text-xs text-dim';
      installHint.textContent = t('settings.installHint');
      installWrap.append(installBtn, installHint);
    }
    if (installWrap.childElementCount > 0) body.appendChild(installWrap);
  }

  const saveField = (patch: Partial<Omit<typeof user, 'id'>>) => {
    ctx.mutate(s => updateUser(s, patch));
  };

  mastInp.addEventListener('blur', () => {
    const pct = parseFloat(mastInp.value);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      mastInp.classList.remove('border-danger');
      saveField({ availabilityThreshold: pct / 100 });
    } else {
      mastInp.classList.add('border-danger');
      mastInp.value = String(Math.round(user.availabilityThreshold * 100));
      mastInp.classList.remove('border-danger');
    }
  });
  mastInp.addEventListener('keydown', e => { if (e.key === 'Enter') mastInp.blur(); if (e.key === 'Escape') closeModal(); });

  weightChk.addEventListener('change', () => saveField({ weightByImportance: weightChk.checked }));

  langSel.addEventListener('change', () => {
    const newLang = langSel.value as Lang;
    setLanguage(newLang);
    void ctx.mutate(s => updateUser(s, { language: newLang }));
    closeModal();
    showSettingsModal(ctx);
  });

  showModal(t('settings.title'), body, [
    { label: t('common.close'), onClick: closeModal },
  ]);
}

export function renderSidebar(ctx: AppContext): HTMLElement {
  const { route, state } = ctx;
  if ((route.view === 'deck' || route.view === 'study') && 'deckId' in route) {
    expandAncestors(route.deckId, state);
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
  nav.className = 'px-2 mt-2 space-y-0.5 shrink-0';

  const mkRow = (icon: string, label: string, active: boolean, onClick: () => void) => {
    const row = document.createElement('div');
    row.className = `flex items-center gap-2 px-3 py-1.5 rounded cursor-pointer text-sm transition-colors ${active ? 'bg-elevated text-primary' : 'text-muted hover:text-primary hover:bg-elevated'}`;
    row.innerHTML = `<span class="text-xs">${icon}</span><span>${label}</span>`;
    row.onclick = onClick;
    return row;
  };

  nav.appendChild(mkRow('⌂', t('sidebar.home'), isActive(ctx.route, 'folder', null), () => ctx.navigate({ view: 'folder', folderId: null })));
  nav.appendChild(mkRow('≡', t('sidebar.allCards'), isActive(ctx.route, 'library'), () => ctx.navigate({ view: 'library' })));

  const tree = document.createElement('div');
  tree.className = 'flex-1 overflow-y-auto py-1 px-2 space-y-0.5';
  for (const folderId of state.rootFolderIds) { const folder = state.folders[folderId]; if (folder) tree.appendChild(renderFolderItem(ctx, folder, 0)); }
  for (const deckId of state.rootDeckIds) { const deck = state.decks[deckId]; if (deck) tree.appendChild(renderDeckItem(ctx, deck, 0)); }

  const bottom = document.createElement('div');
  bottom.className = 'border-t border-border shrink-0 space-y-1 p-2';

  const createRow = document.createElement('div'); createRow.className = 'grid grid-cols-2 gap-1';
  const addFolderBtn = document.createElement('button'); addFolderBtn.className = 'btn-ghost text-xs'; addFolderBtn.textContent = t('sidebar.newFolder');
  addFolderBtn.onclick = () => promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => { ctx.mutate(s => { const id = generateId(); s.folders[id] = { userId: s.currentUserId, id, name, folderIds: [], deckIds: [] }; s.rootFolderIds.push(id); }); });
  const addDeckBtn = document.createElement('button'); addDeckBtn.className = 'btn-ghost text-xs'; addDeckBtn.textContent = t('sidebar.newDeck');
  addDeckBtn.onclick = () => showCreateDeckModal(ctx, null);
  createRow.append(addFolderBtn, addDeckBtn);

  bottom.append(createRow);
  aside.append(top, nav, tree, bottom);
  return aside;
}
