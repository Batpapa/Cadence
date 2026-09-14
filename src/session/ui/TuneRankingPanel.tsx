import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { t } from '../../services/i18nService';
import { HeartIcon, ChevronDownIcon, CheckIcon, SortAlphaIcon, ClockIcon, WeightedBarsIcon, LibraryIcon } from '../../components/icons';
import { FilterSection, cycleFilter, type FilterMap } from '../../components/filterSection';
import { createLongPressHandlers } from '../../components/longPress';
import { useContextMenu } from '../../components/contextMenu';
import { navigate, getContext } from '../../store';
import { showDeckPickerModal } from '../../components/batchEdit';
import { findByExternalId, fetchTuneById, tuneResultToCard } from '../../services/theSessionService';
import type { TuneSort } from '../../types';
import type { Analysis, Detection } from '../model';
import { getSettingAbcMeta, getSettingAbcMetaSync } from '../recognition/indexStore';
import { loadSessionAudio } from '../db';
import { tuneName, TuneDeckButton, attachClip, isClipAttached } from './sessionUiShared';
import { showBatchProgress, type BatchStep, type StepOutcome } from './batchRunner';
import { deckGain } from './tuneBatch';
import { PassRow, useSlicePlayer } from './PassRow';
import { rankDetectedTunes, occurrencesOf, sortTuneRows, filterByFacets, type PassFacet } from './tuneRanking';
import { folderChipKey, folderIdOfChip, knownChips, coveredByFolders, folderChipLabels } from '../../components/filterChips';
import { sessionTreeOf, folderChain, parentFolderOf, folderPathOf } from '../sessionTree';

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
  /** Tune types (reel, jig…) and keys (Dmajor, Edorian…), read off each PASS
   *  rather than each tune, like the analyses — see filterByFacets for why.
   *  Spelled as TheSession spells them, which is also how a TheSession card
   *  carries them as tags. A pass has one of each, so both sections are "any
   *  of" and carry no toggle (decided with the user, 2026-09-13). */
  dances: FilterMap;
  modes: FilterMap;
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
  const { sort: sortMode, sortAsc, analyses: pinnedAnalyses, analysesOr, others, othersOr, dances, modes } = view;

  // ── The analyses section: the evenings, and the folders they are filed in ──
  // One section, not two: a folder chip is a group of evening chips, and only
  // in the same section can "this folder OR that evening" be asked at all —
  // two sections always combine as AND (decided with the user, 2026-09-15).
  const tree = sessionTreeOf(ctx.user);
  const sessionIds = new Set(sessions.map(s => s.id));
  /** The folder chips above each analysis, however deep — empty for one filed
   *  nowhere. Built once per render, never looked up per pass. */
  const foldersAboveSession = new Map(sessions.map(s => [
    s.id,
    folderChain(tree, parentFolderOf(tree, { type: 'session', id: s.id })).map(f => folderChipKey(f.id)),
  ]));
  /** A chip naming an analysis or a folder deleted since is ignored rather than
   *  left filtering the list from nowhere (see knownChips). */
  const activeAnalyses = knownChips(pinnedAnalyses, key => {
    const folderId = folderIdOfChip(key);
    return folderId === null ? sessionIds.has(key) : !!tree.folders[folderId];
  });
  // Every folder holding an analysis, at any depth, plus any folder pinned — a
  // pinned chip always shows. By path, so a sub-folder follows its parent.
  const offeredFolders = new Set<string>();
  for (const keys of foldersAboveSession.values()) for (const k of keys) offeredFolders.add(folderIdOfChip(k)!);
  for (const k of activeAnalyses.keys()) { const id = folderIdOfChip(k); if (id !== null) offeredFolders.add(id); }
  const folderIds = [...offeredFolders].sort((a, b) => folderPathOf(tree, a).localeCompare(folderPathOf(tree, b)));
  const folderLabels = folderChipLabels(folderIds, id => tree.folders[id]?.name ?? id, id => folderPathOf(tree, id));
  const folderItems = folderIds.map(folderChipKey);
  const coveredAnalyses = coveredByFolders(
    [...sessionIds, ...folderItems],
    key => {
      const id = folderIdOfChip(key);
      return id === null
        ? foldersAboveSession.get(key) ?? []
        : folderChain(tree, id).slice(0, -1).map(f => folderChipKey(f.id));
    },
    activeAnalyses,
  );
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

  // Audio, loaded one analysis at a time — shared with a card's "Detected in".
  const player = useSlicePlayer();

  // A pass's key is the key of the setting it matched, which only the
  // recognition index knows. The map loads lazily — the ABC preview loads the
  // very same one — so the key section appears once it has arrived; on a device
  // that never had the index it stays away rather than offering chips that
  // could match nothing.
  const [, setIndexLoaded] = useState(false);
  useEffect(() => { void getSettingAbcMeta('').then(() => setIndexLoaded(true)); }, []);
  const modeOf = (d: Detection): string | undefined => getSettingAbcMetaSync(d.settingId)?.mode || undefined;

  /** The three sections that read a value off each pass — which analysis it is
   *  in, its tune type, its key — and so filter passes rather than tunes. */
  const facetAnalyses: PassFacet = { chips: activeAnalyses, or: analysesOr, valuesOf: (_d, s) => [s.id, ...(foldersAboveSession.get(s.id) ?? [])] };
  const facetDances: PassFacet = { chips: dances, or: true, valuesOf: d => (d.dance ? [d.dance] : []) };
  const facetModes: PassFacet = { chips: modes, or: true, valuesOf: d => { const m = modeOf(d); return m ? [m] : []; } };
  const facets = [facetAnalyses, facetDances, facetModes];
  /** What the list is built from: only the passes those chips let through, so
   *  every count, date and heart below is one of THOSE. */
  const heard = filterByFacets(sessions, facets);

  const occurrences = openTuneId === null ? [] : occurrencesOf(heard, openTuneId);

  /** Opens one tune's passages and closes whatever was open. Shared by the
   *  chevron and by the row behind it, so the two can never disagree. */
  const toggleOpen = (tuneId: string) => {
    const next = openTuneId === tuneId ? null : tuneId;
    setOpenTuneId(next);
    // Probed only for the tune that is open, never for the whole library.
    if (next) player.probe(occurrencesOf(heard, next).map(o => o.session.id));
  };

  const cards = cardIdByTuneId();
  // Every tune whatever the chips say — what a selection acts on, and how the
  // empty screen tells "nothing detected yet" from "nothing matches".
  const all = rankDetectedTunes(sessions);

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

  /** The tunes a set of passes gives, past the tune-level chips and the search,
   *  not yet sorted. A function because the pass sections need it again to say
   *  what they could still add (see availOf). */
  const listFrom = (from: Analysis[]) =>
    // The name is resolved before filtering, not just for display: someone
    // typing "Cooley" is typing the name they see, which may be their own card's.
    rankDetectedTunes(from)
      .map(row => ({ row, name: tuneName(row).text, cardId: cards.get(row.tuneId) }))
      .filter(r => passesOthers(r.row.liked, !!r.cardId))
      .filter(r => !query || r.name.toLowerCase().includes(query) || r.row.tuneId === query);

  const shown = listFrom(heard);
  const rows = sortTuneRows(shown, sortMode, sortAsc);

  // ── Which chips could still do something ──
  // Derived from what is ON SCREEN, not from the whole corpus: a chip that
  // cannot narrow the list any further is dimmed rather than offered, exactly
  // as the card library dims a tag no visible card carries. An already-pinned
  // chip stays live whatever this says (FilterSection's own rule), or a filter
  // would disable the control that undoes it.
  const availOthers = new Set<string>();
  if (rows.some(r => r.row.liked)) availOthers.add(OTHER_LIKED);
  if (rows.some(r => !r.cardId)) availOthers.add(OTHER_NO_CARD);

  /** The values a pass section could still act on: those carried by a pass of
   *  a tune it would leave listed, every OTHER section applied but not its own
   *  — its own has already removed the very passes that carry the alternatives.
   *  - "Any of": the tunes listed without this section. A section that dimmed
   *    every value but the one pinned would be refusing its own second choice.
   *  - "All of": the tunes listed now. A value narrows the list only if one of
   *    them was ALSO heard in it. */
  const availOf = (facet: PassFacet): Set<string> => {
    const rest = filterByFacets(sessions, facets.filter(f => f !== facet));
    const listed = new Set((facet.or ? listFrom(rest) : shown).map(r => r.row.tuneId));
    const out = new Set<string>();
    for (const s of rest) {
      for (const d of s.annotations) {
        if (!listed.has(d.tuneId)) continue;
        for (const v of facet.valuesOf(d, s)) out.add(v);
      }
    }
    return out;
  };
  const availAnalyses = availOf(facetAnalyses);
  const availDances = availOf(facetDances);
  const availModes = availOf(facetModes);

  /** The chips a section offers: every value any pass carries, plus whatever
   *  is pinned — a chip restored from the route before the index has loaded
   *  would otherwise filter the list while nowhere to be seen. */
  const chipsOf = (pick: (d: Detection) => string | undefined, pinned: FilterMap): string[] => {
    const out = new Set<string>(pinned.keys());
    for (const s of sessions) {
      for (const d of s.annotations ?? []) {
        const v = pick(d);
        if (v) out.add(v);
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  };
  const danceChips = chipsOf(d => d.dance || undefined, dances);
  const modeChips = chipsOf(modeOf, modes);

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
  /** The cards behind the selection — a tune with no card has nothing to show
   *  in the library, so it simply does not travel. */
  const selectedCardIds = selectedRows
    .map(r => cards.get(r.row.tuneId))
    .filter((id): id is string => !!id);

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

  /** Add the audio clips — EVERY passage the list shows of every selected
   *  tune: with a key pinned, the passes heard in another key are not the ones
   *  being looked at, and are left out exactly as they are left out of the count.
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
        const passages = occurrencesOf(heard, row.tuneId);
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
      {player.audio}

      <div class="mt-3 space-y-1">
        <FilterSection
          labelKey="sessions.ranking.filterAnalyses"
          items={sessions.map(s => s.id)}
          folderItems={folderItems}
          covered={coveredAnalyses}
          activeMap={activeAnalyses}
          labelOf={id => {
            const folderId = folderIdOfChip(id);
            return folderId !== null ? folderLabels.get(folderId) ?? folderId : sessions.find(s => s.id === id)?.name ?? id;
          }}
          titleOf={id => {
            const folderId = folderIdOfChip(id);
            return folderId !== null ? folderPathOf(tree, folderId) : '';
          }}
          available={availAnalyses}
          onToggle={(id, back) => onView({ analyses: cycleFilter(activeAnalyses, id, back) })}
          highlight={query}
          orMode={analysesOr}
          onToggleOr={() => onView({ analysesOr: !analysesOr })}
        />
        {/* `orMode` with no toggle: one value per pass, so "any of" is the only
            reading — and it keeps a dimmed chip clickable, which is how a
            second type or key gets added to the first. */}
        {danceChips.length > 0 && (
          <FilterSection
            labelKey="sessions.ranking.filterDances"
            items={danceChips}
            activeMap={dances}
            labelOf={v => v}
            titleOf={() => ''}
            available={availDances}
            onToggle={(v, back) => onView({ dances: cycleFilter(dances, v, back) })}
            highlight={query}
            orMode
          />
        )}
        {modeChips.length > 0 && (
          <FilterSection
            labelKey="sessions.ranking.filterModes"
            items={modeChips}
            activeMap={modes}
            labelOf={v => v}
            titleOf={() => ''}
            available={availModes}
            onToggle={(v, back) => onView({ modes: cycleFilter(modes, v, back) })}
            highlight={query}
            orMode
          />
        )}
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
                      // The criterion changes, the DIRECTION does not — the
                      // card library's own rule (views/library.tsx sets the
                      // mode and leaves sortAsc alone). This once also pointed
                      // each criterion the way it is usually read, which was a
                      // nice idea and a surprising one: turning the list upside
                      // down was not what was asked for, and the arrow beside
                      // this menu is right there to do it (2026-09-12).
                      // TUNE_SORT_DEFAULT_ASC still decides where a criterion
                      // STARTS, in SessionLibrary — just not where it lands
                      // when you switch to it later.
                      onClick={() => { onView({ sort: m }); setSortOpen(false); }}
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
            {/* The deck page's "view in library" button, carrying the selection
                instead of a deck filter: the library opens limited to those
                cards, where its own filters — decks, tags — apply to them.
                Limited rather than pre-ticked: a selection is lost as soon as a
                filter hides part of it, and while one exists a click ticks a
                card instead of opening it; "select all" is one click away. */}
            {selectedCardIds.length > 0 && (
              <button
                type="button"
                class="w-6 h-6 shrink-0 flex items-center justify-center rounded-md border border-border text-muted hover:border-accent hover:text-accent transition-colors cursor-pointer"
                title={t('sessions.ranking.viewInLibrary')}
                onClick={() => navigate({ view: 'library', cards: selectedCardIds })}
              >
                <LibraryIcon size={12} />
              </button>
            )}
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

                  {/* Create the card, or file the existing one — the same
                      control an analysis offers, not a second copy of it.
                      Left of the name (2026-09-13): it answers "is this one
                      of mine" before the name is read, as the play button
                      leads each pass below. */}
                  <TuneDeckButton tuneId={row.tuneId} ctx={ctx} onCardAdded={refresh} />

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
                      <PassRow
                        key={detection.id}
                        session={session}
                        detection={detection}
                        cardId={cardId}
                        ctx={ctx}
                        player={player}
                        interactive={selected.size === 0}
                        onOpen={(e) => {
                          if (claimedBySelection(e, row.tuneId)) return;
                          navigate({ view: 'sessions', sessionId: session.id, annotationId: detection.id });
                        }}
                        onAttached={refresh}
                      />
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
