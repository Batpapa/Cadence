import type { AppContext } from '../types';
import { generateId, emptyState } from '../utils';
import { iconElement, TrashIcon, ResetIcon } from './icons';
import { confirmModal, closeModal, showModal } from './modal';
import { getZoom, zoomIn, zoomOut, canZoomIn, canZoomOut, modalMaxH, modalMaxW } from '../services/zoomService';
import { getTheme, setTheme } from '../services/themeService';
import { updateUser, ensureCurrentUser, ensureCurrentProfile } from '../services/userService';
import { applyExternalData } from '../services/migration';
import { exportBackup, parseImport } from '../services/importExport';
import { t, setLanguage } from '../services/i18nService';
import { isStandalone, isIOS, canInstall, triggerInstall } from '../services/pwaService';
import { isDriveFeatureEnabled, getDriveStatus, onStatusChange, connectDrive, disconnectDrive, clearDriveOwner, syncToCloud, manualSync, type DriveStatus } from '../services/driveService';
import type { Lang } from '../services/i18nService';
import { getContext, applyFromDrive } from '../store';
import { mkCustomSelect } from './customSelectVanilla';
import { clearLastUserId } from '../db';

export function showProfileModal(ctx: AppContext): void {
  const body = document.createElement('div');
  body.className = 'space-y-1';

  const initialsOf = (name: string) =>
    name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '—';

  const renderList = () => {
    body.innerHTML = '';
    const user = getContext().user;
    const canDelete = (user.profileIds?.length ?? 0) > 1;

    for (const pid of user.profileIds ?? []) {
      const profile = user.profiles[pid]; if (!profile) continue;
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
        delBtn.appendChild(iconElement(TrashIcon, 12));
        delBtn.onclick = () => confirmModal(t('settings.profiles.delete.title'), t('settings.profiles.delete.message', { name: profile.name }), t('common.delete'), () => {
          ctx.mutate(s => {
            s.profileIds = (s.profileIds ?? []).filter(id => id !== pid);
            if (s.currentProfileId === pid) s.currentProfileId = s.profileIds[0] ?? '';
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
        if (!s.profileIds) s.profileIds = [];
        s.profileIds.push(pid);
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
  type SectionId = 'study' | 'user' | 'display' | 'about';

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
  content.className = 'flex-1 overflow-y-auto p-4 space-y-1';

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
      id: 'display',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
      labelKey: 'settings.display',
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

    const logoutNavBtn = document.createElement('button');
    logoutNavBtn.className = 'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer mt-auto text-muted hover:bg-elevated hover:text-danger';
    const logoutIcon = document.createElement('span'); logoutIcon.className = 'shrink-0 flex items-center';
    logoutIcon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
    const logoutLabel = document.createElement('span'); logoutLabel.className = 'text-sm'; logoutLabel.textContent = t('settings.logout');
    logoutNavBtn.append(logoutIcon, logoutLabel);
    logoutNavBtn.onclick = () => confirmModal(t('settings.logout'), t('settings.logout.message'), t('settings.logout.confirm'), () => {
      closeModal(); closeSettings();
      manualSync().finally(() => { clearLastUserId(); location.reload(); });
    });
    navEl.appendChild(logoutNavBtn);
  };

  const mkRow = (label: string, hint: string | null, control: HTMLElement): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-4 py-2';
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
    const freshUser  = getContext().user;
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

      // ── Forgetting rate ──
      const currentLambda = freshUser.forgettingRate ?? 1;

      // Value display + slider
      const lambdaVal = document.createElement('span');
      lambdaVal.className = 'text-sm font-mono w-10 text-right tabular-nums shrink-0';
      lambdaVal.textContent = `×${currentLambda.toFixed(2)}`;

      const lambdaSlider = document.createElement('input');
      lambdaSlider.type = 'range'; lambdaSlider.min = '0.3'; lambdaSlider.max = '3'; lambdaSlider.step = '0.05';
      lambdaSlider.value = String(currentLambda);
      lambdaSlider.className = 'flex-1 accent-accent cursor-pointer';


      const setLambda = (v: number, save = true) => {
        const rounded = Math.round(v * 100) / 100;
        lambdaVal.textContent = `×${rounded.toFixed(2)}`;
        lambdaSlider.value = String(rounded);
        if (save) void ctx.mutate(s => { s.forgettingRate = rounded; });
      };

      lambdaSlider.addEventListener('input', () => setLambda(parseFloat(lambdaSlider.value)));

      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn-ghost p-0.5 text-dim hover:text-primary shrink-0';
      resetBtn.title = t('settings.forgettingRate.reset');
      resetBtn.appendChild(iconElement(ResetIcon, 13));
      resetBtn.onclick = () => { setLambda(1); };

      const lambdaSliderWrap = document.createElement('div');
      lambdaSliderWrap.className = 'flex items-center gap-2 w-52';
      lambdaSliderWrap.append(lambdaVal, lambdaSlider, resetBtn);

      content.appendChild(mkRow(t('settings.forgettingRate'), t('settings.forgettingRateHint'), lambdaSliderWrap));
      const sepStudy3 = document.createElement('hr'); sepStudy3.className = 'border-border'; content.appendChild(sepStudy3);

    // ── User ──
    } else if (activeSection === 'user') {

      // 1. Nom d'utilisateur
      const nameInp = document.createElement('input'); nameInp.type = 'text'; nameInp.className = 'input text-sm w-36';
      nameInp.value = freshUser.name ?? '';
      nameInp.addEventListener('blur', () => {
        const val = nameInp.value.trim();
        if (val && val !== freshUser.name) void ctx.mutate(s => { s.name = val; });
        else nameInp.value = freshUser.name ?? '';
      });
      nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') nameInp.blur(); if (e.key === 'Escape') { nameInp.value = freshUser.name ?? ''; nameInp.blur(); } });
      content.appendChild(mkRow(t('settings.username'), null, nameInp));

      // 2. Google Drive
      if (isDriveFeatureEnabled()) {
        content.appendChild(Object.assign(document.createElement('hr'), { className: 'border-border' }));
        const driveStatusEl2 = document.createElement('span'); driveStatusEl2.className = 'text-xs';
        const driveBtn2 = document.createElement('button'); driveBtn2.className = 'btn-ghost text-xs shrink-0';
        const driveControl2 = document.createElement('div'); driveControl2.className = 'flex items-center gap-2';
        driveControl2.append(driveStatusEl2, driveBtn2);
        const applyDriveState2 = async (raw: unknown) => {
          await applyFromDrive(s => { Object.assign(s, applyExternalData(raw as Record<string, unknown>, s.id)); });
        };
        const handleConnect2 = async () => {
          try {
            const result = await connectDrive();
            if (result.action === 'apply') { await applyDriveState2(result.state); }
            else if (result.action === 'conflict') {
              const body2 = document.createElement('p'); body2.className = 'text-sm text-muted leading-relaxed'; body2.textContent = t('settings.sync.conflict.message');
              showModal(t('settings.sync.conflict.title'), body2, [
                { label: t('settings.sync.conflict.keepLocal'), onClick: closeModal },
                { label: t('settings.sync.conflict.useDrive'), onClick: async () => { closeModal(); await applyDriveState2(result.state); } },
              ], false);
            } else if (result.action === 'none') {
              syncToCloud(getContext().user);
              void manualSync();
            } else if (result.action === 'wrong_account') {
              const body3 = document.createElement('p'); body3.className = 'text-sm text-muted leading-relaxed';
              body3.textContent = t('settings.sync.wrongAccount.message', { existing: result.existingEmail || '?', new: result.newEmail || '?' });
              showModal(t('settings.sync.wrongAccount.title'), body3, [
                { label: t('common.cancel'), onClick: closeModal },
                { label: t('settings.sync.wrongAccount.switchAnyway'), danger: true, onClick: async () => {
                  closeModal();
                  clearDriveOwner();
                  await handleConnect2();
                }},
              ], false);
            }
          } catch {}
        };
        const updateDriveUI2 = (s: DriveStatus) => {
          switch (s) {
            case 'disconnected': driveStatusEl2.textContent = ''; driveBtn2.textContent = t('settings.sync.connect'); driveBtn2.className = 'btn-primary text-xs shrink-0'; driveBtn2.disabled = false; driveBtn2.onclick = () => { void handleConnect2(); }; break;
            case 'connecting':   driveStatusEl2.textContent = t('settings.sync.connecting'); driveStatusEl2.className = 'text-xs text-muted'; driveBtn2.textContent = ''; driveBtn2.disabled = true; break;
            case 'connected':    driveStatusEl2.textContent = '● ' + t('settings.sync.connected'); driveStatusEl2.className = 'text-xs text-green-500'; driveBtn2.textContent = t('settings.sync.disconnect'); driveBtn2.className = 'btn-ghost text-xs shrink-0'; driveBtn2.disabled = false; driveBtn2.onclick = () => disconnectDrive(); break;
            case 'syncing':      driveStatusEl2.textContent = '○ ' + t('settings.sync.syncing'); driveStatusEl2.className = 'text-xs text-muted'; driveBtn2.disabled = true; break;
            case 'error':        driveStatusEl2.textContent = '✕ ' + t('settings.sync.error'); driveStatusEl2.className = 'text-xs text-danger'; driveBtn2.textContent = t('settings.sync.reconnect'); driveBtn2.className = 'btn-ghost text-xs shrink-0'; driveBtn2.disabled = false; driveBtn2.onclick = () => { void handleConnect2(); }; break;
          }
        };
        updateDriveUI2(getDriveStatus());
        driveUnsub = onStatusChange(updateDriveUI2);
        content.appendChild(mkRow('Google Drive', null, driveControl2));
      }

      // 3. Sauvegarde — Exporter + Importer côte à côte
      content.appendChild(Object.assign(document.createElement('hr'), { className: 'border-border' }));
      const exportSvg2 = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
      const importSvg2 = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
      const backupControl = document.createElement('div'); backupControl.className = 'flex items-center gap-2 shrink-0';
      const exportBtn2 = document.createElement('button'); exportBtn2.className = 'btn-ghost text-xs inline-flex items-center justify-center gap-1.5'; exportBtn2.innerHTML = `${exportSvg2}${t('settings.export')}`;
      exportBtn2.onclick = () => exportBackup(getContext().user);
      const importLabel2 = document.createElement('label'); importLabel2.className = 'btn-ghost text-xs cursor-pointer inline-flex items-center justify-center gap-1.5'; importLabel2.innerHTML = `${importSvg2}${t('settings.import')}`;
      const importInput2 = document.createElement('input'); importInput2.type = 'file'; importInput2.accept = '.cdb'; importInput2.className = 'hidden';
      importInput2.onchange = async () => {
        const file = importInput2.files?.[0]; if (!file) return;
        try {
          const raw = await parseImport(file);
          confirmModal(t('settings.import.title'), t('settings.import.message'), t('settings.import.confirm'), async () => {
            closeModal(); closeSettings();
            await ctx.mutate(s => { Object.assign(s, applyExternalData(raw, s.id)); });
            ctx.navigate({ view: 'folder', folderId: null });
          });
        } catch (e) { alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`); }
        importInput2.value = '';
      };
      importLabel2.appendChild(importInput2);
      backupControl.append(exportBtn2, importLabel2);
      content.appendChild(mkRow(t('settings.backup'), t('settings.backupHint'), backupControl));

      // 4. Réinitialiser
      content.appendChild(Object.assign(document.createElement('hr'), { className: 'border-border' }));
      const resetBtn2 = document.createElement('button'); resetBtn2.className = 'btn-danger text-xs shrink-0'; resetBtn2.textContent = t('settings.reset');
      resetBtn2.onclick = () => confirmModal(t('settings.reset.title'), t('settings.reset.message'), t('settings.reset.confirm'), async () => {
        closeModal(); closeSettings();
        await ctx.mutate(s => {
          const fresh = emptyState(); fresh.id = s.id;
          ensureCurrentUser(fresh); ensureCurrentProfile(fresh);
          Object.assign(s, fresh);
        });
        ctx.navigate({ view: 'folder', folderId: null });
      });
      content.appendChild(mkRow(t('settings.reset'), t('settings.resetHint'), resetBtn2));
      content.appendChild(Object.assign(document.createElement('hr'), { className: 'border-border' }));

    // ── Display ──
    } else if (activeSection === 'display') {
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
      const updateDialogSize = () => { dialog.style.maxWidth = modalMaxW(0.9); dialog.style.maxHeight = modalMaxH(0.9); };
      zoomDec.onclick = () => { zoomOut(); updateZoomUI(); updateDialogSize(); };
      zoomInc.onclick = () => { zoomIn(); updateZoomUI(); updateDialogSize(); };
      updateZoomUI();
      zoomControl.append(zoomDec, zoomVal, zoomInc);
      content.appendChild(mkRow(t('settings.zoom'), null, zoomControl));
      const sepZoom = document.createElement('hr'); sepZoom.className = 'border-border'; content.appendChild(sepZoom);

      const themeControl = document.createElement('div');
      themeControl.className = 'flex items-center gap-1';
      const darkBtn  = document.createElement('button');
      const lightBtn = document.createElement('button');
      const greenBtn = document.createElement('button');
      const updateThemeBtns = () => {
        const cur = getTheme();
        darkBtn.className  = `text-xs px-2 py-0.5 rounded transition-colors ${cur === 'dark'  ? 'bg-accent text-white' : 'btn-ghost'}`;
        lightBtn.className = `text-xs px-2 py-0.5 rounded transition-colors ${cur === 'light' ? 'bg-accent text-white' : 'btn-ghost'}`;
        greenBtn.className = `text-xs px-2 py-0.5 rounded transition-colors ${cur === 'green' ? 'bg-accent text-white' : 'btn-ghost'}`;
      };
      darkBtn.textContent  = t('settings.theme.dark');
      lightBtn.textContent = t('settings.theme.light');
      greenBtn.textContent = t('settings.theme.green');
      darkBtn.onclick  = () => { setTheme('dark');  updateThemeBtns(); };
      lightBtn.onclick = () => { setTheme('light'); updateThemeBtns(); };
      greenBtn.onclick = () => { setTheme('green'); updateThemeBtns(); };
      updateThemeBtns();
      themeControl.append(darkBtn, lightBtn, greenBtn);
      content.appendChild(mkRow(t('settings.theme'), null, themeControl));
      const sepTheme = document.createElement('hr'); sepTheme.className = 'border-border'; content.appendChild(sepTheme);

      const { el: langSel } = mkCustomSelect(
        [{ value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }],
        freshUser.language ?? 'en',
        (newLang) => {
          setLanguage(newLang as Lang);
          void ctx.mutate(s => updateUser(s, { language: newLang as Lang }));
          renderNav();
          renderContent();
        },
        'flex items-center gap-2 text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent w-32',
      );
      langSel.style.flex = '0 0 auto';
      content.appendChild(mkRow(t('settings.language'), null, langSel));
      const sepLang = document.createElement('hr'); sepLang.className = 'border-border'; content.appendChild(sepLang);

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

      // FolkFriend attribution (GPLv3) — required by the vendored recognition engine.
      const sepFf = document.createElement('hr'); sepFf.className = 'border-border'; content.appendChild(sepFf);
      const ffBlock = document.createElement('div'); ffBlock.className = 'space-y-1.5';
      const ffLine = document.createElement('p'); ffLine.className = 'text-xs text-muted';
      ffLine.textContent = t('settings.aboutFolkFriend');
      const ffLink = document.createElement('p'); ffLink.className = 'text-xs text-muted';
      const ffA = document.createElement('a');
      ffA.href = 'https://github.com/TomWyllie/folkfriend'; ffA.target = '_blank'; ffA.rel = 'noopener';
      ffA.className = 'text-accent hover:underline';
      ffA.textContent = 'github.com/TomWyllie/folkfriend (GPLv3)';
      ffLink.appendChild(ffA);
      ffBlock.append(ffLine, ffLink);
      content.appendChild(ffBlock);

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
