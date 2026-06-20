import { useState, useRef } from 'preact/hooks';
import { appState, navigate, mutate, getContext } from '../store';
import { generateId, DAY_NAMES_KEYS, timeAgo, pct, availabilityColor, addTouchDragSupport } from '../utils';
import { TrashIcon } from '../components/icons';
import { promptModal, confirmModal } from '../components/modal';
import { showCreateDeckModal } from '../components/sidebar';
import { findParentFolder } from '../services/deckService';
import { deckAvailability, deckEase } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import type { AppState, CardWork } from '../types';


// ── Pure helpers (unchanged from vanilla) ─────────────────────────────────────

function studyStreak(works: Record<string, CardWork>): number {
  const days = new Set<string>();
  for (const w of Object.values(works))
    for (const e of w.history) days.add(new Date(e.ts).toDateString());
  let streak = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

function sessionsLastNDays(works: Record<string, CardWork>, n: number): number[] {
  const counts = Array<number>(n).fill(0);
  const now = Date.now();
  for (const w of Object.values(works))
    for (const e of w.history) {
      const i = n - 1 - Math.floor((now - e.ts) / 86400000);
      if (i >= 0 && i < n) counts[i]++;
    }
  return counts;
}

function sessionsLastNWeeks(works: Record<string, CardWork>, n: number): number[] {
  const counts = Array<number>(n).fill(0);
  const now = Date.now();
  for (const w of Object.values(works))
    for (const e of w.history) {
      const i = n - 1 - Math.floor((now - e.ts) / (7 * 86400000));
      if (i >= 0 && i < n) counts[i]++;
    }
  return counts;
}

type ActivityPeriod = '7d' | '30d' | '1y';

// ── Activity bars (JSX) ───────────────────────────────────────────────────────

function ActivityBars({ works, period }: { works: Record<string, CardWork>; period: ActivityPeriod }) {
  const data = period === '1y' ? sessionsLastNWeeks(works, 52) : sessionsLastNDays(works, period === '30d' ? 30 : 7);
  const max  = Math.max(...data, 1);
  const minH = period === '1y' ? 2 : 4;

  return (
    <div class="flex gap-0.5 items-end">
      {data.map((count, i) => {
        const h     = Math.max(minH, Math.round((count / max) * 40));
        const title = t(count !== 1 ? 'dashboard.sessions' : 'dashboard.session', { count });
        if (period === '7d') {
          const d = new Date(); d.setDate(d.getDate() - (6 - i));
          return (
            <div key={i} class="flex flex-col items-center gap-1 flex-1">
              <div class={`rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`} style={{ height: `${h}px` }} title={title} />
              <div class="text-[9px] text-dim">{t(DAY_NAMES_KEYS[d.getDay()]!)}</div>
            </div>
          );
        }
        return (
          <div key={i} class="flex flex-col items-center gap-1 flex-1">
            <div class={`rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`} style={{ height: `${h}px` }} title={title} />
          </div>
        );
      })}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ user }: { user: AppState }) {
  const [actPeriod, setActPeriod] = useState<ActivityPeriod>('1y');

  const allCards       = Object.values(user.cards);
  const totalSessions  = Object.values(user.cardWorks).reduce((s, w) => s + w.history.length, 0);
  const weekSessions   = sessionsLastNDays(user.cardWorks, 7).reduce((a, b) => a + b, 0);
  const streak         = studyStreak(user.cardWorks);
  const deckCount      = Object.keys(user.decks).length;

  const PERIOD_LABELS: Record<ActivityPeriod, string> = {
    '7d': t('dashboard.period.7d'), '30d': t('dashboard.period.30d'), '1y': t('dashboard.period.1y'),
  };

  return (
    <div class="space-y-5 pb-2">
      {/* Stats */}
      <div class="grid grid-cols-3 gap-3">
        {[
          { label: t('dashboard.cards'),    value: String(allCards.length),  sub: t(deckCount !== 1 ? 'dashboard.decks' : 'dashboard.deck', { count: deckCount }) },
          { label: t('dashboard.thisWeek'), value: String(weekSessions),     sub: t('dashboard.totalSessions', { count: totalSessions }) },
          { label: t('dashboard.streak'),   value: t('common.durationDays', { n: streak }), sub: streak > 0 ? t('dashboard.streakKeep') : t('dashboard.streakStart') },
        ].map(({ label, value, sub }) => (
          <div key={label} class="card-block space-y-0.5">
            <div class="text-2xl font-mono font-semibold text-primary">{value}</div>
            <div class="text-xs text-muted">{label}</div>
            <div class="text-xs text-dim">{sub}</div>
          </div>
        ))}
      </div>

      {/* Activity chart */}
      <div class="card-block space-y-2">
        <div class="flex items-center justify-between">
          <div class="section-title">{t('dashboard.activity')}</div>
          <div class="flex gap-1">
            {(['7d', '30d', '1y'] as ActivityPeriod[]).map(p => (
              <button
                key={p}
                class={p === actPeriod
                  ? 'text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent cursor-pointer'
                  : 'text-[10px] px-1.5 py-0.5 rounded text-dim hover:text-muted cursor-pointer transition-colors'}
                onClick={() => setActPeriod(p)}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
        <ActivityBars works={user.cardWorks} period={actPeriod} />
      </div>
    </div>
  );
}

// ── Folder delete helper ──────────────────────────────────────────────────────

function deleteFolderRecursive(s: AppState, folderId: string): void {
  const folder = s.folders[folderId]; if (!folder) return;
  for (const subId of folder.folderIds) deleteFolderRecursive(s, subId);
  for (const deckId of folder.deckIds) delete s.decks[deckId];
  delete s.folders[folderId];
  s.rootFolderIds = s.rootFolderIds.filter(id => id !== folderId);
  for (const f of Object.values(s.folders)) f.folderIds = f.folderIds.filter(id => id !== folderId);
}

// ── Main component ────────────────────────────────────────────────────────────

export function FolderView({ folderId }: { folderId: string | null }) {
  const user      = appState.value;
  const folder    = folderId ? user.folders[folderId] : null;
  const profileId = user.currentProfileId;
  const w         = user.weightByImportance ?? true;

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName,      setEditName]      = useState('');

  // ── Folder drag state ───────────────────────────────────────────────────────
  const draggedFolderId  = useRef<string | null>(null);
  const [activeDragFolder,  setActiveDragFolder]  = useState<string | null>(null);
  const [dropFolderTarget,  setDropFolderTarget]  = useState<{ id: string; zone: 'before' | 'after' } | null>(null);

  const onFolderDragStart = (id: string, e: DragEvent) => {
    draggedFolderId.current = id;
    e.dataTransfer?.setData('text/plain', id);
    setTimeout(() => setActiveDragFolder(id), 0);
  };
  const onFolderDragEnd = () => { draggedFolderId.current = null; setActiveDragFolder(null); setDropFolderTarget(null); };
  const onFolderDragOver = (id: string, e: DragEvent) => {
    if (!draggedFolderId.current || draggedFolderId.current === id) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone: 'before' | 'after' = (e.clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after';
    if (dropFolderTarget?.id !== id || dropFolderTarget?.zone !== zone) setDropFolderTarget({ id, zone });
  };
  const onFolderDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropFolderTarget(null);
  };
  const onFolderDrop = (toId: string, e: DragEvent) => {
    const fromId = draggedFolderId.current;
    if (!fromId || fromId === toId) return;
    e.preventDefault();
    const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = (e.clientY - rect.top) / rect.height < 0.5;
    setDropFolderTarget(null);
    draggedFolderId.current = null;
    mutate(s => {
      const ids = folderId ? s.folders[folderId]!.folderIds : s.rootFolderIds;
      const from = ids.indexOf(fromId);
      if (from === -1) return;
      ids.splice(from, 1);
      const to = ids.indexOf(toId);
      if (to === -1) { ids.push(fromId); return; }
      ids.splice(before ? to : to + 1, 0, fromId);
    });
  };

  // ── Deck drag state ─────────────────────────────────────────────────────────
  const draggedDeckId = useRef<string | null>(null);
  const [activeDragDeck, setActiveDragDeck] = useState<string | null>(null);
  const [dropDeckTarget, setDropDeckTarget] = useState<{ id: string; zone: 'before' | 'after' } | null>(null);

  const onDeckDragStart = (id: string, e: DragEvent) => {
    draggedDeckId.current = id;
    e.dataTransfer?.setData('text/plain', id);
    setTimeout(() => setActiveDragDeck(id), 0);
  };
  const onDeckDragEnd = () => { draggedDeckId.current = null; setActiveDragDeck(null); setDropDeckTarget(null); };
  const onDeckDragOver = (id: string, e: DragEvent) => {
    if (!draggedDeckId.current || draggedDeckId.current === id) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone: 'before' | 'after' = (e.clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after';
    if (dropDeckTarget?.id !== id || dropDeckTarget?.zone !== zone) setDropDeckTarget({ id, zone });
  };
  const onDeckDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropDeckTarget(null);
  };
  const onDeckDrop = (toId: string, e: DragEvent) => {
    const fromId = draggedDeckId.current;
    if (!fromId || fromId === toId) return;
    e.preventDefault();
    const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = (e.clientY - rect.top) / rect.height < 0.5;
    setDropDeckTarget(null);
    draggedDeckId.current = null;
    mutate(s => {
      const ids = folderId ? s.folders[folderId]!.deckIds : s.rootDeckIds;
      const from = ids.indexOf(fromId);
      if (from === -1) return;
      ids.splice(from, 1);
      const to = ids.indexOf(toId);
      if (to === -1) { ids.push(fromId); return; }
      ids.splice(before ? to : to + 1, 0, fromId);
    });
  };

  const folderIds = folder ? folder.folderIds : user.rootFolderIds;
  const deckIds   = folder ? folder.deckIds   : user.rootDeckIds;

  return (
    <div class="p-6 space-y-6 view-enter overflow-y-auto h-full">

      {/* ── Header ── */}
      <div class="flex items-center justify-between">
        <div>
          {folder ? (
            isEditingName ? (
              <input
                type="text"
                value={editName}
                autoFocus
                class="text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full"
                onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
                onBlur={() => {
                  const val = editName.trim();
                  if (val && val !== folder.name) mutate(s => { s.folders[folderId!]!.name = val; });
                  setIsEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setIsEditingName(false);
                }}
              />
            ) : (
              <h1
                class="text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors"
                title="Click to rename"
                onClick={() => { setEditName(folder.name); setIsEditingName(true); }}
              >
                {folder.name}
              </h1>
            )
          ) : (
            <h1 class="text-xl font-semibold text-primary">{t('folder.title.home')}</h1>
          )}
        </div>
        {folder && (
          <button
            class="btn-danger px-2"
            title={t('folder.deleteFolder')}
            onClick={() => confirmModal(
              t('folder.delete.title'),
              t('folder.delete.message', { name: folder.name }),
              t('common.delete'),
              () => {
                const parent = findParentFolder(folderId!, 'folder', user);
                void mutate(u => { deleteFolderRecursive(u, folderId!); });
                navigate({ view: 'folder', folderId: parent });
              },
            )}
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {/* ── Dashboard (root only) ── */}
      {!folderId && <Dashboard user={user} />}

      {/* ── Sub-folders ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('folder.section.folders')}</span>
          <button class="btn-ghost text-xs" onClick={() =>
            promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
              mutate(s => {
                const id = generateId();
                s.folders[id] = { id, name, folderIds: [], deckIds: [] };
                if (folderId) s.folders[folderId]!.folderIds.push(id);
                else s.rootFolderIds.push(id);
              });
            })
          }>
            {t('folder.newFolder')}
          </button>
        </div>
        {folderIds.length === 0 ? (
          <p class="text-xs text-dim italic">{t('folder.empty.folders')}</p>
        ) : (
          <div class="space-y-1">
            {folderIds.map(subId => {
              const sub = user.folders[subId]; if (!sub) return null;
              const isDrop = dropFolderTarget?.id === subId;
              return (
                <div
                  key={subId}
                  draggable
                  ref={(el) => { if (el) addTouchDragSupport(el as HTMLElement); }}
                  class={[
                    'flex items-center gap-3 px-3 py-2 rounded hover:bg-elevated transition-colors group cursor-pointer',
                    activeDragFolder === subId ? 'opacity-40' : '',
                    isDrop && dropFolderTarget?.zone === 'before' ? 'drop-before' : '',
                    isDrop && dropFolderTarget?.zone === 'after'  ? 'drop-after'  : '',
                  ].join(' ')}
                  onDragStart={(e) => onFolderDragStart(subId, e as unknown as DragEvent)}
                  onDragEnd={() => onFolderDragEnd()}
                  onDragOver={(e) => onFolderDragOver(subId, e as unknown as DragEvent)}
                  onDragLeave={(e) => onFolderDragLeave(e as unknown as DragEvent)}
                  onDrop={(e) => onFolderDrop(subId, e as unknown as DragEvent)}
                  onClick={() => navigate({ view: 'folder', folderId: subId })}
                >
                  <span class="text-dim opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity">⠿</span>
                  <span class="text-muted shrink-0 flex items-center">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  </span>
                  <span class="text-sm text-primary flex-1 truncate">{sub.name}</span>
                  <span class="text-xs text-dim shrink-0">{t('folder.meta', { folders: sub.folderIds.length, decks: sub.deckIds.length })}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Decks ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('folder.section.decks')}</span>
          <button class="btn-ghost text-xs" onClick={() => showCreateDeckModal(getContext(), folderId)}>
            {t('folder.newDeck')}
          </button>
        </div>
        {deckIds.length === 0 ? (
          <p class="text-xs text-dim italic">{t('folder.empty.decks')}</p>
        ) : (
          <div class="space-y-1">
            {deckIds.map(deckId => {
              const deck = user.decks[deckId]; if (!deck) return null;
              const avail   = deckAvailability(user, profileId, deck, user.cards, user.cardWorks, w);
              const ease    = deckEase(profileId, deck, user.cards, user.cardWorks, w);
              const lastTs  = deck.entries.reduce<number | undefined>((max, e) => {
                const ts = user.cardWorks[`${profileId}:${e.cardId}`]?.history.at(-1)?.ts;
                return ts !== undefined && (max === undefined || ts > max) ? ts : max;
              }, undefined);
              const isDrop = dropDeckTarget?.id === deckId;
              return (
                <div
                  key={deckId}
                  draggable
                  ref={(el) => { if (el) addTouchDragSupport(el as HTMLElement); }}
                  class={[
                    'flex items-center gap-3 px-3 py-2 rounded hover:bg-elevated transition-colors group cursor-pointer',
                    activeDragDeck === deckId ? 'opacity-40' : '',
                    isDrop && dropDeckTarget?.zone === 'before' ? 'drop-before' : '',
                    isDrop && dropDeckTarget?.zone === 'after'  ? 'drop-after'  : '',
                  ].join(' ')}
                  onDragStart={(e) => onDeckDragStart(deckId, e as unknown as DragEvent)}
                  onDragEnd={() => onDeckDragEnd()}
                  onDragOver={(e) => onDeckDragOver(deckId, e as unknown as DragEvent)}
                  onDragLeave={(e) => onDeckDragLeave(e as unknown as DragEvent)}
                  onDrop={(e) => onDeckDrop(deckId, e as unknown as DragEvent)}
                  onClick={() => navigate({ view: 'deck', deckId })}
                >
                  <span class="text-dim opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity">⠿</span>

                  <span class="flex gap-0.5 items-center shrink-0">
                    <span class={`w-2 h-2 rounded-full ${availabilityColor(avail)}`} title={t('card.dot.recall', { pct: pct(avail) })} />
                    <span
                      class={`w-2 h-2 rounded-full ${ease <= 0 ? 'bg-border' : ease >= 0.6 ? 'bg-success' : ease >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                      title={ease > 0 ? t('card.dot.ease', { pct: pct(ease) }) : t('card.neverReviewed')}
                    />
                  </span>

                  <span class="text-sm text-primary flex-1 truncate">{deck.name}</span>
                  <span class="text-xs font-mono text-dim shrink-0">
                    {lastTs ? timeAgo(lastTs) : t('card.neverReviewed')}
                  </span>
                  <span class="text-xs text-dim shrink-0">{t('folder.deckMeta', { count: deck.entries.length })}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
