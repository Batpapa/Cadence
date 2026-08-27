import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import type { AppContext } from '../types';
import { generateId, emptyState } from '../utils';
import { TrashIcon, ResetIcon } from './icons';
import { confirmModal, closeModal, showModal, renderModalBody } from './modal';
import { getZoom, zoomIn, zoomOut, canZoomIn, canZoomOut, modalMaxH, modalMaxW } from '../services/zoomService';
import { getTheme, setTheme, type Theme } from '../services/themeService';
import { updateUser, ensureCurrentUser, ensureCurrentProfile } from '../services/userService';
import { applyExternalData } from '../services/migration';
import { exportBackup, parseImport } from '../services/importExport';
import { t, setLanguage } from '../services/i18nService';
import { isStandalone, isIOS, canInstall, triggerInstall } from '../services/pwaService';
import { isDriveFeatureEnabled, getDriveStatus, onStatusChange, connectDrive, disconnectDrive, clearDriveOwner, syncToCloud, manualSync, isLikelyInAppBrowser, type DriveStatus } from '../services/driveService';
import { applyDriveState, showDriveConflictModal } from './driveConflictModal';
import type { Lang } from '../services/i18nService';
import { appState, getContext } from '../store';
import { CustomSelect } from './customSelect';
import { clearLastUserId } from '../db';

// ── Profiles ──────────────────────────────────────────────────────────────────

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '—';

function ProfileRow({ ctx, pid, name, canDelete }: { ctx: AppContext; pid: string; name: string; canDelete: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const commit = () => {
    const val = draft.trim();
    if (val && val !== name) void ctx.mutate(s => { s.profiles[pid]!.name = val; });
    setEditing(false);
  };

  return (
    <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-bg hover:border-muted transition-colors">
      <div class="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style="background:rgb(var(--color-accent-ch) / 0.18)">
        <span class="text-[10px] font-mono font-bold text-accent">{initialsOf(name)}</span>
      </div>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          class="text-sm bg-transparent border-b border-accent outline-none flex-1 min-w-0"
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setEditing(false); }}
        />
      ) : (
        <span
          class="text-sm flex-1 truncate cursor-text text-primary"
          title={t('settings.profiles.clickToRename')}
          onClick={() => { setDraft(name); setEditing(true); }}
        >
          {name}
        </span>
      )}
      {canDelete && (
        <button
          class="btn-danger px-2 shrink-0"
          title={t('settings.profiles.delete.title')}
          onClick={() => confirmModal(t('settings.profiles.delete.title'), t('settings.profiles.delete.message', { name }), t('common.delete'), () => {
            void ctx.mutate(s => {
              s.profileIds = (s.profileIds ?? []).filter(id => id !== pid);
              if (s.currentProfileId === pid) s.currentProfileId = s.profileIds[0] ?? '';
              for (const key of Object.keys(s.cardWorks)) { if (key.startsWith(`${pid}:`)) delete s.cardWorks[key]; }
              delete s.profiles[pid];
            });
          })}
        >
          <TrashIcon size={12} />
        </button>
      )}
    </div>
  );
}

function AddProfileRow({ ctx }: { ctx: AppContext }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);

  const commit = () => {
    const trimmed = name.trim();
    setName('');
    setAdding(false);
    if (!trimmed) return;
    const pid = generateId();
    void ctx.mutate(s => {
      s.profiles[pid] = { id: pid, name: trimmed };
      if (!s.profileIds) s.profileIds = [];
      s.profileIds.push(pid);
    });
  };

  if (!adding) {
    return (
      <button
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border bg-transparent text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer"
        onClick={() => setAdding(true)}
      >
        <div class="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-border text-sm font-bold">+</div>
        <span class="text-sm flex-1 text-left">{t('settings.profiles.new')}</span>
      </button>
    );
  }

  return (
    <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-accent bg-bg">
      <div class="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-dim bg-border">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </div>
      <input
        ref={inputRef}
        type="text"
        placeholder={t('settings.profiles.nameLabel')}
        class="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-primary placeholder-dim"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setName(''); setAdding(false); }
        }}
      />
    </div>
  );
}

function ProfileModalBody({ ctx }: { ctx: AppContext }) {
  const user = appState.value;
  const canDelete = (user.profileIds?.length ?? 0) > 1;

  return (
    <div class="space-y-1">
      {(user.profileIds ?? []).map(pid => {
        const profile = user.profiles[pid];
        if (!profile) return null;
        return <ProfileRow key={pid} ctx={ctx} pid={pid} name={profile.name} canDelete={canDelete} />;
      })}
      <div class="mt-2">
        <AddProfileRow ctx={ctx} />
      </div>
    </div>
  );
}

export function showProfileModal(ctx: AppContext): void {
  const { el, cleanup } = renderModalBody(<ProfileModalBody ctx={ctx} />);
  showModal(t('settings.profiles.modalTitle'), el, [], true, '28rem', cleanup);
}

// ── Settings ──────────────────────────────────────────────────────────────────

type SectionId = 'study' | 'user' | 'display' | 'about';

const SECTION_ICONS: Record<SectionId, string> = {
  study: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  user: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  display: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  about: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
};

const LOGOUT_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

function Row({ label, hint, children }: { label: string; hint?: string | null; children: ComponentChildren }) {
  return (
    <div class="flex items-center justify-between gap-4 py-2">
      <div>
        <div class="text-sm text-primary">{label}</div>
        {hint && <div class="text-xs text-dim mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Sep() {
  return <hr class="border-border" />;
}

/** Same visual as the toggle previously hand-rolled with inline styles —
 *  intentionally NOT the Tailwind-class `Switch` used elsewhere (studyModal.tsx):
 *  this settings screen predates that convention and restyling it is out of
 *  scope for a Preact-only migration. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style="width:34px; height:18px; display:block; position:relative; cursor:pointer; flex-shrink:0;">
      <div style={`width:34px; height:18px; border-radius:99px; background:${checked ? 'var(--color-accent)' : 'var(--color-border)'}; transition:background 0.15s;`} />
      <div style={`position:absolute; top:2px; left:${checked ? '16px' : '2px'}; width:14px; height:14px; border-radius:50%; background:white; transition:left 0.15s; box-shadow:0 1px 3px rgba(0,0,0,0.3);`} />
      <input
        type="checkbox"
        checked={checked}
        style="position:absolute; opacity:0; inset:0; cursor:pointer;"
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
    </label>
  );
}

// ── Study section ─────────────────────────────────────────────────────────────

function StudySection({ ctx }: { ctx: AppContext }) {
  const user = appState.value;
  const saveField = (patch: Parameters<typeof updateUser>[1]) => ctx.mutate(s => updateUser(s, patch));

  const [threshDraft, setThreshDraft] = useState(String(Math.round(user.availabilityThreshold * 100)));
  useEffect(() => { setThreshDraft(String(Math.round(user.availabilityThreshold * 100))); }, [user.availabilityThreshold]);

  const commitThresh = () => {
    const pct = parseFloat(threshDraft);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) void saveField({ availabilityThreshold: pct / 100 });
    else setThreshDraft(String(Math.round(user.availabilityThreshold * 100)));
  };

  const currentLambda = user.forgettingRate ?? 1;
  const [lambdaDraft, setLambdaDraft] = useState(currentLambda);
  useEffect(() => { setLambdaDraft(currentLambda); }, [currentLambda]);

  const setLambda = (v: number, save = true) => {
    const rounded = Math.round(v * 100) / 100;
    setLambdaDraft(rounded);
    if (save) void ctx.mutate(s => { s.forgettingRate = rounded; });
  };

  return (
    <>
      <Row label={t('settings.availabilityThreshold')} hint={t('settings.availabilityThresholdHint')}>
        <input
          type="number" min="0" max="100" step="1"
          class="input w-16 text-right font-mono text-sm"
          value={threshDraft}
          onInput={(e) => setThreshDraft((e.target as HTMLInputElement).value)}
          onBlur={commitThresh}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </Row>
      <Sep />

      <Row label={t('settings.weightByImportance')} hint={t('settings.weightByImportanceHint')}>
        <Toggle checked={user.weightByImportance ?? true} onChange={(v) => void saveField({ weightByImportance: v })} />
      </Row>
      <Sep />

      <Row label={t('settings.forgettingRate')} hint={t('settings.forgettingRateHint')}>
        <div class="flex items-center gap-2 w-52">
          <span class="text-sm font-mono w-10 text-right tabular-nums shrink-0">×{lambdaDraft.toFixed(2)}</span>
          <input
            type="range" min="0.3" max="3" step="0.05"
            class="flex-1 accent-accent cursor-pointer"
            value={lambdaDraft}
            onInput={(e) => setLambda(parseFloat((e.target as HTMLInputElement).value))}
          />
          <button class="btn-ghost p-0.5 text-dim hover:text-primary shrink-0" title={t('settings.forgettingRate.reset')} onClick={() => setLambda(1)}>
            <ResetIcon size={13} />
          </button>
        </div>
      </Row>
      <Sep />
    </>
  );
}

// ── User section ──────────────────────────────────────────────────────────────

function DriveRow() {
  const [status, setStatus] = useState<DriveStatus>(getDriveStatus);
  // Re-read after subscribing — see header.tsx: a status change between first
  // render and this effect would otherwise never reach the component.
  useEffect(() => { setStatus(getDriveStatus()); return onStatusChange(setStatus); }, []);

  const handleConnect = async () => {
    try {
      const result = await connectDrive();
      if (result.action === 'apply') {
        await applyDriveState(result.state, result.driveTs);
      } else if (result.action === 'conflict') {
        showDriveConflictModal(result.state, result.driveTs);
      } else if (result.action === 'none') {
        syncToCloud(getContext().user);
        void manualSync();
      } else if (result.action === 'wrong_account') {
        const body = document.createElement('p');
        body.className = 'text-sm text-muted leading-relaxed';
        body.textContent = t('settings.sync.wrongAccount.message', { existing: result.existingEmail || '?', new: result.newEmail || '?' });
        showModal(t('settings.sync.wrongAccount.title'), body, [
          { label: t('common.cancel'), onClick: closeModal },
          {
            label: t('settings.sync.wrongAccount.switchAnyway'), danger: true, onClick: async () => {
              closeModal();
              clearDriveOwner();
              await handleConnect();
            },
          },
        ], false);
      }
    } catch {
      // Known cause: the OAuth consent screen renders blank inside chat
      // apps' in-app browsers (WhatsApp, Instagram…) — worth a specific
      // pointer since the status indicator alone ("✕ Error") doesn't
      // explain why. Expected cancellations (popup closed / consent
      // denied) don't reach here as an error worth surfacing further.
      if (isLikelyInAppBrowser()) {
        const body = document.createElement('p');
        body.className = 'text-sm text-muted leading-relaxed';
        body.textContent = t('settings.sync.inAppBrowserError');
        showModal(t('settings.sync.inAppBrowserTitle'), body, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
      }
    }
  };

  const STATUS_UI: Record<DriveStatus, { text: string; cls: string; btnText: string; btnCls: string; btnDisabled: boolean; onClick?: () => void }> = {
    disconnected: { text: '', cls: 'text-xs', btnText: t('settings.sync.connect'), btnCls: 'btn-primary text-xs shrink-0', btnDisabled: false, onClick: () => { void handleConnect(); } },
    connecting:   { text: t('settings.sync.connecting'), cls: 'text-xs text-muted', btnText: '', btnCls: 'btn-ghost text-xs shrink-0', btnDisabled: true },
    connected:    { text: '● ' + t('settings.sync.connected'), cls: 'text-xs text-green-500', btnText: t('settings.sync.disconnect'), btnCls: 'btn-ghost text-xs shrink-0', btnDisabled: false, onClick: () => disconnectDrive() },
    // Original vanilla version's switch had no case at all for 'pending'
    // (a real, reachable status — see driveService.ts) — left whatever was
    // on screen before stale forever. A declarative re-render can't replicate
    // "leave the DOM untouched", so this treats it the same as 'syncing'
    // (closest existing state: a transitional, disabled, no-action moment)
    // rather than inventing new user-facing copy.
    pending:      { text: '○ ' + t('settings.sync.syncing'), cls: 'text-xs text-muted', btnText: '', btnCls: 'btn-ghost text-xs shrink-0', btnDisabled: true },
    syncing:      { text: '○ ' + t('settings.sync.syncing'), cls: 'text-xs text-muted', btnText: '', btnCls: 'btn-ghost text-xs shrink-0', btnDisabled: true },
    error:        { text: '✕ ' + t('settings.sync.error'), cls: 'text-xs text-danger', btnText: t('settings.sync.reconnect'), btnCls: 'btn-ghost text-xs shrink-0', btnDisabled: false, onClick: () => { void handleConnect(); } },
  };
  const ui = STATUS_UI[status];

  return (
    <>
      <Sep />
      <Row label="Google Drive">
        <div class="flex items-center gap-2">
          <span class={ui.cls}>{ui.text}</span>
          <button class={ui.btnCls} disabled={ui.btnDisabled} onClick={ui.onClick}>{ui.btnText}</button>
        </div>
      </Row>
      {/* Proactive: don't wait for a connect attempt that may just hang on
         a blank screen inside an in-app browser (WhatsApp, Instagram…) —
         Cadence links commonly circulate that way. */}
      {status !== 'connected' && isLikelyInAppBrowser() && (
        <p class="text-xs text-warn leading-relaxed -mt-1 mb-1">{t('settings.sync.inAppBrowserWarning')}</p>
      )}
    </>
  );
}

const EXPORT_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const IMPORT_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

function UserSection({ ctx, closeSettings }: { ctx: AppContext; closeSettings: () => void }) {
  const user = appState.value;
  const [nameDraft, setNameDraft] = useState(user.name ?? '');
  useEffect(() => { setNameDraft(user.name ?? ''); }, [user.name]);

  const commitName = () => {
    const val = nameDraft.trim();
    if (val && val !== user.name) void ctx.mutate(s => { s.name = val; });
    else setNameDraft(user.name ?? '');
  };

  const doImportFile = async (file: File) => {
    try {
      const raw = await parseImport(file);
      confirmModal(t('settings.import.title'), t('settings.import.message'), t('settings.import.confirm'), async () => {
        closeModal(); closeSettings();
        await ctx.mutate(s => { Object.assign(s, applyExternalData(raw, s.id)); });
        ctx.navigate({ view: 'folder', folderId: null });
      });
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
      <Row label={t('settings.username')}>
        <input
          type="text"
          class="input text-sm w-36"
          value={nameDraft}
          onInput={(e) => setNameDraft((e.target as HTMLInputElement).value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { setNameDraft(user.name ?? ''); (e.target as HTMLInputElement).blur(); }
          }}
        />
      </Row>

      {isDriveFeatureEnabled() && <DriveRow />}

      <Sep />
      <Row label={t('settings.backup')} hint={t('settings.backupHint')}>
        <div class="flex items-center gap-2 shrink-0">
          <button
            class="btn-ghost text-xs inline-flex items-center justify-center gap-1.5"
            dangerouslySetInnerHTML={{ __html: `${EXPORT_SVG}${t('settings.export')}` }}
            onClick={() => exportBackup(getContext().user)}
          />
          {/* The icon markup goes on an inner span, never on the <label> itself:
              dangerouslySetInnerHTML replaces an element's children, so putting
              it on the label wiped out the file input and the button did
              nothing at all. */}
          <label class="btn-ghost text-xs cursor-pointer inline-flex items-center justify-center gap-1.5">
            <span class="inline-flex items-center gap-1.5" dangerouslySetInnerHTML={{ __html: `${IMPORT_SVG}${t('settings.import')}` }} />
            <input
              type="file"
              accept=".cdb"
              class="hidden"
              onChange={(e) => {
                const input = e.currentTarget;
                const file = input.files?.[0];
                // Clear it, or picking the same file twice in a row fires no
                // change event and the second import silently does nothing.
                input.value = '';
                if (file) void doImportFile(file);
              }}
            />
          </label>
        </div>
      </Row>

      <Sep />
      <Row label={t('settings.reset')} hint={t('settings.resetHint')}>
        <button
          class="btn-danger text-xs shrink-0"
          onClick={() => confirmModal(t('settings.reset.title'), t('settings.reset.message'), t('settings.reset.confirm'), async () => {
            closeModal(); closeSettings();
            await ctx.mutate(s => {
              const fresh = emptyState(); fresh.id = s.id;
              ensureCurrentUser(fresh); ensureCurrentProfile(fresh);
              Object.assign(s, fresh);
            });
            ctx.navigate({ view: 'folder', folderId: null });
          })}
        >
          {t('settings.reset')}
        </button>
      </Row>
      <Sep />
    </>
  );
}

// ── Display section ───────────────────────────────────────────────────────────

function DisplaySection({ ctx, onZoomChange }: { ctx: AppContext; onZoomChange: () => void }) {
  const user = appState.value;
  const [, bump] = useState(0);
  const [theme, setThemeState] = useState<Theme>(getTheme);

  const changeTheme = (th: Theme) => { setTheme(th); setThemeState(th); };
  const THEMES: Array<{ id: Theme; labelKey: string }> = [
    { id: 'dark', labelKey: 'settings.theme.dark' },
    { id: 'light', labelKey: 'settings.theme.light' },
    { id: 'green', labelKey: 'settings.theme.green' },
  ];

  return (
    <>
      <Row label={t('settings.zoom')}>
        <div class="flex items-center gap-1">
          <button class="btn-ghost px-2 py-0.5 text-sm" disabled={!canZoomOut()} onClick={() => { zoomOut(); bump(x => x + 1); onZoomChange(); }}>−</button>
          <span class="text-sm font-mono w-12 text-center tabular-nums">{getZoom()}%</span>
          <button class="btn-ghost px-2 py-0.5 text-sm" disabled={!canZoomIn()} onClick={() => { zoomIn(); bump(x => x + 1); onZoomChange(); }}>+</button>
        </div>
      </Row>
      <Sep />

      <Row label={t('settings.theme')}>
        <div class="flex items-center gap-1">
          {THEMES.map(th => (
            <button
              key={th.id}
              class={`text-xs px-2 py-0.5 rounded transition-colors ${theme === th.id ? 'bg-accent text-white' : 'btn-ghost'}`}
              onClick={() => changeTheme(th.id)}
            >
              {t(th.labelKey)}
            </button>
          ))}
        </div>
      </Row>
      <Sep />

      <Row label={t('settings.language')}>
        <div style="flex:0 0 auto">
          <CustomSelect
            value={user.language ?? 'en'}
            options={[{ value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }]}
            onChange={(newLang) => {
              setLanguage(newLang as Lang);
              void ctx.mutate(s => updateUser(s, { language: newLang as Lang }));
            }}
            triggerClass="flex items-center gap-2 text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent w-32"
          />
        </div>
      </Row>
      <Sep />
    </>
  );
}

// ── About section ─────────────────────────────────────────────────────────────

function AboutLine({ textKey, href }: { textKey: string; href?: string }) {
  return (
    <p class="text-xs text-muted">
      {href ? <a href={href} target="_blank" rel="noopener" class="text-accent hover:underline">{t(textKey)}</a> : t(textKey)}
    </p>
  );
}

function AboutSection({ closeSettings }: { closeSettings: () => void }) {
  return (
    <>
      <div class="space-y-1.5">
        <AboutLine textKey="settings.aboutLine1" />
        <AboutLine textKey="settings.aboutLine2" />
        <AboutLine textKey="settings.aboutLine3" href="https://github.com/Batpapa/Cadence" />
      </div>

      {/* FolkFriend attribution (GPLv3) — required by the vendored recognition engine. */}
      <Sep />
      <div class="space-y-1.5">
        <p class="text-xs text-muted">{t('settings.aboutFolkFriend')}</p>
        <p class="text-xs text-muted">
          <a href="https://github.com/TomWyllie/folkfriend" target="_blank" rel="noopener" class="text-accent hover:underline">github.com/TomWyllie/folkfriend (GPLv3)</a>
        </p>
      </div>

      {!isStandalone() && (
        <>
          <Sep />
          {isIOS() ? (
            <p class="text-xs text-muted leading-relaxed">{t('settings.installIOS')}</p>
          ) : canInstall() ? (
            <>
              <button class="btn-primary w-full text-sm" onClick={() => { void triggerInstall(); closeSettings(); }}>{t('settings.install')}</button>
              <p class="text-xs text-dim mt-1">{t('settings.installHint')}</p>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

function SettingsModal({ ctx, onClose }: { ctx: AppContext; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>('study');
  const [, bumpDialog] = useState(0);
  const mouseDownOnOverlay = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line
  }, []);

  const SECTIONS: Array<{ id: SectionId; labelKey: string }> = [
    { id: 'study', labelKey: 'settings.study' },
    { id: 'user', labelKey: 'settings.user' },
    { id: 'display', labelKey: 'settings.display' },
    { id: 'about', labelKey: 'settings.about' },
  ];

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onClose(); }}
    >
      <div
        class="bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '560px', maxWidth: modalMaxW(0.9), height: '520px', maxHeight: modalMaxH(0.9) }}
      >
        <div class="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <span class="text-sm font-semibold text-primary">{t('settings.title')}</span>
          <button class="text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer" onClick={onClose}>✕</button>
        </div>

        <div class="flex flex-1 overflow-hidden" style="min-height:0">
          <div class="shrink-0 flex flex-col gap-0.5 p-2 bg-surface border-r border-border overflow-y-auto" style="width:148px">
            {SECTIONS.map(sec => (
              <button
                key={sec.id}
                class={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                  sec.id === section ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-elevated hover:text-primary'
                }`}
                onClick={() => setSection(sec.id)}
              >
                <span class="shrink-0 flex items-center" dangerouslySetInnerHTML={{ __html: SECTION_ICONS[sec.id] }} />
                <span class={`text-sm ${sec.id === section ? 'font-medium' : ''}`}>{t(sec.labelKey)}</span>
              </button>
            ))}
            <button
              class="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer mt-auto text-muted hover:bg-elevated hover:text-danger"
              onClick={() => confirmModal(t('settings.logout'), t('settings.logout.message'), t('settings.logout.confirm'), () => {
                closeModal(); onClose();
                manualSync().finally(() => { clearLastUserId(); location.reload(); });
              })}
            >
              <span class="shrink-0 flex items-center" dangerouslySetInnerHTML={{ __html: LOGOUT_ICON }} />
              <span class="text-sm">{t('settings.logout')}</span>
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-4 space-y-1">
            {section === 'study' && <StudySection ctx={ctx} />}
            {section === 'user' && <UserSection ctx={ctx} closeSettings={onClose} />}
            {section === 'display' && <DisplaySection ctx={ctx} onZoomChange={() => bumpDialog(x => x + 1)} />}
            {section === 'about' && <AboutSection closeSettings={onClose} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export function showSettingsModal(ctx: AppContext): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const close = () => { render(null, host); host.remove(); };
  render(<SettingsModal ctx={ctx} onClose={close} />, host);
}
