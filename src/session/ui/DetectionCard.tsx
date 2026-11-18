import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cardOfTuneId } from '../detections';
import type { ComponentChild } from 'preact';
import type { AppContext, SessionRating } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon, HourglassIcon, ChevronDownIcon, PencilIcon, TrashIcon, CheckIcon, NotesIcon, RatingIcon } from '../../components/icons';
import { RatingLabel } from '../../components/ratingLabel';
import { showDetectionNotesModal } from './AnalysisNotesModal';
import { IconButton } from '../../components/ui';
import { isCardId } from '../recognition/cardIndex';
import { hasLibrary } from '../../services/pageMode';
import { AbcPreview, TuneFacts } from './abcPreview';
import { PlayDisc, playDiscTitle, detectionAudioSync } from './PassRow';
import { scrollContainerOf } from './domInterop';
import { showAlternatesPopover } from './AlternatesPopover';
import { BUCKET_BADGE, tuneName, useTuneNames, TuneDeckButton } from './sessionUiShared';
import { getContext } from '../../store';
import { viterbiPickOf, hasRecognisedSetting, keyOffsetOf, type Detection, type DetectionAlternate } from '../model';
import { reviewEntryIndex } from '../../services/reviewEntries';
import { detectionReviewId, reviewEntryTs } from '../reviewLink';
import { currentPick, provisionalEnd } from '../detectionState';
import { fmtDateTime } from '../../services/dateFormat';
import { RATING_BUTTONS, ratingButtonClass } from '../../components/ratingButtons';
import { tempoText } from './tempoText';
import { analysisTempo } from './analysisView';
import { approxTempo } from '../tempoSummary';
// ── DetectionCard ────────────────────────────────────────────────────────────
// The central unit of the session feed/summary: one recognised tune, with its
// play/ABC-preview/add-to-library/like controls and (when applicable) review
// logging. First leaf migrated from sessionModule.ts's imperative
// document.createElement tree to Preact (2026-08-24 — see the migration
// brief). Used directly as JSX by all three containers (LiveSession,
// ImportAnalysis, SessionSummary) — the imperative detectionCard() bridge
// this started with is gone now that none of its callers are still
// imperative (removed 2026-08-24 once SessionSummary, the last one, was
// migrated).

export interface DetectionCardOptions {
  ctx: AppContext;
  onOpenCard?: (cardId: string) => void;
  onCardAdded?: () => void;
  /** Play/stop this detection's audio slice; shows a ▶ button when provided. */
  onPlay?: (ann: Detection) => void;
  /** Which of its bounds the analysis has yet to put on the tune's passes —
   *  drawn with a ~. A live recording's or an import's
   *  (boundSuggest.ts); null or absent, none. */
  unrefined?: (ann: Detection) => { start: boolean; end: boolean } | null;
  playingId?: string | null;
  /** The recording is only on Drive: the ▶ wears a small cloud, and the
   *  passage is played straight from there (2026-10-10) — the same button as
   *  the lists of passes (PassRow.tsx's PlayDisc). */
  playFromDrive?: boolean;
  /** The detection whose passage is on its way from Drive. */
  playLoadingId?: string | null;
  /** The score viewer's "Audio sync" with this recording (PassRow.tsx's
   *  detectionAudioSync). Only on a saved analysis: the feeds' recording is
   *  still being written. */
  follow?: {
    /** The recording is on this device; otherwise it is read from Drive, if
     *  it is there. */
    here: boolean;
    /** Silences the screen's own player when it is turned on. */
    beforeOpen?: () => void;
  };
  /** The meta line — dance, mode, times, tempo and `metaActions` — under the
   *  name. Default true; the analysis's simple view leaves it out
   *  (analysisView.ts). */
  details?: boolean;
  /** The detection's tempo, quavers a second, on a feed still being analysed
   *  — read inside it in the engine's novelty so far (tempoSummary.ts's
   *  insideTempo); `approx` for the "~". Absent: the tempo saved with it
   *  (Detection.quaverRate), if any. */
  tempoOf?: (ann: Detection) => { rate: number; approx: boolean } | null;
  /** Opens the curve of the detection's tempo (LiveTempo.tsx's
   *  showDetectionTempo): the tempo shown becomes the way in. Absent, it is
   *  plain text — a saved analysis whose recording is not on this device. */
  onTempo?: (ann: Detection) => void;
  /** The "log this as a review" row. Default true; the analysis shows it only
   *  with its "Study" switch on (analysisView.ts). */
  study?: boolean;
  /** Drawn large, alone on the screen — the Focus view (FocusView.tsx): the
   *  name on a line of its own, and the study screen's four rating buttons in
   *  place of the small glyphs. */
  focus?: boolean;
  /** In the Focus view, under the name: the view's word on where the tune
   *  stands (FocusView.tsx). */
  focusNote?: ComponentChild;
  /** Extra controls rendered at the bottom of the card (bound-adjust/clip
   *  buttons — finalized annotations only, gated by the caller). */
  extraControls?: () => ComponentChild;
  /** Opens the bound editor. When given, the card's own time range becomes the
   *  way in — a button with a pencil, in the meta line where the range already
   *  is (2026-09-20).
   *
   *  The range is the control because it is the thing being changed: a
   *  separate button would have to name what it acts on, and the range names
   *  itself. It also gets the two ±5 s steppers off every card — they sat on
   *  all of them, permanently, for a correction made on perhaps one detection
   *  in twenty. Absent for a detection the decoder can still revise — which on
   *  the live and import feeds means anything not yet finalized. */
  onEditBounds?: () => void;
  /** Controls parked at the far end of the meta line, next to the range —
   *  the summary puts its clip buttons there. */
  metaActions?: () => ComponentChild;
  /** Deletes this detection. Rendered beside the like heart; the caller does
   *  the confirming, since it alone knows what is being thrown away. */
  onDelete?: () => void;
  /** Unix ms of the session's t=0. When set, closed annotations of known cards
   *  get the "log this as a review" control (summary + live feed; the import
   *  feed has no date until the user sets one in the summary).
   *
   *  Without it a rating can no longer be GIVEN — there is no instant to file
   *  it at — but one already given is still shown, and can still be taken
   *  back: clearing a session's date used to make its ratings vanish from the
   *  screen that made them (2026-09-23). */
  sessionStartMs?: number;
  /** The analysis this feed belongs to. Half of what identifies a rating given
   *  from one of its detections — see reviewLink.ts. The same id on the live,
   *  import and summary screens, so a rating given while recording is still
   *  recognised as its own once the session is saved. */
  sessionId: string;
  /** Decks pinned on the page this feed belongs to — they come back ticked in
   *  the deck choice modal, which now opens on EVERY add or link rather than
   *  once per page (see deckSelector.tsx for why). The Set is owned and mutated
   *  by the page, so a pin lasts exactly as long as the page does. */
  getPinnedDeckIds?: () => Set<string>;
  /** "I liked this tune" marker — purely personal, unrelated to any card. */
  onToggleLike?: (annotationId: string) => void;
  /** Saves the note on this detection — its whole text, blank to clear it.
   *  Makes the notes button right of the heart (2026-11-16, the user's place
   *  for it, on every view). */
  onEditNotes?: (annotationId: string, notes: string) => void;
  /** Records the user's verdict on this detection's identity — makes the
   *  confidence badge clickable (it opens the "explore alternatives" picker).
   *  A tune confirms it, `null` un-confirms and hands it back to the decoder.
   *  Open to a detection still playing (2026-10-10). Rating a detection calls
   *  it too, with the tune shown: a rating says THIS tune was played. */
  onSelectAlternate?: (annotationId: string, pick: DetectionAlternate | null) => void;
  /** Adds a tune named by hand to the picker's list, choosing nothing — it is
   *  ticked afterwards like any other variant. Without it the picker offers no
   *  "Another tune…". */
  onAddManualAlternate?: (annotationId: string, tune: DetectionAlternate) => void;
  /** Removes a hand-named variant from the picker's list (its grey trash). */
  onRemoveManualAlternate?: (annotationId: string, tuneId: string) => void;
  /** Freshest copy of a still-live detection, read on an interval while the
   *  picker is open — a live/import detection can still be revised (new
   *  alternates/scores) or retracted entirely while the user is browsing it.
   *  Reads straight from the engine (LiveSession/ImportSession.getDetections()),
   *  never stale, unlike this card's own `ann` prop which only updates on
   *  the container's next re-render. Omit for a finished session's summary,
   *  where nothing can change out from under the picker. */
  getLatestDetection?: (annotationId: string) => Detection | undefined;
}


function fmtLongTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ── Review logging from a recognised tune ─────────────────────────────────────
// "I played it at this session" = one review entry at the detection's end
// time, in the same history the card view and FSRS read. The entry names the
// detection it came from, and that is what tells this card its rating is
// already filed: when one is found, its button is ringed, and tapping it again
// takes it back. The instant alone used to do that job — see
// services/reviewEntries.ts for everything that broke while it did.

// `btn` is the tint the study screen's rating buttons use. These used to be
// the bare glyphs at text-xs, about 12 px wide — too small to hit with a
// finger while playing in a session (2026-10-08, group feedback). Each glyph
// now sits on a tinted circle the size of the card's play, score and add
// buttons above it — bigger read as out of place there (user's call). That
// circle is the 24 px drawing; the button around it is the 32 px target
// (styles.css, .icon-disc), so the look did not grow, the finger's room did.
//
// The four levels keep four drawings: RatingIcon's ✗ △ ○ ✓, the same SVGs as
// every other rating button (2026-11-18). △ and ○ were text glyphs until
// then, beside two icons: neither the same size nor the same layout.
// `muted`: once another rating is given, as the study buttons (ratingButtons.ts).
const RATING_GLYPHS: Array<{ rating: SessionRating; btn: string; muted: string; labelKey: string }> = [
  { rating: 'again', btn: 'bg-danger/10 group-hover:bg-danger/20 text-danger',    muted: 'bg-elevated text-dim group-hover:bg-danger/10 group-hover:text-danger',   labelKey: 'rating.again' },
  { rating: 'hard',  btn: 'bg-warn/10 group-hover:bg-warn/20 text-warn',          muted: 'bg-elevated text-dim group-hover:bg-warn/10 group-hover:text-warn',       labelKey: 'rating.hard' },
  { rating: 'good',  btn: 'bg-accent/10 group-hover:bg-accent/20 text-accent',    muted: 'bg-elevated text-dim group-hover:bg-accent/10 group-hover:text-accent',   labelKey: 'rating.good' },
  { rating: 'easy',  btn: 'bg-success/10 group-hover:bg-success/20 text-success', muted: 'bg-elevated text-dim group-hover:bg-success/10 group-hover:text-success', labelKey: 'rating.easy' },
];

/** How long the "remove" control ignores taps after a rating is given. It
 *  appears where the rating buttons were, so the second tap of a double tap
 *  would otherwise take the rating straight back. */
const REMOVE_GUARD_MS = 600;

/** The rating this detection carries, if any. Read from live state, so the
 *  card and the control below always agree on whether there is one. */
export function ratingOf(cardId: string, reviewId: string, ts: number | null) {
  const user = getContext().user;
  const history = user.cardWorks[`${user.currentProfileId}:${cardId}`]?.history ?? [];
  const at = reviewEntryIndex(history, reviewId, ts);
  return at === -1 ? undefined : history[at];
}

/** Takes this detection's rating off the card's history — the remove control's
 *  job, and what un-confirming the detection does too (below). */
function removeRating(ctx: AppContext, cardId: string, reviewId: string, ts: number | null): Promise<void> {
  return ctx.mutate(s => {
    const h = s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history;
    if (!h) return;
    const i = reviewEntryIndex(h, reviewId, ts);
    if (i !== -1) h.splice(i, 1);
  });
}

export function ReviewLogControl({ cardId, reviewId, ts, ctx, onRated }: {
  cardId: string;
  /** What this rating is filed under — opaque to the card's history, built by
   *  this module (reviewLink.ts). */
  reviewId: string;
  /** Null when the session has no date: nothing new can be filed, since the
   *  instant is the rating's only place in time. */
  ts: number | null;
  ctx: AppContext;
  /** After a rating is given — the card confirms the detection there. */
  onRated?: () => void;
}) {
  // Local re-render trigger after a mutation — mirrors the original's
  // `.then(render)` self-refresh exactly (not signal-driven): this card tree
  // is mounted into a detached node by the bridge below, outside the app's
  // main reactive tree, so nothing else would re-render it automatically.
  const [, setTick] = useState(0);
  const ratedAt = useRef(0);
  const existing = ratingOf(cardId, reviewId, ts);

  // Nothing to offer: no rating, and no instant to file one at. The card's
  // own history is where one can still be added by hand. A rating already
  // given still shows, to be changed or taken back.
  if (!existing && ts === null) return null;

  // The glyph alone, its name in the tooltip: a row of four labelled buttons
  // was tried and outweighed the card itself (2026-10-09, user's call). The
  // four stay once one is given (2026-11-18, the user's call — the Focus
  // view's grid already worked so): the given one ringed, another replacing
  // it, the same one again taking it back. It used to give way to a single
  // "remove" link, so changing a rating meant removing it first.
  return (
    <span class="inline-flex items-center gap-1.5">
      <span class="text-xs text-dim">{t('sessions.review.log')}</span>
      <span class="inline-flex items-center">
        {RATING_GLYPHS.map(({ rating, btn, muted, labelKey }) => {
          const given = existing?.rating === rating;
          return (
            <button
              key={rating}
              class="group icon-btn hover:bg-transparent"
              // The one given carries its date, as the old remove link did.
              title={given ? `${t(labelKey)} · ${fmtDateTime(existing!.ts, { seconds: true })}` : t(labelKey)}
              aria-label={t(labelKey)}
              aria-pressed={existing ? given : undefined}
              onClick={() => {
                if (!existing) onRated?.();
                void giveRating(ctx, cardId, reviewId, ts, rating, existing?.rating, ratedAt).then(() => setTick(x => x + 1));
              }}
            >
              <span class={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center transition-colors ${given ? `${btn} ring-2 ring-current` : existing ? muted : btn}`}><RatingIcon rating={rating} size={14} /></span>
            </button>
          );
        })}
      </span>
    </span>
  );
}

/** A tap on a rating, as both ways of giving one take it: the rating already
 *  given taken back, another one replacing it — the same entry, its id and
 *  instant kept — or a new one filed. `ratedAt` guards the take-back: the
 *  second tap of a double tap would remove what the first just gave. */
function giveRating(
  ctx: AppContext, cardId: string, reviewId: string, ts: number | null,
  rating: SessionRating, given: SessionRating | undefined, ratedAt: { current: number },
): Promise<void> {
  if (given === rating) {
    if (Date.now() - ratedAt.current < REMOVE_GUARD_MS) return Promise.resolve();
    return removeRating(ctx, cardId, reviewId, ts);
  }
  ratedAt.current = Date.now();
  return ctx.mutate(s => {
    const key = `${s.currentProfileId}:${cardId}`;
    if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId, history: [] };
    const h = s.cardWorks[key]!.history;
    const i = reviewEntryIndex(h, reviewId, ts);
    if (i !== -1) { h[i]!.rating = rating; return; }
    if (ts === null) return;
    h.push({ ts, rating, id: reviewId });
    h.sort((a, b) => a.ts - b.ts);
  });
}

// ── How the Focus view lays its four rating buttons out (2026-10-30) ─────────
// The user's rule:
//  • the study screen's layout, by the same SCREEN widths — one per line under
//    520 px, two per line under 900, the four in a row above (RATING_GRID);
//  • except that, when that pushes the buttons below the bottom of the
//    screen — makes the page scroll — two per line, and if they still do not
//    fit, the four in a row;
//  • whatever the layout, if any one word would not fit its button, no word at
//    all: the glyphs alone (✗ △ ○ ✓).
// Worked out, never tried: each layout's height is computed from one button's
// and the grid's place on the page.
//
// That place is NOT quite independent of the layout, and it froze the page
// (2026-10-30, user test, a small window): the page scrolling brings a
// scrollbar, the narrower card wraps the tune's name onto one more line, which
// pushes the buttons down; the tighter layout ends the scrolling, the
// scrollbar goes, the name takes one line less — and the looser layout seems
// to fit again. So once the buttons have been tightened for the screen's
// height, they stay so until the scrolling area's own size changes — its
// OUTER size, scrollbar included, which none of this moves (RatingFloor).

type RatingCols = 1 | 2 | 4;
type RatingFit = { cols: RatingCols; bare: boolean };

/** `gap-2`, and the buttons' `px-3` on both sides. */
const RATING_GAP = 8;
const RATING_PAD_X = 2 * 12;

/** The study screen's own choice, by the screen's width (RATING_GRID). */
function studyCols(): RatingCols {
  return window.matchMedia('(min-width: 900px)').matches ? 4
    : window.matchMedia('(min-width: 520px)').matches ? 2
    : 1;
}

/** The tightest layout already chosen for this size of the scrolling area —
 *  the layout never loosens below it while that size holds (see above). */
type RatingFloor = { size: string; cols: RatingCols };

function ratingFit(grid: HTMLElement, floor: { current: RatingFloor | null }): RatingFit {
  const button = grid.querySelector<HTMLElement>('button');
  const words = Array.from(grid.querySelectorAll<HTMLElement>('[data-rating-word]'));
  const widest = Math.max(0, ...words.map(w => w.offsetWidth));
  const bareAt = (cols: RatingCols) => widest + RATING_PAD_X + 1 > (grid.clientWidth - (cols - 1) * RATING_GAP) / cols;

  const base = studyCols();
  let cols = base;
  const scroller = scrollContainerOf(grid);
  if (button && scroller && scroller !== grid) {
    // Layout pixels throughout: rects are on-screen pixels, after the app's
    // zoom, so they are divided back by it.
    const zoom = grid.getBoundingClientRect().width / (grid.offsetWidth || 1) || 1;
    const gridRect = grid.getBoundingClientRect();
    const top = (gridRect.top - scroller.getBoundingClientRect().top) / zoom + scroller.scrollTop;
    const card = grid.closest<HTMLElement>('.detection-card');
    const below = card ? (card.getBoundingClientRect().bottom - gridRect.bottom) / zoom : 0;
    const fits = (c: RatingCols) => {
      const rows = 4 / c;
      return top + rows * button.offsetHeight + (rows - 1) * RATING_GAP + below <= scroller.clientHeight;
    };
    while (cols < 4 && !fits(cols)) cols = cols === 1 ? 2 : 4;

    const size = `${scroller.offsetWidth}x${scroller.offsetHeight}x${base}`;
    if (floor.current?.size === size) cols = Math.max(cols, floor.current.cols) as RatingCols;
    else floor.current = null;
    if (cols > base) floor.current = { size, cols };
  }
  return { cols, bare: bareAt(cols) };
}

/** The rating as the study screen gives it (2026-10-30, Focus view): the four
 *  labelled buttons, the one given ringed, another one replacing it — and the
 *  same one again taking it back, with no button of its own for that (the
 *  user's call). Same entry, same id and same instant as ReviewLogControl's —
 *  only the way of giving it differs. */
export function ReviewRatingGrid({ cardId, reviewId, ts, ctx, onRated }: {
  cardId: string;
  reviewId: string;
  ts: number | null;
  ctx: AppContext;
  onRated?: () => void;
}) {
  const [, setTick] = useState(0);
  const ratedAt = useRef(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<RatingFit>(() => ({ cols: studyCols(), bare: false }));
  const existing = ratingOf(cardId, reviewId, ts);
  const shown = !!existing || ts !== null;

  const floorRef = useRef<RatingFloor | null>(null);
  // The last resort, should any other back-and-forth be left that the floor
  // does not catch: a page frozen by a layout loop is the one failure this
  // must never cause again. Past 6 changes in a second, the layout holds
  // until the room next changes.
  const changesRef = useRef<number[]>([]);
  const heldRef = useRef(false);
  const measureRef = useRef(() => {});
  measureRef.current = () => {
    const grid = gridRef.current;
    if (!grid || heldRef.current) return;
    const next = ratingFit(grid, floorRef);
    if (next.cols === fit.cols && next.bare === fit.bare) return;
    const now = performance.now();
    changesRef.current = [...changesRef.current.filter(t => now - t < 1000), now];
    if (changesRef.current.length > 6) { heldRef.current = true; return; }
    setFit(next);
  };
  // After every render — the card above can grow or shrink with what it
  // shows — and whenever the room changes.
  useLayoutEffect(() => measureRef.current());
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const scroller = scrollContainerOf(grid);
    let size = scroller ? `${scroller.offsetWidth}x${scroller.offsetHeight}` : '';
    const ro = new ResizeObserver(() => {
      // Only the scrolling area's outer size releases a held layout.
      const now = scroller ? `${scroller.offsetWidth}x${scroller.offsetHeight}` : '';
      if (now !== size) { size = now; heldRef.current = false; changesRef.current = []; }
      measureRef.current();
    });
    ro.observe(grid);
    if (scroller && scroller !== grid) ro.observe(scroller);
    const card = grid.closest<HTMLElement>('.detection-card');
    if (card) ro.observe(card);
    for (const w of Array.from(grid.querySelectorAll<HTMLElement>('[data-rating-word]'))) ro.observe(w);
    return () => ro.disconnect();
  }, [shown]);
  if (!shown) return null;

  const rate = (rating: SessionRating) => {
    if (!existing) onRated?.();
    void giveRating(ctx, cardId, reviewId, ts, rating, existing?.rating, ratedAt).then(() => setTick(x => x + 1));
  };

  return (
    <div class="space-y-2">
      {/* The question only: tapping the given rating again to take it back
          needs no saying (the user's call). */}
      <p class="text-xs text-dim text-center">{t('study.ratingHint')}</p>
      {/* Laid out by ratingFit. */}
      <div ref={gridRef} class={`relative grid gap-2 ${fit.cols === 4 ? 'grid-cols-4' : fit.cols === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {RATING_BUTTONS.map((b) => { const { rating, key } = b; return (
          <button
            key={rating}
            // Ringed in its own colour: the one given; the others muted.
            class={`${ratingButtonClass(b, existing?.rating)} min-w-0`}
            // The one given carries its date, as the old remove button did.
            title={existing?.rating === rating ? `${t(key)} · ${fmtDateTime(existing.ts, { seconds: true })}` : t(key)}
            aria-label={t(key)}
            aria-pressed={existing ? existing.rating === rating : undefined}
            onClick={() => rate(rating)}
          >
            {/* The study screen's label, drawing and word — the drawing alone
                once the words no longer fit. */}
            <RatingLabel rating={rating} bare={fit.bare} />
          </button>
        ); })}
        {/* What ratingFit measures: each label as a button would draw it,
            drawing included. */}
        <span class="absolute w-0 h-0 overflow-hidden invisible pointer-events-none" aria-hidden="true">
          {RATING_BUTTONS.map(({ rating }) => (
            <span key={rating} data-rating-word class="block w-max whitespace-nowrap text-sm font-semibold"><RatingLabel rating={rating} /></span>
          ))}
        </span>
      </div>
    </div>
  );
}

function NavigableName({ label, tuneId, settingId, knownCardId, onOpenCard, layout }: {
  label: string; tuneId: string; settingId: string; knownCardId: string | undefined; onOpenCard?: (cardId: string) => void;
  /** On the controls' line, or on a line of its own below them — both are
   *  drawn, and the list's width shows one (styles.css, `.analysis-list`); or
   *  below and large, the Focus view's. */
  layout: 'inline' | 'below' | 'large';
}) {
  // The card's name, else TheSession's, else the recogniser's re-cased — see
  // tuneName in sessionUiShared. No CSS `capitalize` any more: it was what
  // produced "Mcgoldrick's", and each of the three sources above is already
  // cased properly.
  // A tune with no card is muted (2026-10-15, user's request): the eye picks
  // out what is already in the collection without reading the deck button.
  // Muted when there is no card — unless there is no library at all (the
  // standalone page, pageMode.ts), where every tune is shown as a known one.
  // No `block` on the line below: its display is the stylesheet's to give.
  const size = layout === 'large' ? 'block w-fit max-w-full break-words text-2xl min-[480px]:text-3xl font-bold leading-tight'
    : layout === 'below' ? 'detection-name-below w-fit max-w-full break-words text-sm font-semibold leading-snug'
    : 'detection-name-inline text-sm font-semibold truncate flex-1 min-w-0';
  const cls = `${size} ${knownCardId || !hasLibrary() ? 'text-primary' : 'text-muted'} cursor-pointer hover:text-accent transition-colors`;
  label = tuneName({ tuneId, displayName: label }).text;
  if (knownCardId) {
    return <span class={cls} title={t('sessions.openCard')} onClick={() => onOpenCard?.(knownCardId)}>{label}</span>;
  }
  // A card's own tune (cardIndex.ts) whose card is gone: no page to send it to.
  if (isCardId(tuneId)) return <span class={`${size} text-muted`}>{label}</span>;
  return (
    <a
      class={cls}
      title={t('sessions.viewOnTheSession')}
      href={`https://thesession.org/tunes/${tuneId}#setting${settingId}`}
      target="_blank"
      rel="noopener"
    >
      {label}
    </a>
  );
}

export function DetectionCard({ ann, opts }: { ann: Detection; opts: DetectionCardOptions }) {
  // Fresh state, not the snapshot captured at modal-open time: a card added a
  // second ago (onCardAdded) must flip this card to the "known" rendering.
  const user = getContext().user;
  const known = cardOfTuneId(ann.tuneId, user.cards);
  // Makes this card re-render once the cached name index has been read, so the
  // recogniser's lower-case name is replaced by TheSession's own spelling.
  useTuneNames();
  // A rating that moved to another card, after this detection's tune was
  // corrected: the container's own bump happens before that write lands, so
  // the row would otherwise keep offering its four buttons until something
  // else redrew the card.
  const [, setReviewTick] = useState(0);
  const isOpen = ann.end === null;
  // Closed, but the Viterbi decoder hasn't yet proven it can't still retract
  // or revise this one as later windows arrive (see Detection.finalized's
  // own doc) — distinct from `isOpen` (currently still the live tail) and from
  // fully finalized (never changes again). Both non-finalized states looked
  // identical to `isOpen` in the UI before 2026-08-24: a pending result showed
  // no marker at all, same as a finalized one, even though it still lacked
  // the finalized-only edit controls (extraControls, gated by the container
  // on ann.finalized).
  const pending = !isOpen && !ann.finalized;
  const playing = opts.onPlay && opts.playingId === ann.id;

  // A bound the analysis has yet to put on the tune's passes reads "about".
  const rough = opts.unrefined?.(ann);
  const from = `${rough?.start ? '~' : ''}${fmtLongTime(ann.start)}`;
  const to = ann.end === null ? '' : `${rough?.end ? '~' : ''}${fmtLongTime(ann.end)}`;
  const range = ann.end === null
    ? `${from} · ${t('sessions.inProgress')}`
    : pending
      ? `${from} – ${to} · ${t('sessions.consolidating')}`
      : `${from} – ${to}`;

  // Any detection can be rated, even one still playing (2026-10-10, group
  // feedback: rate it while it is in the ear). It is only the EDIT controls
  // that wait for `finalized`, because those act on bounds the decoder can
  // still move.
  //
  // A rating is filed where the detection ends — and a detection still playing
  // has no end yet, so it is filed at the last window that heard it, then moved
  // to the definitive end once the decoder finalizes it (ratingFollow.ts). The
  // detection it names is what finds it again, so it survives a bound edit, a
  // date change, a merge and a corrected tune alike.
  //
  // Rating CONFIRMS the detection (user's rule, 2026-10-10): it says this tune
  // was played, and that keeps the decoder from handing the stretch to another
  // tune — or retracting it — with the rating left on the wrong card.
  const reviewId = detectionReviewId(opts.sessionId, ann.id);
  const reviewTs = opts.sessionStartMs !== undefined
    ? reviewEntryTs(opts.sessionStartMs, provisionalEnd(ann))
    : null;
  // Where a rating filed before ids existed would sit — only a closed
  // detection can have one.
  const legacyTs = ann.end !== null ? reviewTs : null;
  // Read where it is needed rather than once per render: the rating row
  // redraws itself after a rating, not this card, so a value read here would
  // still say "not rated" afterwards (2026-10-10, user test).
  const isRated = () => !!known && !!ratingOf(known.id, reviewId, legacyTs);
  // A dateless session shows the row only when it already holds a rating —
  // there is one to take back, but no new one to give.
  const showReviewLog = !!known && (reviewTs !== null || isRated());
  const confirmOnRating = opts.onSelectAlternate && !ann.userConfirmed
    ? () => opts.onSelectAlternate!(ann.id, currentPick(ann))
    : undefined;

  // Read once, shown in up to three places (the two halves of the badge and
  // its aria-label) — and the dynamic key is built in exactly one spot, which
  // is what i18nKeys.test.ts counts.
  const bucketWord = t(`sessions.confidence.${ann.bucket}`);
  const confidencePct = `${Math.round(ann.confidence * 100)}%`;
  const focus = !!opts.focus;
  // Only with the "BPM" switch on (analysisView.ts) — read here, so the card
  // redraws when it is turned.
  const tempo = !analysisTempo.value ? null
    : opts.tempoOf ? opts.tempoOf(ann)
    : ann.quaverRate !== undefined ? { rate: ann.quaverRate, approx: approxTempo(ann) } : null;


  return (
    // A tune that IS a card sits on `surface`, one without stays on the page's
    // own `bg` (2026-10-15): the muted name alone was too faint in the light
    // themes. Both ways round were tried on screen and the user kept this one —
    // what is yours has substance, what is not stays flat. A neutral tone on
    // purpose: an accent tint would read as a call to attention.
    <div class={`detection-card border ${known || !hasLibrary() ? 'bg-surface' : 'bg-bg'} ${
      focus ? 'p-4 min-[480px]:p-5 rounded-xl space-y-3' : 'p-3 rounded-lg space-y-1.5'} ${isOpen ? 'border-accent/60' : 'border-border'}`} data-ann-id={ann.id} data-tour="detection">
      {/* gap-1: the play, score and deck buttons are 32 px targets around 24 px
          discs, so their own margin already spaces the drawings. */}
      <div class="flex items-center gap-1">
        {isOpen && <span class="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />}
        {pending && <span class="text-dim shrink-0" title={t('sessions.consolidating')}><HourglassIcon size={12} /></span>}

        {opts.onPlay && (() => {
          const state = { playing: !!playing, fromDrive: !!opts.playFromDrive, loading: opts.playLoadingId === ann.id };
          return <PlayDisc {...state} title={playDiscTitle(state)} onClick={() => opts.onPlay!(ann)} />;
        })()}

        <AbcPreview
          settingId={ann.settingId} displayName={ann.displayName} cardId={known?.id} ctx={opts.ctx} keyOffset={keyOffsetOf(ann)}
          audioSync={opts.follow && detectionAudioSync(opts.sessionId, ann, opts.follow.here, opts.follow.beforeOpen)}
        />

        <TuneDeckButton
          tuneId={ann.tuneId}
          ctx={opts.ctx}
          getPinnedDeckIds={opts.getPinnedDeckIds}
          onCardAdded={opts.onCardAdded}
        />

        {/* On this line, or below it on a narrow list — one rule for every
            card of the list, so that their lines stay aligned (the user's
            call, 2026-10-30). The spacer holds the line's end when the name
            is not on it. Always below in the Focus view. */}
        {!focus && <NavigableName layout="inline" label={ann.displayName} tuneId={ann.tuneId} settingId={ann.settingId} knownCardId={known?.id} onOpenCard={opts.onOpenCard} />}
        <span class={focus ? 'flex-1' : 'detection-name-spacer flex-1'} />

        {/* Two states in one control. Unconfirmed, it is the confidence badge:
            a number the algorithm is offering. Confirmed, it collapses to a
            green check — the score stops mattering once a human has vouched
            for the identity, and keeping it would invite re-reading a verdict
            that has already been given. Clicking it reopens the picker either
            way, which is also the only way back.

            The chevron is the whole point of the control being findable. A
            coloured pill holding a percentage reads as a STATUS — a user who
            wanted to correct a wrong tune reported hunting for the way in and
            finding it by accident (2026-09-09), and the instruction line that
            explains it only exists once the popover is already open. A
            disclosure caret is the one mark that says "there is more behind
            this" without a word, in any language, and it appears only when the
            picker can actually be opened. */}
        {/* The pill is the drawing; the button around it is a 32 px target —
            it opens the alternatives, and at 16 px tall it was missed. */}
        <button
          class={`group shrink-0 inline-flex items-center min-h-8 ${opts.onSelectAlternate ? 'cursor-pointer' : 'cursor-default'}`}
          title={opts.onSelectAlternate
            ? t(ann.userConfirmed ? 'sessions.alternates.confirmed' : 'sessions.alternates.trigger')
            : undefined}
          // Spelled out whatever the card's width has hidden: `display:none`
          // takes the qualifier out of the accessibility tree too, leaving a
          // bare number whose colour is the only thing saying how to read it —
          // which says nothing to a screen reader, nor to anyone who cannot
          // tell amber from green.
          aria-label={ann.userConfirmed ? t('sessions.alternates.confirmed') : `${bucketWord} ${confidencePct}`}
          onClick={opts.onSelectAlternate ? (e) => {
            e.stopPropagation();
            // The card the rating is on, if any: the one of the tune shown
            // when the picker opened.
            const ratedCard = known;
            const unrate = () => {
              if (!ratedCard) return;
              void removeRating(opts.ctx, ratedCard.id, reviewId, legacyTs).then(() => setReviewTick(x => x + 1));
            };
            showAlternatesPopover(
              ann,
              opts.getLatestDetection ? () => opts.getLatestDetection!(ann.id) : undefined,
              (pick) => {
                // BOTH read before the pick is applied. `ann` is not a
                // snapshot: the summary assigns the new identity onto this very
                // object (Object.assign on the detection it found in the
                // session), and the live and import engines do the same to
                // theirs — so a line below reads the tune that is ARRIVING,
                // never the one leaving, and the test below would compare a value
                // with itself (2026-09-23, user debugging).
                const leaving = ann.tuneId;
                const arriving = (pick ?? viterbiPickOf(ann)).tuneId;
                opts.onSelectAlternate!(ann.id, pick);
                // The rating goes whenever the TUNE changes (user's rule,
                // 2026-10-10): it said that tune was played here, and the
                // user has just said otherwise. Ticking another variant, or
                // un-ticking one the decoder had not proposed, changes it.
                // Confirming the recommendation, or un-ticking it, does not:
                // the tune shown stays the same, and so does the rating.
                //
                // This replaces moving the rating to the corrected tune's card
                // (2026-09-23): a rating given for the wrong tune says nothing
                // about how the right one was played.
                if (leaving !== arriving) unrate();
              },
              opts.onAddManualAlternate ? (tune) => opts.onAddManualAlternate!(ann.id, tune) : undefined,
              opts.onRemoveManualAlternate ? (tuneId) => {
                // Removing the hand-named tune it is confirmed as also
                // un-confirms it (manualAlternateRemovalFields), handing it
                // back to the decoder's pick — the same rule as above.
                const changesTune = ann.userConfirmed && ann.tuneId === tuneId
                  && viterbiPickOf(ann).tuneId !== tuneId;
                opts.onRemoveManualAlternate!(ann.id, tuneId);
                if (changesTune) unrate();
              } : undefined,
              isRated(),
            );
          } : undefined}
        >
          {/* Two widths, one badge. The word drops out on a narrow list (see
              .analysis-list in styles.css) — the list's width, not the card's,
              so that every card of it, in a set or not, says the same thing
              (the user's call, 2026-10-30). The badge's colour already carries
              the verdict on its own. Confirmed, there is only ever the check. */}
          <span class={`${focus ? 'text-xs px-2.5 py-1' : 'text-2xs px-1.5 py-0.5'} rounded-full inline-flex items-center gap-1 ${
            ann.userConfirmed ? 'bg-success/15 text-success' : BUCKET_BADGE[ann.bucket]
          } ${opts.onSelectAlternate ? 'group-hover:brightness-110 transition-[filter]' : ''}`}>
            {/* The check in a box one line tall (both text sizes here have a
                1rem line): a bare 12 px icon left the confirmed pill 4 px
                shorter than a percentage one beside it. */}
            {ann.userConfirmed ? <span class="h-4 inline-flex items-center"><CheckIcon size={12} /></span> : (
              <>
                {/* Siblings of the chevron rather than a wrapper around them: the
                    pill's own flex gap then simply skips the word once the
                    container query hides it, instead of spacing an empty box.
                    The percentage never hides — see .analysis-list. */}
                <span class="detection-conf-word">{bucketWord}</span>
                <span class="tabular-nums">{confidencePct}</span>
              </>
            )}
            {opts.onSelectAlternate && (
              <span class="flex items-center opacity-70"><ChevronDownIcon size={12} /></span>
            )}
          </span>
        </button>

        {/* A like goes at once, either way: nothing is lost by a tap. */}
        {opts.onToggleLike && (
          <IconButton
            label={t(ann.liked ? 'sessions.unlike' : 'sessions.like')}
            size={focus ? 'lg' : 'sm'}
            class={ann.liked ? 'text-danger hover:text-danger' : 'hover:text-danger'}
            onClick={(e) => { e.stopPropagation(); opts.onToggleLike!(ann.id); }}
          >
            <HeartIcon size={focus ? 20 : 14} filled={ann.liked} />
          </IconButton>
        )}

        {/* The note, right of the heart — lit when there is one, like the
            analysis's own notes button. Not on a detection the decoder may
            still retract or re-id (neither finalized nor confirmed): a heart
            lost that way costs a tap, a note typed there would be gone. */}
        {opts.onEditNotes && (ann.finalized || ann.userConfirmed || !!ann.notes) && (
          <IconButton
            label={t(ann.notes ? 'sessions.detection.notes.open' : 'sessions.detection.notes.add')}
            size={focus ? 'lg' : 'sm'}
            on={!!ann.notes}
            onClick={(e) => {
              e.stopPropagation();
              showDetectionNotesModal(ann.displayName, ann.notes ?? '', (notes) => opts.onEditNotes!(ann.id, notes));
            }}
          >
            <NotesIcon size={focus ? 20 : 14} />
          </IconButton>
        )}

        {/* Beside the heart, at the end of the row that carries this
            detection's identity — which is what deleting it is about. It used
            to sit alone on a row of its own below (2026-09-20). Red: a
            detection is costly to redo, so the summary asks first — and the red is
            the question's: a bin on a ROW of a list stays neutral, red under the
            pointer, or every card of the list would carry a red tile. */}
        {opts.onDelete && (
          <IconButton
            label={t('common.delete')}
            class="hover:text-danger"
            onClick={(e) => { e.stopPropagation(); opts.onDelete!(); }}
          >
            <TrashIcon size={14} />
          </IconButton>
        )}
      </div>

      <NavigableName layout={focus ? 'large' : 'below'} label={ann.displayName} tuneId={ann.tuneId} settingId={ann.settingId} knownCardId={known?.id} onOpenCard={opts.onOpenCard} />
      {focus && opts.focusNote && <div class="flex">{opts.focusNote}</div>}

      {opts.details !== false && <div class={`${focus ? 'text-sm' : 'text-xs'} text-muted flex items-center gap-1.5 flex-wrap`}>
        {/* No meter (2026-10-28, the user's call): a reel's 4/4 and a jig's
            6/8 are in the dance's name already. */}
        <span><TuneFacts dance={ann.dance} settingId={hasRecognisedSetting(ann) ? ann.settingId : undefined} keyOffset={keyOffsetOf(ann)} /> ·</span>
        {opts.onEditBounds ? (
          // The framed box is the drawing; the button around it the 32 px target.
          <button
            class="group inline-flex items-center min-h-8 cursor-pointer"
            title={t('sessions.bounds.edit')}
            onClick={(e) => { e.stopPropagation(); opts.onEditBounds!(); }}
          >
            <span class="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 font-mono tabular-nums text-muted group-hover:border-accent group-hover:text-primary transition-colors">
              <span>{range}</span>
              <span class="text-dim group-hover:text-accent flex items-center transition-colors"><PencilIcon size={12} /></span>
            </span>
          </button>
        ) : (
          <span>{range}</span>
        )}
        {/* The tempo it was played at, in the beat of the tune shown — after
            the times, as a fact about this stretch of recording (2026-11-01).
            Nothing where too little pulse was heard. */}
        {tempo !== null && <span class="tabular-nums">·{' '}
          {opts.onTempo ? (
            <button
              class="tabular-nums min-h-8 inline-flex items-center hover:text-accent transition-colors cursor-pointer"
              title={t('sessions.tempo.detection.open')}
              onClick={(e) => { e.stopPropagation(); opts.onTempo!(ann); }}
            >{tempoText(tempo.rate, ann, tempo.approx)}</button>
          ) : tempoText(tempo.rate, ann, tempo.approx)}
        </span>}
        {/* Pushed to the far end of the same line: cutting a clip is an act on
            this stretch of recording, so it belongs beside the times that
            define it rather than on a row of its own (2026-09-20). */}
        {opts.metaActions && <span class="ml-auto flex items-center gap-1.5">{opts.metaActions()}</span>}
      </div>}

      {showReviewLog && opts.study !== false && (focus ? (
        <div class="pt-2">
          <ReviewRatingGrid cardId={known!.id} reviewId={reviewId} ts={reviewTs} ctx={opts.ctx} onRated={confirmOnRating} />
        </div>
      ) : (
        <div class="flex items-center gap-3 flex-wrap">
          <ReviewLogControl cardId={known!.id} reviewId={reviewId} ts={reviewTs} ctx={opts.ctx} onRated={confirmOnRating} />
        </div>
      ))}

      {opts.extraControls?.()}
    </div>
  );
}
