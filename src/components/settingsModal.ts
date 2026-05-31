import type { AppContext, AppState } from '../types';
import { generateId, emptyState, trashIcon } from '../utils';
import { confirmModal, closeModal, showModal } from './modal';
import { getZoom, zoomIn, zoomOut, canZoomIn, canZoomOut, modalMaxH, modalMaxW } from '../services/zoomService';
import { getTheme, setTheme } from '../services/themeService';
import { getCurrentUser, updateUser, ensureCurrentUser, ensureCurrentProfile } from '../services/userService';
import { exportBackup, parseImport } from '../services/importExport';
import { t, setLanguage } from '../services/i18nService';
import { isStandalone, isIOS, canInstall, triggerInstall } from '../services/pwaService';
import { isDriveFeatureEnabled, getDriveStatus, onStatusChange, connectDrive, disconnectDrive, getConnectedGoogleId, type DriveStatus } from '../services/driveService';
import { upsertWorkspace } from '../services/metaService';
import type { Lang } from '../services/i18nService';
import { getContext, mutate } from '../store';
import { migrateState } from '../services/migration';

export function showProfileModal(ctx: AppContext): void {
  const body = document.createElement('div');
  body.className = 'space-y-1';

  const initialsOf = (name: string) =>
    name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '—';

  const renderList = () => {
    body.innerHTML = '';
    const ps = getContext().state;
    const cu = getCurrentUser(ps);
    const canDelete = (cu.profileIds?.length ?? 0) > 1;

    for (const pid of cu.profileIds ?? []) {
      const profile = ps.profiles[pid]; if (!profile) continue;
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-bg hover:border-muted transition-colors';

      const avatar = document.createElement('div');
      avatar.className = 'w-6 h-6 rounded-md flex items-center justify-center shrink-0';
      avatar.style.background = 'rgb(var(--color-accent-ch) / 0.18)';
      const avatarText = document.createElement('span');
      avatarText.className = 'text-[10px] font-mono font-bold text-accent';
      avatarText.textContent = initialsOf(profile.name);
      avatar.appendChild(avatarText);

      const nameEl = document.createElement('span');
      nameEl.className = 'text-sm flex-1 truncate cursor-text text-primary';
      nameEl.textContent = profile.name; nameEl.title = t('settings.profiles.clickToRename');
      nameEl.onclick = () => {
        const inp = document.createElement('input'); inp.type = 'text'; inp.value = profile.name;
        inp.className = 'text-sm bg-transparent border-b border-accent outline-none flex-1 min-w-0';
        nameEl.replaceWith(inp); inp.focus(); inp.select();
        const commit = () => {
          const val = inp.value.trim();
          if (val && val !== profile.name) ctx.mutate(s => { s.profiles[pid]!.name = val; }).then(renderList);
          else renderList();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } if (e.key === 'Escape') renderList(); });
      };
      row.append(avatar, nameEl);
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
          }).then(renderList);
        });
        row.appendChild(delBtn);
      }
      body.appendChild(row);
    }

    const addRow = document.createElement('div'); addRow.className = 'mt-2';

    const addBtn = document.createElement('button');
    addBtn.className = 'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border bg-transparent text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer';

    const addBtnAvatar = document.createElement('div');
    addBtnAvatar.className = 'w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-border text-sm font-bold';
    addBtnAvatar.textContent = '+';

    const addBtnLabel = document.createElement('span');
    addBtnLabel.className = 'text-sm flex-1 text-left';
    addBtnLabel.textContent = t('settings.profiles.new');

    addBtn.append(addBtnAvatar, addBtnLabel);

    const addEditor = document.createElement('div');
    addEditor.className = 'flex items-center gap-3 px-3 py-2.5 rounded-lg border border-accent bg-bg hidden';

    const addAvatar = document.createElement('div');
    addAvatar.className = 'w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-dim bg-border';
    addAvatar.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

    const addInp = document.createElement('input');
    addInp.type = 'text';
    addInp.placeholder = t('settings.profiles.nameLabel');
    addInp.className = 'flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-primary placeholder-dim';

    addEditor.append(addAvatar, addInp);

    const showButton = () => { addEditor.classList.add('hidden'); addBtn.classList.remove('hidden'); };
    const showEditor = () => { addBtn.classList.add('hidden'); addEditor.classList.remove('hidden'); addInp.value = ''; addInp.focus(); };

    const commitAdd = () => {
      const name = addInp.value.trim();
      addInp.value = '';
      showButton();
      if (!name) return;
      const pid = generateId();
      ctx.mutate(s => {
        s.profiles[pid] = { id: pid, name };
        const u = s.users[s.currentUserId]!;
        if (!u.profileIds) u.profileIds = [];
        u.profileIds.push(pid);
      }).then(renderList);
    };

    addBtn.onclick = showEditor;
    addInp.addEventListener('blur', commitAdd);
    addInp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commitAdd(); }
      if (e.key === 'Escape') { addInp.value = ''; showButton(); }
    });

    addRow.append(addBtn, addEditor);
    body.appendChild(addRow);
  };

  renderList();
  showModal(t('settings.profiles.modalTitle'), body, []);
}

export function showSettingsModal(ctx: AppContext): void {
  type SectionId = 'study' | 'user' | 'data' | 'about';

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden';
  dialog.style.cssText = `width:560px; max-width:${modalMaxW(0.9)}; height:520px; max-height:${modalMaxH(0.9)};`;

  let driveUnsub: (() => void) | null = null;

  const closeSettings = () => {
    if (driveUnsub) { driveUnsub(); driveUnsub = null; }
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeSettings(); });

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0';
  const titleEl = document.createElement('span');
  titleEl.className = 'text-sm font-semibold text-primary'; titleEl.textContent = t('settings.title');
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer';
  closeBtn.textContent = '✕'; closeBtn.onclick = closeSettings;
  header.append(titleEl, closeBtn);

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
    track.style.cssText = `width:34px; height:18px; border-radius:99px; background:${checked ? 'var(--color-accent)' : 'var(--color-border)'}; transition:background 0.15s;`;
    const thumb = document.createElement('div');
    thumb.style.cssText = `position:absolute; top:2px; left:${checked ? '16px' : '2px'}; width:14px; height:14px; border-radius:50%; background:white; transition:left 0.15s; box-shadow:0 1px 3px rgba(0,0,0,0.3);`;
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = checked;
    inp.style.cssText = 'position:absolute; opacity:0; inset:0; cursor:pointer;';
    inp.onchange = () => {
      const v = inp.checked;
      track.style.background = v ? 'var(--color-accent)' : 'var(--color-border)';
      thumb.style.left = v ? '16px' : '2px';
      onChange(v);
    };
    lbl.append(track, thumb, inp); return lbl;
  };

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
      const sepStudy1 = document.createElement('hr'); sepStudy1.className = 'border-border'; content.appendChild(sepStudy1);

      content.appendChild(mkRow(
        t('settings.weightByImportance'), t('settings.weightByImportanceHint'),
        mkToggle(freshUser.weightByImportance ?? true, v => saveField({ weightByImportance: v })),
      ));
      const sepStudy2 = document.createElement('hr'); sepStudy2.className = 'border-border'; content.appendChild(sepStudy2);

    // ── User ──
    } else if (activeSection === 'user') {
      const zoomControl = document.createElement('div');
      zoomControl.className = 'flex items-center gap-1';
      const zoomDec = document.createElement('button'); zoomDec.className = 'btn-ghost px-2 py-0.5 text-sm'; zoomDec.textContent = '−';
      const zoomVal = document.createElement('span'); zoomVal.className = 'text-sm font-mono w-12 text-center tabular-nums';
      const zoomInc = document.createElement('button'); zoomInc.className = 'btn-ghost px-2 py-0.5 text-sm'; zoomInc.textContent = '+';
      const updateZoomUI = () => {
        zoomVal.textContent = `${getZoom()}%`;
        zoomDec.disabled = !canZoomOut();
        zoomInc.disabled = !canZoomIn();
      };
      zoomDec.onclick = () => { zoomOut(); updateZoomUI(); };
      zoomInc.onclick = () => { zoomIn(); updateZoomUI(); };
      updateZoomUI();
      zoomControl.append(zoomDec, zoomVal, zoomInc);
      content.appendChild(mkRow(t('settings.zoom'), null, zoomControl));
      const sepZoom = document.createElement('hr'); sepZoom.className = 'border-border'; content.appendChild(sepZoom);

      const themeControl = document.createElement('div');
      themeControl.className = 'flex items-center gap-1';
      const darkBtn  = document.createElement('button');
      const lightBtn = document.createElement('button');
      const updateThemeBtns = () => {
        const isDark = getTheme() === 'dark';
        darkBtn.className  = `text-xs px-2 py-0.5 rounded transition-colors ${isDark  ? 'bg-accent text-white' : 'btn-ghost'}`;
        lightBtn.className = `text-xs px-2 py-0.5 rounded transition-colors ${!isDark ? 'bg-accent text-white' : 'btn-ghost'}`;
      };
      darkBtn.textContent  = t('settings.theme.dark');
      lightBtn.textContent = t('settings.theme.light');
      darkBtn.onclick  = () => { setTheme('dark');  updateThemeBtns(); };
      lightBtn.onclick = () => { setTheme('light'); updateThemeBtns(); };
      updateThemeBtns();
      themeControl.append(darkBtn, lightBtn);
      content.appendChild(mkRow(t('settings.theme'), null, themeControl));
      const sepTheme = document.createElement('hr'); sepTheme.className = 'border-border'; content.appendChild(sepTheme);

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

            // Stamp ownerGoogleId on the user and update the workspace descriptor.
            const googleId = getConnectedGoogleId();
            if (googleId) {
              await mutate(s => { const u = s.users[s.currentUserId]; if (u) u.ownerGoogleId = googleId; });
              const s = getContext().state;
              upsertWorkspace({ id: s.currentUserId, name: 'Default', ownerGoogleId: googleId });
            }

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
