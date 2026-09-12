import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { t } from '../../services/i18nService';
import { HeartIcon, ChevronDownIcon, CheckIcon, SortAlphaIcon, ClockIcon, WeightedBarsIcon } from '../../components/icons';
import { playIcon, stopIcon } from '../../components/playbackIcons';
import { FilterSection, cycleFilter, type FilterMap } from '../../components/filterSection';
import { createLongPressHandlers } from '../../components/longPress';
import { useContextMenu } from '../../components/contextMenu';
import { navigate, getContext } from '../../store';
import { showDeckPickerModal } from '../../components/batchEdit';
import { findByExternalId, fetchTuneById, tuneResultToCard } from '../../services/theSessionService';
import type { TuneSort } from '../../types';
import type { Analysis } from '../model';
import { loadSessionAudio } from '../db';
import { BUCKET_TEXT, tuneName, ClipControls, TuneDeckButton, attachClip, isClipAttached } from './sessionUiShared';
import { showBatchProgress, type BatchStep, type StepOutcome } from './batchRunner';
import { deckGain } from './tuneBatch';
import { AbcPreview } from './abcPreview';
import { rankDetectedTunes, occurrencesOf, sortTuneRows, TUNE_SORT_DEFAULT_ASC } from './tuneRanking';

// ── Screen: what this scene plays ────────────────────────────────────────────
// The analyses read the other way round: by tune instead of by evening. It is
// deliberately built like the card library — same filter chips, same selection
// toolbar, same sort control — because it is the same kind of object (a long
// list you narrow, order and act on in bulk) and someone who has learnt one
// should not have to learn the other.
//
// Every per-detection control here already exists inside an analysis, and is
// the SAME component: the deck button, the ABC preview, the clip download and
// attach. A tune found from this side has to be actionable from this side.

const SORT_MODES: TuneSort[] = ['alpha', 'lastHeard', 'count'];
const SORT_ICON: Record<TuneSort, ComponentType<{ size?: number }>> = {
  alpha: SortAlphaIcon,
  lastHeard: ClockIcon,
  count: WeightedBarsIcon,
};

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** The card each detected tune already has, if any — built once per render
 *  rather than searched per row: a lookup per tune over every card is the kind
 *  of quadratic that only shows up on the machine of whoever has most of both. */
function cardIdByTuneId(): Map<string, string> {
  const out = new Map<string, string>();
  for (const card of Object.values(getContext().user.cards)) {
    const ext = card.externalId;
    if (ext?.startsWith('thesession:')) out.set(ext.slice('thesession:'.length), card.id);
  }
  return out;
}

/** Everything about this list that survives leaving the screen. Held by the
 *  parent and mirrored into the route, so that coming back from a detection
 *  lands on the list you left rather than on its defaults — the same contract
 *  the card library's filters have. Selection and which tune is open are
 *  deliberately NOT in here: they are where you are, not what you asked for. */
export interface TuneViewState {
  sort: TuneSort;
  sortAsc: boolean;
  analyses: FilterMap;
  analysesOr: boolean;
  /** The two yes/no properties a tune has here — hearted, and card-less —
   *  as chips rather than checkboxes. Same three states as every other chip in
   *  the app, which buys the two negatives for free: a checkbox could only ask
   *  for the hearted ones, a chip can also ask for the ones you have NOT
   *  hearted. Keys are `OTHER_LIKED` / `OTHER_NO_CARD`. */
  others: FilterMap;
  /** Whether several included "other" chips mean any of them or all of them.
   *  Defaults to all — they are different axes, so "hearted AND card-less" is
   *  the question people arrive with — but both readings are real, so the
   *  section carries the same toggle the decks and tags do. */
  othersOr: boolean;
}

/** Chip keys for the "other" section. Strings rather than an enum because
 *  `FilterMap` is keyed by string and these travel in the route. */
export const OTHER_LIKED = 'liked';
export const OTHER_NO_CARD = 'noCard';

export function TuneRankingPanel({ sessions, query, view, onView }: {
  sessions: Analysis[];
  query: string;
  view: TuneViewState;
  onView: (patch: Partial<TuneViewState>) => void;
}) {
  const ctx = getContext();
  const { sort: sortMode, sortAsc, analyses: activeAnalyses, analysesOr, others, othersOr } = view;
  const [openTuneId, setOpenTuneId] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Bumped after anything that changes the user blob (a card created, a clip
   *  attached), since this tree reads it directly rather than through a signal. */
  const [, bump] = useState(0);
  const refresh = () => bump(x => x + 1);

  const masterRef = useRef<HTMLInputElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);

  // A menu that only closes by choosing from it is a trap. Copied from the
  // card library along with the menu itself — and forgotten the first time,
  // which is exactly how a dropdown ends up with no way out.
  useEffect(() => {
    if (!sortOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (!sortRef.current?.contains(e.target as Node)) setSortOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [sortOpen]);

  const lastClickRef = useRef<string | null>(null);
  const shiftActiveRef = useRef(false);
  // Shared long-press state (one row touched at a time) — created once here,
  // not per-row, since createLongPressHandlers is a plain function and not a
  // hook, precisely so it can be called inside the .map() below.
  const lpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpStartRef = useRef<{ x: number; y: number } | null>(null);
  const lpFiredRef = useRef(false);

  // ── Audio, loaded one analysis at a time ──
  // The rows of one tune come from different evenings, so there is no single
  // recording to hold open. The one that is playing is the one that is loaded;
  // switching tunes switches the source.
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadedRef = useRef<{ sessionId: string; url: string } | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const sliceEndRef = useRef<number>(Infinity);
  const [hasAudio, setHasAudio] = useState<Record<string, boolean>>({});

  const occurrences = openTuneId === null ? [] : occurrencesOf(sessions, openTuneId);

  /** Opens one tune's passages and closes whatever was open. Shared by the
   *  chevron and by the row behind it, so the two can never disagree. */
  const toggleOpen = (tuneId: string) => {
    const next = openTuneId === tuneId ? null : tuneId;
    setOpenTuneId(next);
    if (next) probeAudio(occurrencesOf(sessions, next).map(o => o.session.id));
  };

  /** Probed only for the tune that is open, never for the whole library. */
  const probeAudio = (ids: string[]) => {
    const unknown = [...new Set(ids)].filter(id => !(id in hasAudio));
    if (unknown.length === 0) return;
    void Promise.all(unknown.map(async id => [id, !!(await loadSessionAudio(id))] as const))
      .then(pairs => setHasAudio(prev => ({ ...prev, ...Object.fromEntries(pairs) })));
  };

  const playSlice = async (sessionId: string, detectionId: string, start: number, end: number | null) => {
    const a = audioRef.current;
    if (!a) return;
    // STOP, not pause — the same call the incipit's button makes. A passage is
    // under a minute, so there is nothing to come back to in the middle of it,
    // and pressing it again plays it from its own start.
    if (playingId === detectionId) { a.pause(); a.currentTime = start; setPlayingId(null); return; }

    if (loadedRef.current?.sessionId !== sessionId) {
      const blob = await loadSessionAudio(sessionId);
      if (!blob) return;
      if (loadedRef.current) URL.revokeObjectURL(loadedRef.current.url);
      const url = URL.createObjectURL(blob);
      loadedRef.current = { sessionId, url };
      a.src = url;
    }
    sliceEndRef.current = end ?? Infinity;
    a.currentTime = Math.max(0, start);
    try { await a.play(); } catch { setPlayingId(null); return; }
    setPlayingId(detectionId);
  };

  const cards = cardIdByTuneId();
  const all = rankDetectedTunes(sessions);

  // Which analyses a tune was heard in — needed by the chips below, and by the
  // filter itself. One pass, not one per row.
  const analysesOfTune = new Map<string, Set<string>>();
  for (const session of sessions) {
    for (const ann of session.annotations ?? []) {
      if (!ann.tuneId) continue;
      let set = analysesOfTune.get(ann.tuneId);
      if (!set) { set = new Set(); analysesOfTune.set(ann.tuneId, set); }
      set.add(session.id);
    }
  }

  const includes = [...activeAnalyses].filter(([, s]) => s === 'include').map(([id]) => id);
  const excludes = [...activeAnalyses].filter(([, s]) => s === 'exclude').map(([id]) => id);
  const passesAnalyses = (tuneId: string): boolean => {
    const heard = analysesOfTune.get(tuneId) ?? new Set<string>();
    if (excludes.some(id => heard.has(id))) return false;
    if (includes.length === 0) return true;
    return analysesOr ? includes.some(id => heard.has(id)) : includes.every(id => heard.has(id));
  };

  /** The "other" chips, read against a tune's two facts.
   *
   *  Exactly the card library's grammar, so the two screens cannot mean
   *  different things by the same gesture: **excludes are always a hard AND**
   *  (an excluded chip removes the tunes it matches, whatever else is asked),
   *  and only the INCLUDES swing between "all of" and "any of". Nothing
   *  pinned accepts everything. */
  const passesOthers = (liked: boolean, hasCard: boolean): boolean => {
    if (others.size === 0) return true;
    const holds = (key: string) => (key === OTHER_LIKED ? liked : !hasCard);
    const entries = [...others];
    const incl = entries.filter(([, s]) => s === 'include').map(([k]) => k);
    const excl = entries.filter(([, s]) => s === 'exclude').map(([k]) => k);
    const inclOk = incl.length === 0 || (othersOr ? incl.some(holds) : incl.every(holds));
    return inclOk && excl.every(k => !holds(k));
  };

  // The name is resolved before filtering, not just for display: someone typing
  // "Cooley" is typing the name they see, which may be their own card's.
  const rows = sortTuneRows(
    all
      .map(row => ({ row, name: tuneName(row).text, cardId: cards.get(row.tuneId) }))
      .filter(r => passesOthers(r.row.liked, !!r.cardId))
      .filter(r => passesAnalyses(r.row.tuneId))
      .filter(r => !query || r.name.toLowerCase().includes(query) || r.row.tuneId === query),
    sortMode, sortAsc,
  );

  // ── Which chips could still do something ──
  // Derived from what is ON SCREEN, not from the whole corpus: a chip that
  // cannot narrow the list any further is dimmed rather than offered, exactly
  // as the card library dims a tag no visible card carries. An already-pinned
  // chip stays live whatever this says (FilterSection's own rule), or a filter
  // would disable the control that undoes it.
  const availAnalyses = new Set(rows.flatMap(r => [...(analysesOfTune.get(r.row.tuneId) ?? [])]));
  const availOthers = new Set<string>();
  if (rows.some(r => r.row.liked)) availOthers.add(OTHER_LIKED);
  if (rows.some(r => !r.cardId)) availOthers.add(OTHER_NO_CARD);

  const hasSelection = selected.size > 0;
  if (masterRef.current) masterRef.current.indeterminate = hasSelection && selected.size < rows.length;

  /** Shared by the row's click and its long-press (which always ranges, being
   *  a phone's Shift+click — the same equivalence the card library makes). */
  const selectRange = (tuneId: string, treatAsShift: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      const from = lastClickRef.current;
      if (treatAsShift && from) {
        const a = rows.findIndex(r => r.row.tuneId === from);
        const b = rows.findIndex(r => r.row.tuneId === tuneId);
        if (a !== -1 && b !== -1) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i]!.row.tuneId);
          return next;
        }
      }
      if (next.has(tuneId)) next.delete(tuneId); else next.add(tuneId);
      return next;
    });
    lastClickRef.current = tuneId;
  };

  // ── What a selection of tunes can be put through ──
  // Both actions run over the SELECTION, in the order the list shows, one step
  // at a time behind a progress dialog (batchRunner.tsx). Both are also exactly
  // what the per-row controls do, applied several times — nothing here can be
  // done from this screen in no other way, which is the rule the rest of this
  // panel follows too.
  // Every SELECTED tune, not merely every visible one. Changing a filter does
  // not clear the selection, so it can hold tunes that scrolled out of the
  // list — and the card library acts on all of its own selection too. Read
  // from `all` rather than `rows` for exactly that reason.
  const selectedRows = all
    .map(row => ({ row, name: tuneName(row).text }))
    .filter(r => selected.has(r.row.tuneId));

  /** Add to decks, creating the card where there is none.
   *
   *  The card library's own action, with one difference that is the whole
   *  point of it being here: a tune the analyser heard is often a tune with no
   *  card at all, and refusing to file it would leave the interesting half of
   *  the selection behind. The card is fetched from TheSession first and the
   *  externalId re-checked inside the write, exactly as the single-tune button
   *  does (TuneDeckButton's commitAdd) — the same tune can arrive by another
   *  route while a dozen fetches are in flight. */
  const addToDecks = () => {
    const user = getContext().user;
    const ids = selectedRows.map(r => r.row.tuneId);
    const eligible = Object.values(user.decks)
      .map(d => ({ deck: d, n: deckGain(ids, id => cards.get(id), cardId => d.entries.some(e => e.cardId === cardId)) }))
      .filter(({ n }) => n > 0)
      .map(({ deck, n }) => ({ id: deck.id, info: t('library.deckInfo.add', { n }) }))
      .sort((a, b) => (user.decks[a.id]?.name ?? '').localeCompare(user.decks[b.id]?.name ?? ''));
    if (eligible.length === 0) return;

    showDeckPickerModal('sessions.ranking.batch.decks.title', 'sessions.ranking.batch.decks.confirm', eligible, (deckIds) => {
      const steps: BatchStep[] = selectedRows.map(({ row, name }) => ({
        label: name,
        run: async (): Promise<StepOutcome> => {
          const known = findByExternalId(`thesession:${row.tuneId}`, getContext().user.cards);
          // Fetched BEFORE the write, so a lookup that fails writes nothing at
          // all rather than half of it.
          const fresh = known ? null : tuneResultToCard(await fetchTuneById(Number(row.tuneId)));
          let changed = false;
          await ctx.mutate(s => {
            const existing = findByExternalId(`thesession:${row.tuneId}`, s.cards);
            let cardId = existing?.id;
            if (!existing && fresh) { s.cards[fresh.id] = fresh; cardId = fresh.id; changed = true; }
            if (!cardId) return;
            for (const deckId of deckIds) {
              const deck = s.decks[deckId];
              if (deck && !deck.entries.some(e => e.cardId === cardId)) { deck.entries.push({ cardId }); changed = true; }
            }
          });
          return changed ? { status: 'done' } : { status: 'skipped', reason: t('sessions.batch.skip.alreadyInDecks') };
        },
      }));
      showBatchProgress(t('sessions.ranking.batch.decks.title'), steps, refresh);
    });
  };

  /** Add the audio clips — EVERY passage of every selected tune.
   *
   *  Not one clip per tune: two passes through the same tune are two different
   *  performances, which is the rule this whole panel is built on (a tune
   *  heard three times shows three rows, never one saying "3 times"). Picking
   *  a best one would be this one screen quietly disagreeing with the rest.
   *
   *  In the order the passages are shown — newest analysis first. A passage
   *  whose recording is no longer on the device is stepped over rather than
   *  ending the tune, so one forgotten analysis costs only its own clips.
   *
   *  Requires a card: unlike the action above, this one does not create it —
   *  an attachment on a card nobody asked for is not a favour. */
  const attachClips = () => {
    const steps: BatchStep[] = selectedRows.map(({ row, name }) => ({
      label: name,
      run: async (onProgress): Promise<StepOutcome> => {
        if (!findByExternalId(`thesession:${row.tuneId}`, getContext().user.cards)) {
          return { status: 'skipped', reason: t('sessions.batch.skip.noCard') };
        }
        const passages = occurrencesOf(sessions, row.tuneId);
        let added = 0, already = 0;
        for (let i = 0; i < passages.length; i++) {
          const { session, detection } = passages[i]!;
          if (isClipAttached(session, detection)) { already++; continue; }
          const audio = await loadSessionAudio(session.id);
          if (!audio) continue; // that analysis lost its recording — the others still stand
          // The bar moves inside a tune too: a tune with four passages is four
          // MP3s, and a step that sat still for all of them would look stuck.
          await attachClip(ctx, session, detection, audio, r => onProgress?.((i + r) / passages.length));
          added++;
        }
        if (added > 0) return { status: 'done' };
        if (already > 0) return { status: 'skipped', reason: t('sessions.batch.skip.already') };
        return { status: 'skipped', reason: t('sessions.batch.skip.noAudio') };
      },
    }));
    showBatchProgress(t('sessions.ranking.batch.attach.title'), steps, refresh);
  };

  /** While a selection is under way, nothing on this screen navigates.
   *
   *  Leaving in the middle of picking out ten tunes loses the ten, and the
   *  links here are dense — a tune name, then an analysis name and a time pill
   *  for every passage under it — so a stray click on the wrong pixel would be
   *  both easy and costly. The click joins the selection instead, which is what
   *  a click on the row already does, and that includes the links inside a
   *  passage: they belong to the tune, so they answer for the tune.
   *
   *  Returns true when it has taken the event, so each call site reads as
   *  "unless a selection is under way, go there". */
  const claimedBySelection = (e: MouseEvent, tuneId: string): boolean => {
    if (selected.size === 0) return false;
    e.preventDefault();
    e.stopPropagation();
    selectRange(tuneId, e.shiftKey);
    return true;
  };

  const bulkMenu = useContextMenu([
    { label: t('sessions.ranking.batch.decks'), onClick: addToDecks },
    { label: t('sessions.ranking.batch.attach'), onClick: attachClips },
  ]);

  return (
    <div>
      {/* One element, re-pointed as the reader moves between evenings. Native
          <audio>, never decodeAudioData: an analysis can run for hours. */}
      <audio
        ref={audioRef}
        class="hidden"
        onPause={() => setPlayingId(null)}
        onEnded={() => setPlayingId(null)}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          if (a.currentTime >= sliceEndRef.current) a.pause();
        }}
      />

      <div class="mt-3 space-y-1">
        <FilterSection
          labelKey="sessions.ranking.filterAnalyses"
          items={sessions.map(s => s.id)}
          activeMap={activeAnalyses}
          labelOf={id => sessions.find(s => s.id === id)?.name ?? id}
          titleOf={() => ''}
          available={availAnalyses}
          onToggle={(id, back) => onView({ analyses: cycleFilter(activeAnalyses, id, back) })}
          highlight={query}
          orMode={analysesOr}
          onToggleOr={() => onView({ analysesOr: !analysesOr })}
        />
        <FilterSection
          labelKey="sessions.ranking.filterOther"
          items={[OTHER_LIKED, OTHER_NO_CARD]}
          activeMap={others}
          // Two literal calls rather than one built key: the i18n test can
          // only verify what it can read, and there is no reason to hide two
          // labels from it to save a line.
          labelOf={id => id === OTHER_LIKED ? t('sessions.ranking.other.liked') : t('sessions.ranking.other.noCard')}
          titleOf={() => ''}
          available={availOthers}
          onToggle={(id, back) => onView({ others: cycleFilter(others, id, back) })}
          orMode={othersOr}
          onToggleOr={() => onView({ othersOr: !othersOr })}
        />
      </div>

      {/* ── Selection toolbar — the card library's, with this list's actions ── */}
      <div class="flex items-center justify-between h-9 mt-1">
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            class="card-checkbox"
            checked={rows.length > 0 && selected.size === rows.length}
            ref={masterRef}
            onChange={() => {
              if (selected.size === rows.length && rows.length > 0) setSelected(new Set());
              else setSelected(new Set(rows.map(r => r.row.tuneId)));
            }}
          />
          <span class="text-xs text-dim">
            {hasSelection
              ? t('sessions.ranking.masterSelected', { count: selected.size, total: rows.length })
              : t('sessions.ranking.masterSelectAll', { count: rows.length })}
          </span>
        </label>

        <div class="flex gap-1 items-center">
          {/* The ref is what the outside-click effect measures "outside"
              against, and it was missing: `sortRef.current` stayed null, so the
              guard `!sortRef.current?.contains(...)` was true for EVERY
              mousedown — including one on a menu entry, which unmounted the
              menu before the click could land on it. The menu opened, and
              picking from it did nothing (2026-09-12). */}
          <div class="relative" ref={sortRef}>
            <button
              type="button"
              class="btn-ghost text-xs inline-flex items-center justify-center"
              title={t(`sessions.ranking.sort.${sortMode}`)}
              onClick={() => setSortOpen(o => !o)}
            >
              {(() => { const Icon = SORT_ICON[sortMode]; return <Icon size={13} />; })()}
            </button>
            {sortOpen && (
              <div class="absolute top-full right-0 mt-1 z-30 bg-elevated border border-border rounded-lg overflow-hidden shadow-2xl py-1 min-w-[190px]">
                {SORT_MODES.map(m => {
                  const Icon = SORT_ICON[m];
                  const active = m === sortMode;
                  return (
                    <button
                      key={m}
                      class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-none bg-transparent text-left transition-colors ${active ? 'text-accent' : 'text-muted hover:bg-surface'}`}
                      // Picking a criterion also points it the way that
                      // criterion is usually read — names up, counts and dates
                      // down — instead of keeping whatever the last one used.
                      onClick={() => { onView({ sort: m, sortAsc: TUNE_SORT_DEFAULT_ASC[m] }); setSortOpen(false); }}
                    >
                      <span class="shrink-0 flex items-center"><Icon size={12} /></span>
                      <span class="flex-1">{t(`sessions.ranking.sort.${m}`)}</span>
                      {active && <span class="text-accent flex items-center"><CheckIcon size={11} /></span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            class="btn-ghost text-xs inline-flex items-center justify-center"
            title={sortAsc ? t('library.sort.ascending') : t('library.sort.descending')}
            onClick={() => onView({ sortAsc: !sortAsc })}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={`transition-transform ${sortAsc ? 'rotate-180' : ''}`}>
              <line x1="12" y1="5" x2="12" y2="19"/>
              <polyline points="19 12 12 19 5 12"/>
            </svg>
          </button>
          {hasSelection && <>
            <div class="w-px h-4 bg-border mx-1" />
            <button
              class="btn-ghost text-xs inline-flex items-center justify-center"
              title={t('library.batch.more')}
              onClick={(e) => bulkMenu.open(e.clientX, e.clientY)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
            </button>
          </>}
        </div>
      </div>
      {bulkMenu.menu}

      {rows.length === 0 ? (
        <p class="text-xs text-dim text-center py-4">
          {all.length === 0 ? t('sessions.ranking.empty') : t('sessions.ranking.noMatch')}
        </p>
      ) : (
        <div class="space-y-1">
          {rows.map(({ row, name, cardId }) => {
            const isSel = selected.has(row.tuneId);
            const isOpen = openTuneId === row.tuneId;
            return (
              // No box around it: the card library's rows are lines that
              // light up on hover, and a user moving between the two screens
              // should not have to learn a second idea of what a row is.
              //
              // The tint sits on the OUTER div, not on the line: a tune that is
              // open is one thing — the line and the passes under it — so it
              // has to light up as one thing. `group` comes along for the same
              // reason, which is what keeps the checkbox visible while the
              // pointer is anywhere in the block.
              <div
                key={row.tuneId}
                class={`rounded transition-colors group ${isSel ? 'bg-elevated' : 'hover:bg-elevated'}`}
              >
                {/* py-2, not the library's py-2.5, and the line still comes out
                    the same height: the tallest thing in a library row is 20px
                    of text, the tallest here is a 24px round button. Matching
                    the PADDING would have made these rows 4px taller than the
                    ones they are meant to read like — so the box is matched
                    instead, which is what the eye compares down a column. */}
                <div
                  class="flex items-center gap-3 px-3 py-2 cursor-pointer"
                  // Shift-clicking a row would otherwise select the text
                  // between the two, which is never what was meant.
                  onMouseDown={(e) => { if (selected.size > 0 && e.shiftKey) e.preventDefault(); }}
                  // With nothing selected the whole row is the chevron: every
                  // control inside it that means something else — the checkbox,
                  // the name, the deck button — stops the event, so the
                  // background is what is left, and that is where "show me this
                  // one" lives.
                  //
                  // Once a selection is under way the row joins it instead,
                  // exactly as the card library's rows do: picking out ten
                  // tunes should not mean ten trips to a 14px checkbox. The
                  // chevron still opens the passages, so nothing is lost.
                  onClick={(e) => {
                    if (selected.size === 0) { toggleOpen(row.tuneId); return; }
                    selectRange(row.tuneId, e.shiftKey);
                  }}
                  {...createLongPressHandlers(
                    { timer: lpTimerRef, start: lpStartRef, fired: lpFiredRef },
                    () => selectRange(row.tuneId, true),
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    class={`card-checkbox shrink-0 transition-opacity ${isSel ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'}`}
                    onMouseDown={(e) => { e.stopPropagation(); shiftActiveRef.current = e.shiftKey; }}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => {
                      const shift = shiftActiveRef.current;
                      shiftActiveRef.current = false;
                      selectRange(row.tuneId, shift);
                    }}
                  />

                  {/* One line, truncated — a library row never grows to two,
                      and a list whose rows are all the same height is a list
                      you can run your eye down. */}
                  <div class="flex-1 min-w-0 flex items-center gap-1.5">
                    {/* The name IS the link, exactly as in a detection: the
                        card if there is one, TheSession if there is not. No
                        separate buttons for it — one name, one destination. */}
                    {cardId ? (
                      <span
                        class={`text-sm text-primary truncate ${selected.size === 0 ? 'cursor-pointer hover:text-accent transition-colors' : ''}`}
                        title={t('sessions.openCard')}
                        onClick={(e) => {
                          if (claimedBySelection(e, row.tuneId)) return;
                          e.stopPropagation();
                          navigate({ view: 'card', cardId });
                        }}
                      >
                        {name}
                      </span>
                    ) : (
                      <a
                        class={`text-sm text-primary truncate ${selected.size === 0 ? 'cursor-pointer hover:text-accent transition-colors' : ''}`}
                        title={t('sessions.viewOnTheSession')}
                        href={`https://thesession.org/tunes/${row.tuneId}`}
                        target="_blank"
                        rel="noopener"
                        // preventDefault matters here and nowhere else: an <a>
                        // would have opened the tab before any state had a say.
                        onClick={(e) => { if (claimedBySelection(e, row.tuneId)) return; e.stopPropagation(); }}
                      >
                        {name}
                      </a>
                    )}
                    {/* No "no card" badge: an analysis does not carry one
                        either, and the deck button beside it already says
                        whether the card exists — a + creates it, the deck
                        glyph files the one that is there. */}
                    {row.liked && <span class="text-danger shrink-0 flex items-center"><HeartIcon size={11} filled /></span>}
                  </div>

                  {/* Create the card, or file the existing one — the same
                      control an analysis offers, not a second copy of it. */}
                  <TuneDeckButton tuneId={row.tuneId} ctx={ctx} onCardAdded={refresh} />

                  {/* Count and chevron are ONE control, not two slots: the
                      number is the size of what the chevron opens, so reading
                      them apart never made sense, and two boxes side by side
                      cost the row width for nothing. The tooltip still says
                      both things — what the number means, and what pressing it
                      does. */}
                  <button
                    class="shrink-0 flex items-center gap-0.5 px-1 py-0.5 rounded cursor-pointer text-dim hover:text-primary transition-colors"
                    title={`${t('sessions.ranking.heard', { n: row.count })} · ${t(isOpen ? 'sessions.ranking.collapse' : 'sessions.ranking.show')}`}
                    onClick={(e) => { e.stopPropagation(); toggleOpen(row.tuneId); }}
                  >
                    <span class="text-xs font-mono tabular-nums">{row.count}</span>
                    <span class={`flex items-center transition-transform ${isOpen ? '' : '-rotate-90'}`}>
                      <ChevronDownIcon size={12} />
                    </span>
                  </button>
                </div>

                {/* Every pass, each its own destination — the same rule the
                    analyses and "Detected in" both follow, never one row
                    saying "3 times". And everything that can be done with a
                    detection inside its analysis can be done from here. */}
                {isOpen && (
                  <div class="pl-10 pr-3 pb-2 space-y-2">
                    {occurrences.map(({ session, detection }) => (
                      // Never wraps. A pass is one line, and the glyphs at
                      // its end are a column read downwards — a row that folded
                      // took its column with it.
                      <div key={detection.id} class="flex items-center gap-2">
                        <button
                          class={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border ${selected.size === 0 ? 'cursor-pointer hover:border-accent' : ''} ${
                            detection.userConfirmed ? 'text-success' : BUCKET_TEXT[detection.bucket]}`}
                          title={t('sessions.openDetection')}
                          onClick={(e) => {
                            if (claimedBySelection(e, row.tuneId)) return;
                            navigate({ view: 'sessions', sessionId: session.id, annotationId: detection.id });
                          }}
                        >
                          {fmtTime(detection.start)}
                        </button>

                        <button
                          class={`text-sm text-muted min-w-0 text-left flex-1 inline-flex items-center gap-1.5 ${selected.size === 0 ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
                          // The full name, since the visible one is cut.
                          title={session.name}
                          onClick={(e) => {
                            if (claimedBySelection(e, row.tuneId)) return;
                            navigate({ view: 'sessions', sessionId: session.id, annotationId: detection.id });
                          }}
                        >
                          <span class="truncate min-w-0">{session.name}</span>
                          {/* THIS pass, not the tune: the heart on the title
                              above says one of them was hearted, this one says
                              which. Without it a tune hearted once looks
                              hearted everywhere. */}
                          {detection.liked && (
                            <span class="text-danger shrink-0 flex items-center"><HeartIcon size={10} filled /></span>
                          )}
                        </button>

                        {/* Four fixed slots, filled or not. What can be done
                            with a pass depends on the pass — an analysis whose
                            audio was forgotten offers no listening and no clip
                            — and without reserved room the glyphs of one row
                            would sit under the wrong glyphs of the next. */}
                        <div class="shrink-0 flex items-center gap-1.5">
                          {/* Hearing it comes before reading it: this list is
                              for tunes you do not know yet. */}
                          <span class="w-6 flex items-center justify-center shrink-0">
                            {hasAudio[session.id] && (
                              <button
                                class={`w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
                                  playingId === detection.id ? 'bg-accent text-white' : 'bg-accent/10 text-accent hover:bg-accent/20'}`}
                                title={t(playingId === detection.id ? 'sessions.stopSlice' : 'sessions.playSlice')}
                                dangerouslySetInnerHTML={{ __html: playingId === detection.id ? stopIcon(10) : playIcon(10) }}
                                onClick={() => { void playSlice(session.id, detection.id, detection.start, detection.end); }}
                              />
                            )}
                          </span>

                          <AbcPreview settingId={detection.settingId} displayName={detection.displayName} cardId={cardId} ctx={ctx} />

                          <ClipControls
                            ann={detection}
                            session={session}
                            audioAvailable={!!hasAudio[session.id]}
                            getAudio={() => loadSessionAudio(session.id)}
                            ctx={ctx}
                            onAttached={refresh}
                            aligned
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
