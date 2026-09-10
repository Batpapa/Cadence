import { signal, computed, type Signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import type { AppContext } from '../types';
import { generateId, emptyState } from '../utils';
import { deleteLocalSessionData } from '../session/db';
import { TrashIcon, ResetIcon, HelpIcon } from './icons';
import { confirmModal, closeModal, closeAllModals, showModal, renderModalBody, alertModal } from './modal';
import { getZoom, zoomIn, zoomOut, canZoomIn, canZoomOut, modalMaxH, modalMaxW } from '../services/zoomService';
import { getTheme, setTheme, type Theme } from '../services/themeService';
import { updateUser, ensureCurrentUser, ensureCurrentProfile } from '../services/userService';
import { applyExternalData } from '../services/migration';
import { exportBackup, exportSnapshotBackup, parseImport } from '../services/importExport';
import { exportFullBackup, fullBackupSize, parseFullBackup, restoreFullBackupAudio, BackupTooLarge, MAX_FULL_BACKUP_BYTES } from '../services/fullBackup';
import { listSnapshots, getSnapshotState, type SnapshotMeta } from '../services/snapshotService';
import { t, setLanguage } from '../services/i18nService';
import { isDriveFeatureEnabled, getDriveStatus, onStatusChange, connectDrive, disconnectDrive, clearDriveOwner, syncToCloud, manualSync, isLikelyInAppBrowser, type DriveStatus } from '../services/driveService';
import { applyDriveState, showDriveConflictModal } from './driveConflictModal';
import type { Lang } from '../services/i18nService';
import { appState, getContext } from '../store';
import { CustomSelect } from './customSelect';
import { clearLastUserId } from '../db';
import { defaultTuneRepeat, MAX_REPEAT } from '../services/abcService';
import { refreshStorageEstimate, storageUsage, storageQuota } from '../services/storageService';
import { formatBytes } from '../utils';
import { registerOverlay } from './overlayStack';

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
          title={t('common.clickToRename')}
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
  showModal(t('settings.profiles.modalTitle'), el, [], { maxWidth: '28rem', onDismiss: cleanup });
}

// ── Settings ──────────────────────────────────────────────────────────────────

type SectionId = 'study' | 'user' | 'storage' | 'display' | 'misc' | 'about';

const SECTION_ICONS: Record<SectionId, string> = {
  study: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  user: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  storage: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  display: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  misc: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`,
  about: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
};

const LOGOUT_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

/** One setting per row: label on the left, control on the right. An explanation
 *  is opt-in — a `?` pinned to the end of the label toggles it open below the
 *  row, instead of every setting carrying a permanent paragraph, which turned
 *  this screen into a wall of small grey text. Only rows that actually pass a
 *  `hint` get the button. */
function Row({ label, hint, stacked, children }: {
  label: string; hint?: string | null; stacked?: boolean; children: ComponentChildren;
}) {
  const [hintOpen, setHintOpen] = useState(false);
  return (
    <div class="py-2">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-sm text-primary">{label}</span>
          {hint && (
            <button
              class={`flex items-center p-0.5 rounded-full transition-colors cursor-pointer shrink-0 ${
                hintOpen ? 'text-accent' : 'text-dim hover:text-primary'
              }`}
              title={t('settings.explain')}
              aria-expanded={hintOpen}
              onClick={() => setHintOpen(o => !o)}
            >
              <HelpIcon size={14} />
            </button>
          )}
        </div>
        {!stacked && <div class="flex items-center gap-2 shrink-0">{children}</div>}
      </div>
      {/* `stacked`: the control is too wide to share the label's line (the
          forgetting-rate slider) — give it the full width underneath instead
          of squeezing it into a fixed-width column. */}
      {stacked && <div class="mt-1.5">{children}</div>}
      {hint && hintOpen && (
        <p class="text-xs text-dim leading-relaxed mt-2 px-3 py-2 rounded-lg border border-border bg-bg">{hint}</p>
      )}
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
          class="input w-12 px-2 py-1 text-right font-mono text-sm"
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

      <Row label={t('settings.forgettingRate')} hint={t('settings.forgettingRateHint')} stacked>
        <div class="flex items-center gap-2 w-full">
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

  const handleConnect = async (allowSharedAccount = false) => {
    try {
      const result = await connectDrive(allowSharedAccount);
      if (result.action === 'apply') {
        await applyDriveState(result.state, result.driveTs, result.version);
      } else if (result.action === 'conflict') {
        showDriveConflictModal(result.state, result.driveTs, result.version, result.driveDeviceId);
      } else if (result.action === 'none') {
        syncToCloud(getContext().user);
        void manualSync();
      } else if (result.action === 'shared_account') {
        // Same Google account already syncs another local user on this device
        // — both would write the same Drive file over each other.
        const body = document.createElement('p');
        body.className = 'text-sm text-muted leading-relaxed';
        body.textContent = t('settings.sync.sharedAccount.message');
        showModal(t('settings.sync.sharedAccount.title'), body, [
          { label: t('common.cancel'), onClick: closeModal },
          {
            label: t('settings.sync.sharedAccount.connectAnyway'), danger: true, onClick: async () => {
              closeModal();
              await handleConnect(true);
            },
          },
        ], { dismissable: false });
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
        ], { dismissable: false });
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

/** Safety-net snapshots (the side set aside by a sync decision), downloadable
 *  as ordinary .cdb backups so restoring one reuses the battle-tested
 *  Backup → Import path. Renders nothing until a snapshot exists. */
function SnapshotsRow({ userId }: { userId: string }) {
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  useEffect(() => { void listSnapshots(userId).then(setSnaps); }, [userId]);
  if (snaps.length === 0) return null;
  return (
    <>
      <Sep />
      <Row label={t('settings.snapshots')} hint={t('settings.snapshotsHint')} stacked>
        <div class="flex flex-col gap-1">
          {snaps.map(s => (
            <div key={s.key} class="flex items-center gap-2 pl-2.5 pr-1 py-1 rounded-lg border border-border bg-bg">
              <span class="text-xs text-muted flex-1 min-w-0 truncate">
                {new Date(s.ts).toLocaleString()} · {t(`settings.snapshots.reason.${s.reason}`)}
              </span>
              <span class="text-[11px] text-dim tabular-nums shrink-0">
                {t('settings.sync.conflict.stats', { cards: s.cards, reviews: s.reviews })}
              </span>
              {/* Explicit download button: the whole line used to BE the button,
                  which gave no clue that clicking it saved a file. */}
              <button
                class="btn-ghost p-1 shrink-0"
                title={t('settings.snapshots.download')}
                onClick={() => {
                  void getSnapshotState(s.key).then(state => { if (state) exportSnapshotBackup(state, s.ts); });
                }}
              >
                <span class="flex items-center" dangerouslySetInnerHTML={{ __html: EXPORT_SVG }} />
              </button>
            </div>
          ))}
        </div>
      </Row>
    </>
  );
}

/** Applies a backup, of either kind.
 *
 *  Module-level rather than a closure inside the section, because the buttons
 *  moved to the Storage section while the logic did not change: keeping it here
 *  makes that a move rather than a rewrite.
 *
 *  Order matters. The state goes in first, then the recordings: the audio is
 *  written under session ids the restored state has to already know about, and
 *  a failure between the two leaves recordings that the next import can still
 *  place, rather than metadata pointing at nothing. */
async function runImport(file: File, full: boolean, setBusy: (b: boolean) => void): Promise<void> {
  setBusy(true);
  try {
    const parsed = full ? await parseFullBackup(file) : { raw: await parseImport(file), audio: null };
    closeAllModals(); closeSettingsModal?.();
    const ctx = getContext();
    await ctx.mutate(s => { Object.assign(s, applyExternalData(parsed.raw, s.id)); });
    if (parsed.audio) await restoreFullBackupAudio(parsed.audio);
    ctx.navigate({ view: 'folder', folderId: null });
  } catch (e) {
    alertModal(t('settings.import.failed.title'), e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(false);
  }
}

async function runReset(): Promise<void> {
  closeAllModals(); closeSettingsModal?.();
  const ctx = getContext();
  const userId = ctx.user.id;
  await ctx.mutate(s => {
    const fresh = emptyState(); fresh.id = s.id;
    ensureCurrentUser(fresh); ensureCurrentProfile(fresh);
    // EMPTIED first, not just overwritten. `Object.assign` only touches the
    // keys `emptyState()` happens to name, so every optional field added since
    // simply survived a "reset that deletes everything" — six of them by
    // 2026-09-06, including the whole `modules` blob and with it every recorded
    // session. Clearing first makes the rule "what emptyState does not name is
    // gone", which stays true for fields nobody has thought of yet.
    for (const key of Object.keys(s)) delete (s as unknown as Record<string, unknown>)[key];
    Object.assign(s, fresh);
  });
  // The recordings themselves live outside the user blob, in a local-only
  // database — see deleteLocalSessionData for why leaving it would resurrect a
  // session rather than merely waste space.
  await deleteLocalSessionData(userId);
  ctx.navigate({ view: 'folder', folderId: null });
}

/** Export, import, reset — as icons, because the row they sit on already names
 *  what they act on and three labelled buttons would not fit beside a figure.
 *  Each keeps its title attribute; none is destructive without a confirmation.
 *
 *  Export asks which of the two formats, rather than guessing: the small one is
 *  what someone wants when moving a library between devices, the full one is
 *  what they want before wiping a phone, and the difference between them can be
 *  three orders of magnitude. */
function BackupButtons({ dataBytes, audioBytes }: { dataBytes: number; audioBytes: number | null }) {
  const [busy, setBusy] = useState(false);

  const chooseExport = () => {
    const choice = signal<ExportKind | null>(null);
    const body = document.createElement('div');
    render(<ExportChoice dataBytes={dataBytes} choice={choice} />, body);
    showModal(t('settings.export'), body, [{
      label: t('common.confirm'),
      primary: true,
      disabled: computed(() => choice.value === null),
      onClick: () => {
        const picked = choice.value;
        if (!picked) return;   // unreachable — the button is disabled until then
        closeModal();
        void runExport(picked === 'full', setBusy);
      },
    }], { maxWidth: '22rem' });
  };

  const doImport = (file: File) => {
    // The extension decides which reader runs, and the confirmation differs:
    // only a .cdb leaves the recordings behind, so only a .cdb has to say so.
    const full = file.name.toLowerCase().endsWith('.cdbf');
    confirmModal(
      t('settings.import.title'),
      t(full ? 'settings.import.messageFull' : 'settings.import.message'),
      t('settings.import.confirm'),
      () => { void runImport(file, full, setBusy); },
    );
  };

  return (
    <>
      <button
        class="btn-ghost text-xs inline-flex items-center justify-center px-2"
        disabled={busy}
        title={t('settings.export')}
        dangerouslySetInnerHTML={{ __html: EXPORT_SVG }}
        onClick={chooseExport}
      />
      <label class={`btn-ghost text-xs inline-flex items-center justify-center px-2 ${busy ? 'opacity-40' : 'cursor-pointer'}`} title={t('settings.import')}>
        {/* The icon markup goes on an inner span, never on the <label> itself:
            dangerouslySetInnerHTML replaces an element's children, so putting it
            on the label wiped out the file input and the button did nothing. */}
        <span class="inline-flex items-center" dangerouslySetInnerHTML={{ __html: IMPORT_SVG }} />
        <input
          type="file"
          accept=".cdb,.cdbf"
          class="hidden"
          disabled={busy}
          onChange={(e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            // Clear it, or picking the same file twice in a row fires no change
            // event and the second import silently does nothing.
            input.value = '';
            if (file) doImport(file);
          }}
        />
      </label>
      <button
        class="btn-ghost text-xs inline-flex items-center justify-center px-2 text-danger"
        disabled={busy || audioBytes === null}
        title={t('settings.reset')}
        onClick={() => confirmModal(
          t('settings.reset.title'),
          t('settings.reset.message', { size: formatBytes(dataBytes + (audioBytes ?? 0)) }),
          t('settings.reset.confirm'),
          () => { void runReset(); },
        )}
      >
        <TrashIcon size={14} />
      </button>
    </>
  );
}

type ExportKind = 'data' | 'full';

/** Shared by both outcomes so the busy state and the failure path are one
 *  thing rather than two that have to agree. */
async function runExport(full: boolean, setBusy: (b: boolean) => void): Promise<void> {
  const user = getContext().user;
  if (!full) { exportBackup(user); return; }
  setBusy(true);
  try {
    await exportFullBackup(user);
  } catch (e) {
    alertModal(t('settings.export.failed.title'), e instanceof BackupTooLarge
      ? t('settings.export.tooBig', { size: formatBytes(e.bytes), max: formatBytes(MAX_FULL_BACKUP_BYTES) })
      : String(e));
  } finally {
    setBusy(false);
  }
}

/** The export choice, as a picked option plus a Confirm — the same shape the
 *  Drive conflict modal uses, and for the same reason: the two outcomes differ
 *  by two orders of magnitude, so neither is a safe default and one tap must
 *  not commit to either. Nothing is preselected on purpose.
 *
 *  The footer button lives outside this tree (showModal declares its actions up
 *  front), which is what `disabled` being a signal is for. */
function ExportChoice({ dataBytes, choice }: { dataBytes: number; choice: Signal<ExportKind | null> }) {
  // Measured, not inherited from the section: its figure walks the audio store
  // and so counts orphans too — blobs no analysis points at any more. Those are
  // not written to the archive, so announcing them here would put a size on the
  // option that the file never reaches.
  const [audioBytes, setAudioBytes] = useState<number | null>(null);
  useEffect(() => { void fullBackupSize(getContext().user).then(r => setAudioBytes(r.audioBytes)); }, []);

  return (
    <div class="space-y-2" role="radiogroup" aria-label={t('settings.export')}>
      <ExportOption
        kind="data"
        choice={choice}
        label={t('settings.export.dataOnly', { size: formatBytes(dataBytes) })}
      />
      <ExportOption
        kind="full"
        choice={choice}
        disabled={audioBytes === null}
        label={audioBytes === null
          ? t('settings.export.measuring')
          : t('settings.export.full', { size: formatBytes(dataBytes + audioBytes) })}
      />
    </div>
  );
}

function ExportOption({ kind, label, choice, disabled }: {
  kind: ExportKind; label: string; choice: Signal<ExportKind | null>; disabled?: boolean;
}) {
  const selected = choice.value === kind;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => { choice.value = kind; }}
      class={'w-full text-left rounded-lg border px-3 py-2.5 transition-colors '
        + (disabled ? 'border-border opacity-50 cursor-default '
          : selected ? 'border-accent bg-accent/10 cursor-pointer ' : 'border-border bg-bg hover:border-accent/60 cursor-pointer ')}
    >
      <div class="flex items-center gap-2">
        {/* Drawn rather than a checkbox glyph so the whole card reads as one
            control; aria-checked above is what actually announces the state. */}
        <span
          class={'w-3.5 h-3.5 rounded-full border shrink-0 flex items-center justify-center '
            + (selected ? 'border-accent' : 'border-border')}
          aria-hidden="true"
        >
          {selected && <span class="w-1.5 h-1.5 rounded-full bg-accent" />}
        </span>
        <span class={'text-sm ' + (selected ? 'text-accent' : 'text-primary')}>{label}</span>
      </div>
    </button>
  );
}

/** Everything this device holds, and the three things that can be done to it.
 *
 *  The buttons sit on the "User" line and nowhere else because that is exactly
 *  their scope: export writes both sub-lines, import replaces both, reset
 *  deletes both. Hanging them off "Data" — which is where they used to live,
 *  under a heading that said "all your data" — was the mislabelling that let a
 *  user believe their recordings were backed up when the .cdb had never carried
 *  a single byte of audio. */
function StorageSection({ userId }: { userId: string }) {
  const [audioBytes, setAudioBytes] = useState<number | null>(null);
  const [total, setTotal] = useState<{ usage: number | null; quota: number | null } | null>(null);

  useEffect(() => {
    // fullBackupSize, not localSessionAudioStats: the latter walks the audio
    // store and so counts orphans — blobs no analysis points at any more,
    // which an import can strand and which nothing but the recovery screen
    // can reach. Counting space the user cannot act on is noise, so the
    // figure here is the one the export writes and the app can play.
    void fullBackupSize(appState.value).then(r => setAudioBytes(r.audioBytes));
    void refreshStorageEstimate().then(() => setTotal({ usage: storageUsage.value, quota: storageQuota.value }));
    // appState.value, not just userId: a fresh object on every mutation, so
    // the figures follow an import, a reset, or a Drive state landing while
    // this section is on screen. Nothing else here mutates, so it is not a
    // recount on every keystroke.
  }, [userId, appState.value]);

  // Structured clone is not JSON, so this is an approximation — stated as one
  // rather than dressed up with a precision it does not have.
  const dataBytes = new Blob([JSON.stringify(appState.value)]).size;
  const unknown = t('storage.unknown');

  return (
    <>
      {/* Not a <Row>: the actions belong beside the name, not out in the
          value column where a figure lives. Same vertical rhythm as Row so
          the two kinds of line still align. */}
      <div class="flex items-center justify-between gap-4 py-2">
        <div class="flex items-center gap-1 min-w-0">
          <span class="text-sm text-primary shrink-0">{t('settings.storage.user')}</span>
          <BackupButtons dataBytes={dataBytes} audioBytes={audioBytes} />
        </div>
        <span class="text-sm text-muted tabular-nums shrink-0">
          {audioBytes === null ? '…' : formatBytes(dataBytes + audioBytes)}
        </span>
      </div>
      <SubRow label={t('settings.storage.data')} value={formatBytes(dataBytes)} />
      <SubRow
        label={t('settings.storage.audio')}
        value={audioBytes === null ? '…' : formatBytes(audioBytes)}
      />

      <Row label={t('settings.storage.device')}>
        <span class="text-sm text-muted tabular-nums">
          {!total || total.usage === null ? unknown
            : total.quota === null ? formatBytes(total.usage)
              : t('settings.storage.totalValue', { used: formatBytes(total.usage), quota: formatBytes(total.quota) })}
        </span>
      </Row>
    </>
  );
}

/** A breakdown line under its total: same grid, quieter, indented. */
function SubRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between gap-4 py-1 pl-4">
      <span class="text-xs text-dim">{label}</span>
      <span class="text-xs text-dim tabular-nums">{value}</span>
    </div>
  );
}

function UserSection({ ctx }: { ctx: AppContext }) {
  const user = appState.value;
  const [nameDraft, setNameDraft] = useState(user.name ?? '');
  useEffect(() => { setNameDraft(user.name ?? ''); }, [user.name]);

  const commitName = () => {
    const val = nameDraft.trim();
    if (val && val !== user.name) void ctx.mutate(s => { s.name = val; });
    else setNameDraft(user.name ?? '');
  };

  return (
    <>
      <Row label={t('settings.username')}>
        <input
          type="text"
          class="input text-sm w-36 px-2 py-1"
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


      <SnapshotsRow userId={user.id} />

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

// ── Misc. section ─────────────────────────────────────────────────────────────
// Where a setting goes that belongs to no other heading. Deliberately not a
// "Music" or "Irish" tab: Cadence is generalist first, and one number does not
// justify a section named after a repertoire — the label says what it is,
// which is the odds and ends.

function MiscSection({ ctx }: { ctx: AppContext }) {
  const user = appState.value;
  const current = defaultTuneRepeat(user);
  const [draft, setDraft] = useState(String(current));
  useEffect(() => { setDraft(String(current)); }, [current]);

  // Committed on blur, and a value outside the range snaps back to what is
  // stored rather than being silently clamped — clamping would accept a typo
  // and quietly mean something else.
  const commit = () => {
    const n = parseInt(draft, 10);
    if (!isNaN(n) && n >= 1 && n <= MAX_REPEAT) void ctx.mutate(s => updateUser(s, { defaultTuneRepeat: n }));
    else setDraft(String(current));
  };

  return (
    <>
      <Row label={t('settings.defaultTuneRepeat')} hint={t('settings.defaultTuneRepeatHint')}>
        <input
          type="number" min="1" max={MAX_REPEAT} step="1"
          class="input w-12 px-2 py-1 text-right font-mono text-sm"
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
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

function AboutSection() {
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

      {/* No install offer here any more — the header carries it (both the
          native prompt and the iOS Share-sheet steps), and buried in About it
          was the reason nobody knew Cadence was installable. */}
    </>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

/** Below this dialog width the section list drops its labels and keeps only the
 *  icons. Measured on the dialog itself rather than the viewport: its width is
 *  `min(660px, 90dvw / zoom)`, so a media query would have to re-derive the
 *  zoom factor to say anything true about the space actually left inside. */
const NAV_LABELS_MIN_W = 420;

function SettingsModal({ ctx, onClose }: { ctx: AppContext; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>('study');
  const [, bumpDialog] = useState(0);
  const mouseDownOnOverlay = useRef(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const [compactNav, setCompactNav] = useState(false);
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCompactNav((entry?.contentRect.width ?? 0) < NAV_LABELS_MIN_W);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line
  }, []);

  const SECTIONS: Array<{ id: SectionId; labelKey: string }> = [
    { id: 'study', labelKey: 'settings.study' },
    { id: 'user', labelKey: 'settings.user' },
    { id: 'storage', labelKey: 'settings.storage' },
    { id: 'display', labelKey: 'settings.display' },
    { id: 'misc', labelKey: 'settings.misc' },
    { id: 'about', labelKey: 'settings.about' },
  ];

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onClose(); }}
    >
      <div
        ref={dialogRef}
        class="bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '660px', maxWidth: modalMaxW(0.9), height: '520px', maxHeight: modalMaxH(0.9) }}
      >
        <div class="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <span class="text-sm font-semibold text-primary truncate">
            {t('settings.title')} — {t(SECTIONS.find(s => s.id === section)!.labelKey)}
          </span>
          <button class="text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer" onClick={onClose}>✕</button>
        </div>

        <div class="flex flex-1 overflow-hidden" style="min-height:0">
          <div
            class="shrink-0 flex flex-col gap-0.5 p-2 bg-surface border-r border-border overflow-y-auto"
            style={{ width: compactNav ? '48px' : '148px' }}
          >
            {SECTIONS.map(sec => (
              <button
                key={sec.id}
                class={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                  compactNav ? 'justify-center' : ''
                } ${
                  sec.id === section ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-elevated hover:text-primary'
                }`}
                title={compactNav ? t(sec.labelKey) : undefined}
                onClick={() => setSection(sec.id)}
              >
                <span class="shrink-0 flex items-center" dangerouslySetInnerHTML={{ __html: SECTION_ICONS[sec.id] }} />
                {!compactNav && <span class={`text-sm ${sec.id === section ? 'font-medium' : ''}`}>{t(sec.labelKey)}</span>}
              </button>
            ))}
            <button
              class={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer mt-auto text-muted hover:bg-elevated hover:text-danger ${
                compactNav ? 'justify-center' : ''
              }`}
              title={compactNav ? t('settings.logout') : undefined}
              onClick={() => confirmModal(t('settings.logout'), t('settings.logout.message'), t('settings.logout.confirm'), () => {
                closeModal(); onClose();
                manualSync().finally(() => { clearLastUserId(); location.reload(); });
              })}
            >
              <span
                class="shrink-0 flex items-center justify-center w-[22px] h-[22px] rounded-md bg-danger/15 text-danger"
                dangerouslySetInnerHTML={{ __html: LOGOUT_ICON }}
              />
              {!compactNav && <span class="text-sm">{t('settings.logout')}</span>}
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-4 space-y-1">
            {section === 'study' && <StudySection ctx={ctx} />}
            {section === 'user' && <UserSection ctx={ctx} />}
            {section === 'storage' && <StorageSection userId={ctx.user.id} />}
            {section === 'display' && <DisplaySection ctx={ctx} onZoomChange={() => bumpDialog(x => x + 1)} />}
            {section === 'misc' && <MiscSection ctx={ctx} />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Set while the settings modal is open. It renders into its own host
 *  rather than the shared stack, so nothing else can dismiss it — and two
 *  actions in it need to: import and reset both navigate elsewhere, and
 *  leaving the settings open over the result reads as nothing having
 *  happened. Module-level because only one can ever be open. */
let closeSettingsModal: (() => void) | null = null;

export function showSettingsModal(ctx: AppContext): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  // Registered like any modal, even though it is not in the shared stack:
  // the back gesture has one question and needs one answer.
  let unregister = () => {};
  const close = () => { unregister(); render(null, host); host.remove(); closeSettingsModal = null; };
  unregister = registerOverlay(close);
  closeSettingsModal = close;
  render(<SettingsModal ctx={ctx} onClose={close} />, host);
}
