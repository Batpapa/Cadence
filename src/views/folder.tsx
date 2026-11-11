import { useState, useRef } from 'preact/hooks';
import { appState, navigate, mutate, getContext, leaveDeletedPage } from '../store';
import { generateId, DAY_NAMES_KEYS, timeAgo, pct, availabilityColor, addTouchDragSupport } from '../utils';
import { TrashIcon, StarIcon, LibraryIcon, WandIcon, FolderIcon, ChevronDownIcon, PlusIcon } from '../components/icons';
import { IconButton, EmptyState } from '../components/ui';
import { promptModal, confirmModal, confirmModalWithOption } from '../components/modal';
import { showCreateDeckModal } from '../components/sidebar';
import { StudyButton, ShrinkLabel, ShrinkIcon, useHiddenHeaderLabels } from '../components/studyModal';
import { CustomSelect } from '../components/customSelect';
import { createLongPressHandlers } from '../components/longPress';
import { findParentFolder, orphanedCardsAfterDeckRemoval, folderPath, isFolderDescendant, moveFolderToParent } from '../services/deckService';
import { removeCards } from '../services/cardService';
import { deckAvailability, deckEase, isAvailable } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import type { AppState, CardWork, DeckEntry } from '../types';
import { fmtDayMonth } from '../services/dateFormat';


// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Every review the CURRENT profile has recorded ON A CARD THAT STILL EXISTS,
 *  as bare timestamps.
 *
 *  One reading of "whose reviews count", because there used to be four and they
 *  disagreed: the dashboard's total, week, streak and bars each walked
 *  `Object.values(cardWorks)` whole, while the library reads
 *  `${currentProfileId}:${cardId}`. On a shared device — the very reason
 *  profiles exist — every dashboard figure counted everyone's work. Filtering
 *  in one place is what stops that coming back one reader at a time.
 *
 *  The card check is the second half of the same idea. `removeCards` used to
 *  clear only the deleting profile's row, so another profile's work on a
 *  deleted card stayed behind, reachable from nowhere: one real library showed
 *  a profile with 52 reviews on this dashboard and no reviewed card anywhere
 *  else. That leak is fixed at the source, but the rows it already wrote live
 *  on in people's data, and counting them would have this screen claim work
 *  that no other screen can show. Cheap, too — a lookup per row.
 *
 *  Timestamps rather than entries: nothing on this screen looks at a rating,
 *  and a flat array is what the readers below actually want. */
function profileReviewTimes(works: Record<string, CardWork>, profileId: string, cards: AppState['cards']): number[] {
  const out: number[] = [];
  for (const w of Object.values(works)) {
    if (w.profileId !== profileId || !cards[w.cardId]) continue;
    for (const e of w.history) out.push(e.ts);
  }
  return out;
}

/** How many CALENDAR days before today `ts` falls, where the user is: 0 for
 *  anything since midnight. The bars used to count back in slices of 24 h from
 *  now, while their labels and the library they open speak in days from
 *  midnight to midnight — at 2 a.m. the "today" bar held all of yesterday
 *  evening: 44 reviews on the bar, 2 cards in the list (2026-10-23).
 *  Rounded, not floored: across a DST change the gap between two midnights is
 *  23 or 25 hours. */
function calendarDaysAgo(ts: number, todayStart: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return Math.round((todayStart - d.getTime()) / 86400000);
}

function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function reviewsLastNDays(times: number[], n: number): number[] {
  const counts = Array<number>(n).fill(0);
  const today = todayStart();
  for (const ts of times) {
    const i = n - 1 - calendarDaysAgo(ts, today);
    if (i >= 0 && i < n) counts[i]++;
  }
  return counts;
}

/** Weeks of seven calendar days ending today — the same spans `barDateRange`
 *  prints and hands to the library. */
function reviewsLastNWeeks(times: number[], n: number): number[] {
  const counts = Array<number>(n).fill(0);
  const today = todayStart();
  for (const ts of times) {
    const i = n - 1 - Math.floor(calendarDaysAgo(ts, today) / 7);
    if (i >= 0 && i < n) counts[i]++;
  }
  return counts;
}

type ActivityPeriod = '7d' | '30d' | '1y';

// ── Activity bars (JSX) ───────────────────────────────────────────────────────

/** A Date → the YYYY-MM-DD of the day it falls on WHERE THE USER IS.
 *  `toISOString()` would answer in UTC and hand back the day before for
 *  anyone west of Greenwich — a bar labelled "3 sept" filtering on the 2nd. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function barDateRange(period: ActivityPeriod, i: number, total: number): { start: Date; end: Date } {
  const now = new Date();
  if (period === '1y') {
    const weeksAgo = total - 1 - i;
    const end = new Date(now); end.setDate(end.getDate() - weeksAgo * 7);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    return { start, end };
  }
  const daysAgo = total - 1 - i;
  const day = new Date(now); day.setDate(day.getDate() - daysAgo);
  return { start: day, end: day };
}

function ActivityBars({ times, period }: { times: number[]; period: ActivityPeriod }) {
  const [range, setRange] = useState<{ anchor: number; end: number } | null>(null);
  const data  = period === '1y' ? reviewsLastNWeeks(times, 52) : reviewsLastNDays(times, period === '30d' ? 30 : 7);
  const max   = Math.max(...data, 1);
  const minH  = period === '1y' ? 2 : 4;
  const total = data.length;

  const fmtDate = (d: Date) => fmtDayMonth(d);

  const lo = range ? Math.min(range.anchor, range.end) : -1;
  const hi = range ? Math.max(range.anchor, range.end) : -1;

  // Shared long-press state (one bar touched at a time) — created once here,
  // not per-bar, since createLongPressHandlers is a plain function and not a
  // hook, precisely so it can be called inside the .map() below.
  const lpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpStartRef = useRef<{ x: number; y: number } | null>(null);
  const lpFiredRef = useRef(false);

  const handleClick = (i: number, shift: boolean) => {
    if (shift && range !== null) {
      setRange({ anchor: range.anchor, end: i });
    } else if (range !== null && range.anchor === range.end && range.anchor === i) {
      setRange(null);
    } else {
      setRange({ anchor: i, end: i });
    }
  };

  /** Everything a bar needs to be selectable, by mouse or by thumb.
   *
   *  Long-press is Shift+click on a phone — the same equivalence the card
   *  library already makes for its multi-select, and the reason the gesture
   *  lives in a shared primitive rather than in either screen. Holding a bar
   *  extends the range from the anchor; a plain tap still starts a new one,
   *  and the gesture never leaves a stray tap behind (`onTouchEnd` cancels
   *  the synthetic click once it has fired, which would otherwise collapse
   *  the range the hold just made). */
  const barProps = (i: number) => ({
    class: 'flex flex-col items-center gap-1 flex-1 cursor-pointer',
    onClick: (e: MouseEvent) => handleClick(i, e.shiftKey),
    ...createLongPressHandlers(
      { timer: lpTimerRef, start: lpStartRef, fired: lpFiredRef },
      () => handleClick(i, true),
    ),
  });

  const selection = (() => {
    if (range === null) return null;
    const count = data.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
    const { start } = barDateRange(period, lo, total);
    const { end }   = barDateRange(period, hi, total);
    const isSingleDay = period !== '1y' && lo === hi;
    const dateStr = isSingleDay ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(end)}`;
    const revStr = t(count !== 1 ? 'dashboard.reviews' : 'dashboard.review', { count });
    return { label: `${dateStr} · ${revStr}`, start, end };
  })();

  return (
    <div class="space-y-2">
      <div class="flex gap-0.5 items-end">
        {data.map((count, i) => {
          const h          = Math.max(minH, Math.round((count / max) * 40));
          const isSelected = range !== null && i >= lo && i <= hi;
          const barColor   = isSelected ? 'bg-success' : count === 0 ? 'bg-border' : 'bg-accent';
          const title      = t(count !== 1 ? 'dashboard.reviews' : 'dashboard.review', { count });
          if (period === '7d') {
            const d = new Date(); d.setDate(d.getDate() - (6 - i));
            return (
              <div key={i} {...barProps(i)}>
                <div class={`rounded-sm w-full transition-colors ${barColor}`} style={{ height: `${h}px` }} title={title} />
                <div class="text-2xs text-dim">{t(DAY_NAMES_KEYS[d.getDay()]!)}</div>
              </div>
            );
          }
          return (
            <div key={i} {...barProps(i)}>
              <div class={`rounded-sm w-full transition-colors ${barColor}`} style={{ height: `${h}px` }} title={title} />
            </div>
          );
        })}
      </div>
      {selection !== null && (
        <div class="flex items-center justify-center gap-2">
          <span class="text-xs text-success">{selection.label}</span>
          <IconButton
            variant="outline"
            label={t('deck.viewInLibrary')}
            data-tour="activity-library"
            onClick={() => navigate({ view: 'library', reviewedFrom: localDay(selection.start), reviewedTo: localDay(selection.end) })}
          >
            <LibraryIcon size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

/** What is due now, for the current profile: the reviewed cards whose recall
 *  has fallen under the mastery threshold — the very cards a study with
 *  « exclude mastered » proposes, less those never reviewed, counted apart:
 *  on a first day every card is one, and calling them all « to review » would
 *  only say the library is new. */
function dueNow(user: AppState): { due: number; fresh: number } {
  let due = 0, fresh = 0;
  for (const cardId of Object.keys(user.cards)) {
    const work = user.cardWorks[`${user.currentProfileId}:${cardId}`];
    if (!work || work.history.length === 0) fresh++;
    else if (!isAvailable(user, work)) due++;
  }
  return { due, fresh };
}

function Dashboard({ user }: { user: AppState }) {
  const [actPeriod, setActPeriod] = useState<ActivityPeriod>('1y');

  const cardIds        = Object.keys(user.cards);
  // Read once, for the two figures below and the bars: they are views of one
  // set of reviews and must never be able to disagree about which set.
  const reviewTimes    = profileReviewTimes(user.cardWorks, user.currentProfileId, user.cards);
  const totalReviews   = reviewTimes.length;
  const weekReviews    = reviewsLastNDays(reviewTimes, 7).reduce((a, b) => a + b, 0);

  // The home answers « what is there to review? » first (2026-11-11). It
  // opened on three counters — cards, reviews this week, and a streak with
  // its « keep it up! », which is the app telling the user what to do: no
  // streak here any more, nothing to keep up.
  // The count alone: no list of the decks that hold due cards (tried, then
  // dropped the same day — the author: a library can have fifty decks, the
  // list took the whole screen and told little). The sidebar's dots say it.
  const { due, fresh } = dueNow(user);
  // « of N cards » belongs to a count: after « Nothing due right now » it
  // would read as part of the sentence.
  const freshPart = fresh > 0 ? t(fresh !== 1 ? 'dashboard.neverReviewedPlural' : 'dashboard.neverReviewed', { count: fresh }) : null;
  const dueSub = cardIds.length === 0 ? t('library.empty')
    : due === 0 ? (freshPart ? `· ${freshPart}` : '')
    : [t(cardIds.length !== 1 ? 'dashboard.ofCardsPlural' : 'dashboard.ofCards', { count: cardIds.length }), ...(freshPart ? [freshPart] : [])].join(' · ');

  const PERIOD_LABELS: Record<ActivityPeriod, string> = {
    '7d': t('dashboard.periodLong.7d'), '30d': t('dashboard.periodLong.30d'), '1y': t('dashboard.periodLong.1y'),
  };

  return (
    <div class="space-y-5 pb-2">
      {/* What is due */}
      <div class="card-block" data-tour="dashboard">
        <div class="section-title">{t('dashboard.toReview')}</div>
        {/* Words rather than a lone 0: on a first day, every card never
            reviewed, a big zero read as « nothing to do » next to a
            Study all that has nine cards to show. */}
        <div class="flex items-baseline flex-wrap gap-x-2 mt-1">
          {due > 0
            ? <span class="text-2xl font-mono font-semibold text-primary">{due}</span>
            : <span class="text-sm font-medium text-primary">{t('dashboard.nothingDue')}</span>}
          <span class="text-xs text-dim">{dueSub}</span>
        </div>
      </div>

      {/* Activity chart */}
      <div class="card-block space-y-2" data-tour="activity">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="section-title">{t('dashboard.activity')}</div>
            <div class="text-xs text-dim mt-0.5">{t('dashboard.activitySummary', { week: weekReviews, total: totalReviews })}</div>
          </div>
          {/* A quiet select, not a segmented bar (the author, 2026-11-11):
              three buttons took more room and weight than a scale setting
              deserves — the same discretion as the library's sort. */}
          <CustomSelect
            value={actPeriod}
            options={(['7d', '30d', '1y'] as ActivityPeriod[]).map(p => ({ value: p, label: PERIOD_LABELS[p] }))}
            onChange={v => setActPeriod(v as ActivityPeriod)}
            align="right"
            renderTrigger={(label, open, toggle) => (
              <button
                type="button"
                class="btn-ghost text-xs min-h-8 px-2 inline-flex items-center gap-1 shrink-0 whitespace-nowrap"
                aria-expanded={open}
                onClick={toggle}
              >
                {label}
                <span class={`shrink-0 flex transition-transform ${open ? 'rotate-180' : ''}`}><ChevronDownIcon size={12} /></span>
              </button>
            )}
          />
        </div>
        <ActivityBars key={actPeriod} times={reviewTimes} period={actPeriod} />
      </div>
    </div>
  );
}

// ── Study pool helper ─────────────────────────────────────────────────────────

function collectFolderEntries(user: AppState, folderId: string | null): DeckEntry[] {
  const folder    = folderId ? user.folders[folderId] : null;
  const deckIds   = folder ? folder.deckIds   : user.rootDeckIds;
  const folderIds = folder ? folder.folderIds : user.rootFolderIds;
  const seen = new Set<string>();
  const result: DeckEntry[] = [];
  for (const dId of deckIds) {
    for (const e of user.decks[dId]?.entries ?? []) {
      if (!seen.has(e.cardId)) { seen.add(e.cardId); result.push({ cardId: e.cardId }); }
    }
  }
  for (const fId of folderIds) {
    for (const e of collectFolderEntries(user, fId)) {
      if (!seen.has(e.cardId)) { seen.add(e.cardId); result.push(e); }
    }
  }
  return result;
}

// ── Folder delete helper ──────────────────────────────────────────────────────

function collectFolderDeckIds(user: AppState, folderId: string): string[] {
  const folder = user.folders[folderId]; if (!folder) return [];
  const result = [...folder.deckIds];
  for (const subId of folder.folderIds) result.push(...collectFolderDeckIds(user, subId));
  return result;
}

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
  // The header's labels, while the name fits beside them: on the home, Smart
  // edit's goes first, then Study all's (the author, 2026-11-11).
  const headerRef    = useRef<HTMLDivElement>(null);
  const hiddenLabels = useHiddenHeaderLabels(headerRef, [folderId, folder?.name, isEditingName]);
  const studyLabelAt = folderId ? 0 : 1;

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

  const folderIds      = folder ? folder.folderIds : user.rootFolderIds;
  const deckIds        = folder ? folder.deckIds   : user.rootDeckIds;
  const folderEntries  = folderId === null
    ? Object.keys(user.cards).map(id => ({ cardId: id }))
    : collectFolderEntries(user, folderId);
  const folderTitle    = folder ? folder.name : t('folder.title.home');

  const parentId = folder ? findParentFolder(folderId!, 'folder', user) : null;
  const parentOptions = folder ? [
    { value: '', label: t('folder.title.home') },
    ...Object.values(user.folders)
      .filter(f => f.id !== folderId && !isFolderDescendant(user, folderId!, f.id))
      .map(f => ({ value: f.id, label: folderPath(f.id, user) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ] : [];

  return (
    <div class="p-6 space-y-6 view-enter overflow-y-auto h-full">

      {/* ── Header ── */}
      {/* Laid out like the deck's header: the actions stay top right, their
          labels go first when the row runs short, then the name wraps. */}
      <div ref={headerRef} class={`flex ${folder ? 'items-start' : 'items-center'} justify-between gap-4`}>
        <div class="flex-auto min-w-0">
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
                title={t('common.clickToRename')}
                onClick={() => { setEditName(folder.name); setIsEditingName(true); }}
              >
                {folder.name}
              </h1>
            )
          ) : (
            <h1 class="text-xl font-semibold text-primary">{t('folder.title.home')}</h1>
          )}
          {folder && (
            <div class="flex items-center gap-1 mt-1">
              <span class="text-2xs font-medium uppercase tracking-wider text-dim">{t('folder.parent.label')}</span>
              <CustomSelect
                value={parentId ?? ''}
                options={parentOptions}
                onChange={(v) => mutate(s => moveFolderToParent(s, folderId!, v || null))}
                renderTrigger={(label, open, toggle) => (
                  <button
                    type="button"
                    class="text-2xs font-medium text-dim cursor-pointer hover:text-accent transition-colors flex items-center gap-0.5 shrink-0 whitespace-nowrap"
                    onClick={toggle}
                  >
                    {label}
                    <span class={`shrink-0 flex transition-transform ${open ? 'rotate-180' : ''}`}><ChevronDownIcon size={12} /></span>
                  </button>
                )}
              />
            </div>
          )}
        </div>
        <div class="flex gap-2 shrink-0">
          {/* Home only: smart edit works on the whole library, not on the
              folder it would be opened from. Loaded on demand. */}
          {!folderId && (
            <button
              class="btn-outline px-3 inline-flex items-center gap-1.5 relative"
              title={t('smartEdit.openTitle')}
              aria-label={hiddenLabels > 0 ? t('smartEdit.open') : undefined}
              onClick={() => { void import('../components/smartEdit').then(m => m.showSmartEdit()); }}
            >
              <ShrinkIcon><WandIcon size={14} /></ShrinkIcon>
              <ShrinkLabel shown={hiddenLabels === 0}>{t('smartEdit.open')}</ShrinkLabel>
            </button>
          )}
          {/* Only the folder view carries the tooltip: its label was shortened
              to "Study", while the home button keeps the self-explanatory
              "Study all" and a tooltip there would just repeat the label. */}
          {folderEntries.length > 0 && (
            <StudyButton
              opts={{ entries: folderEntries, title: folderTitle, defaultContext: null }}
              label={folderId ? t('folder.study') : t('folder.studyAll')}
              title={folderId ? t('folder.studyTitle') : undefined}
              tour="study-all"
              showLabel={hiddenLabels <= studyLabelAt}
            />
          )}
          {folder && (
            <IconButton
              variant="danger"
              label={t('folder.deleteFolder')}
              onClick={() => {
                const doDelete = (deleteOrphans: boolean) => {
                  void mutate(u => {
                    if (deleteOrphans) removeCards(u, orphanedCardsAfterDeckRemoval(collectFolderDeckIds(u, folderId!), u));
                    deleteFolderRecursive(u, folderId!);
                  });
                  leaveDeletedPage();
                };
                const orphans = orphanedCardsAfterDeckRemoval(collectFolderDeckIds(user, folderId!), user);
                if (orphans.length > 0) {
                  confirmModalWithOption(
                    t('folder.delete.title'),
                    t('folder.delete.message', { name: folder.name }),
                    t('common.delete'),
                    t(orphans.length !== 1 ? 'common.deleteOrphanCardsPlural' : 'common.deleteOrphanCards', { count: orphans.length }),
                    doDelete,
                  );
                } else {
                  confirmModal(
                    t('folder.delete.title'),
                    t('folder.delete.message', { name: folder.name }),
                    t('common.delete'),
                    () => doDelete(false),
                  );
                }
              }}
            >
              <TrashIcon size={14} />
            </IconButton>
          )}
        </div>
      </div>

      {/* ── Dashboard (root only) ── */}
      {!folderId && <Dashboard user={user} />}

      {/* ── Favorites (root only) ── */}
      {!folderId && (() => {
        const favoriteDecks = Object.values(user.decks).filter(d => d.favorite).sort((a, b) => a.name.localeCompare(b.name));
        if (favoriteDecks.length === 0) return null;
        return (
          <div class="space-y-2" data-tour="favorites">
            <span class="section-title">{t('folder.section.favorites')}</span>
            <div class="flex flex-wrap gap-2">
              {favoriteDecks.map(deck => (
                <button
                  key={deck.id}
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-elevated hover:border-accent/50 transition-colors cursor-pointer text-sm text-primary"
                  onClick={() => navigate({ view: 'deck', deckId: deck.id })}
                >
                  <span class="text-gold flex items-center"><StarIcon size={12} filled /></span>
                  {deck.name}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Sub-folders ── */}
      <div class="space-y-2" data-tour="folders">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('folder.section.folders')}</span>
          <button class="btn-ghost text-xs min-h-8 inline-flex items-center gap-1.5" onClick={() =>
            promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
              mutate(s => {
                const id = generateId();
                s.folders[id] = { id, name, folderIds: [], deckIds: [] };
                if (folderId) s.folders[folderId]!.folderIds.push(id);
                else s.rootFolderIds.push(id);
              });
            })
          }>
            <PlusIcon size={12} />{t('folder.newFolder')}
          </button>
        </div>
        {folderIds.length === 0 ? (
          <EmptyState>{t('folder.empty.folders')}</EmptyState>
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
                  {/* Half-visible at rest rather than hidden: under a finger there is no hover
                      to reveal it, and nothing else says a long press moves the row. */}
                  <span class="text-dim opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity">⠿</span>
                  <span class="text-muted shrink-0 flex items-center">
                    <FolderIcon size={14} />
                  </span>
                  <span class="text-sm text-primary flex-1 truncate">{sub.name}</span>
                  <span class="text-xs text-dim shrink-0">{t(sub.folderIds.length === 1 ? 'folder.meta.folders' : 'folder.meta.foldersPlural', { count: sub.folderIds.length })}
                    {' · '}
                    {t(sub.deckIds.length === 1 ? 'folder.meta.decks' : 'folder.meta.decksPlural', { count: sub.deckIds.length })}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Decks ── */}
      <div class="space-y-2" data-tour="decks">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('folder.section.decks')}</span>
          <button class="btn-ghost text-xs min-h-8 inline-flex items-center gap-1.5" data-tour="new-deck" onClick={() => showCreateDeckModal(getContext(), folderId)}>
            <PlusIcon size={12} />{t('folder.newDeck')}
          </button>
        </div>
        {deckIds.length === 0 ? (
          <EmptyState>{t('folder.empty.decks')}</EmptyState>
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
                  data-tour={`deck-${deckId}`}
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
                  <span class="text-dim opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity">⠿</span>

                  <span class="flex gap-0.5 items-center shrink-0">
                    <span class={`w-2 h-2 rounded-full ${availabilityColor(avail, ease <= 0)}`} title={ease <= 0 ? t('card.neverReviewed') : t('card.dot.recall', { pct: pct(avail) })} />
                    <span
                      class={`w-2 h-2 rounded-full ${ease <= 0 ? 'bg-border' : ease >= 0.6 ? 'bg-success' : ease >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                      title={ease > 0 ? t('card.dot.ease', { pct: pct(ease) }) : t('card.neverReviewed')}
                    />
                  </span>

                  <span class="text-sm text-primary flex-1 truncate">{deck.name}</span>
                  <span class="text-xs font-mono text-dim shrink-0">
                    {lastTs ? timeAgo(lastTs) : t('card.neverReviewed')}
                  </span>
                  <span class="text-xs text-dim shrink-0">{t(deck.entries.length === 1 ? 'folder.deckMeta' : 'folder.deckMetaPlural', { count: deck.entries.length })}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
