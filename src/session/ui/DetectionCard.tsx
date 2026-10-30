import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';
import type { AppContext, SessionRating } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon, HourglassIcon, ChevronDownIcon, PencilIcon, TrashIcon } from '../../components/icons';
import { findByExternalId } from '../../services/theSessionService';
import { hasLibrary } from '../../services/pageMode';
import { AbcPreview, TuneFacts } from './abcPreview';
import { PlayDisc, playDiscTitle, detectionPlayAlong } from './PassRow';
import { showAlternatesPopover } from './AlternatesPopover';
import { BUCKET_BADGE, tuneName, useTuneNames, TuneDeckButton } from './sessionUiShared';
import { getContext } from '../../store';
import { viterbiPickOf, hasRecognisedSetting, type Detection, type DetectionAlternate } from '../model';
import { reviewEntryIndex } from '../../services/reviewEntries';
import { detectionReviewId, reviewEntryTs } from '../reviewLink';
import { currentPick, provisionalEnd } from '../detectionState';
import { fmtDateTime } from '../../services/dateFormat';
import { RATING_BUTTONS } from '../../components/ratingButtons';
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
  playingId?: string | null;
  /** The recording is only on Drive: the ▶ wears a small cloud, and the
   *  passage is played straight from there (2026-10-10) — the same button as
   *  the lists of passes (PassRow.tsx's PlayDisc). */
  playFromDrive?: boolean;
  /** The detection whose passage is on its way from Drive. */
  playLoadingId?: string | null;
  /** The score viewer's "Play along" with this recording (PassRow.tsx's
   *  detectionPlayAlong). Only on a saved analysis: the feeds' recording is
   *  still being written. */
  follow?: {
    /** The recording is on this device; otherwise it is read from Drive, if
     *  it is there. */
    here: boolean;
    /** Silences the screen's own player when it is turned on. */
    beforeOpen?: () => void;
  };
  /** The meta line — dance, mode, times, and `metaActions` — under the name.
   *  Default true; the analysis's simple view leaves it out (analysisView.ts). */
  details?: boolean;
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
// already filed: when one is found, the four rating buttons give way to a
// single remove control. The instant alone used to do that job — see
// services/reviewEntries.ts for everything that broke while it did.

// `btn` is the tint the study screen's rating buttons use. These used to be
// the bare glyphs at text-xs, about 12 px wide — too small to hit with a
// finger while playing in a session (2026-10-08, group feedback). Each glyph
// now sits on a tinted circle the size of the card's play, score and add
// buttons above it — bigger read as out of place there (user's call).
const RATING_GLYPHS: Array<{ rating: SessionRating; glyph: string; cls: string; btn: string; labelKey: string }> = [
  { rating: 'again', glyph: '✗', cls: 'text-danger',  btn: 'bg-danger/10 hover:bg-danger/20 text-danger',    labelKey: 'rating.again' },
  { rating: 'hard',  glyph: '△', cls: 'text-warn',    btn: 'bg-warn/10 hover:bg-warn/20 text-warn',          labelKey: 'rating.hard' },
  { rating: 'good',  glyph: '○', cls: 'text-accent',  btn: 'bg-accent/10 hover:bg-accent/20 text-accent',    labelKey: 'rating.good' },
  { rating: 'easy',  glyph: '✓', cls: 'text-success', btn: 'bg-success/10 hover:bg-success/20 text-success', labelKey: 'rating.easy' },
];

/** A rating's glyph alone — the Focus view's buttons once their words go. */
const glyphOf = (rating: SessionRating) => RATING_GLYPHS.find(g => g.rating === rating)?.glyph ?? '';

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

  if (existing) {
    const glyph = RATING_GLYPHS.find(r => r.rating === existing.rating);
    return (
      <span class="inline-flex items-center gap-1.5">
        <button
          class="text-xs text-muted cursor-pointer inline-flex items-center gap-1 min-h-8 hover:text-danger"
          title={fmtDateTime(existing.ts, { seconds: true })}
          onClick={() => {
            if (Date.now() - ratedAt.current < REMOVE_GUARD_MS) return;
            void removeRating(ctx, cardId, reviewId, ts).then(() => setTick(x => x + 1));
          }}
        >
          <span class={glyph?.cls ?? ''}>{glyph?.glyph ?? ''}</span>
          <span class="hover:underline">{t('sessions.review.remove')}</span>
        </button>
      </span>
    );
  }

  // Nothing to offer: no instant means no place in time to file a rating at.
  // The card's own history is where one can still be added by hand.
  if (ts === null) return null;

  // The glyph alone, its name in the tooltip: a row of four labelled buttons
  // was tried and outweighed the card itself (2026-10-09, user's call).
  return (
    <span class="inline-flex items-center gap-1.5">
      <span class="text-xs text-dim">{t('sessions.review.log')}</span>
      <span class="inline-flex items-center gap-1">
        {RATING_GLYPHS.map(({ rating, glyph, btn, labelKey }) => (
          <button
            key={rating}
            class={`w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 text-xs cursor-pointer transition-colors ${btn}`}
            title={t(labelKey)}
            aria-label={t(labelKey)}
            onClick={() => {
              ratedAt.current = Date.now();
              onRated?.();
              void ctx.mutate(s => {
                const key = `${s.currentProfileId}:${cardId}`;
                if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId, history: [] };
                s.cardWorks[key]!.history.push({ ts, rating, id: reviewId });
                s.cardWorks[key]!.history.sort((a, b) => a.ts - b.ts);
              }).then(() => setTick(x => x + 1));
            }}
          >
            {glyph}
          </button>
        ))}
      </span>
    </span>
  );
}

/** The rating as the study screen gives it (2026-10-30, Focus view): the four
 *  labelled buttons, the one given ringed, another one replacing it, and its
 *  own button to take it back. Same entry, same id and same instant as
 *  ReviewLogControl's — only the way of giving it differs. */
export function ReviewRatingGrid({ cardId, reviewId, ts, ctx, onRated }: {
  cardId: string;
  reviewId: string;
  ts: number | null;
  ctx: AppContext;
  onRated?: () => void;
}) {
  const [, setTick] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const [bare, setBare] = useState(false);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const words = Array.from(grid.querySelectorAll<HTMLElement>('[data-rating-word]'));
    const measure = () => {
      // A quarter of the row, less the gaps; a word plus the buttons' `px-3`.
      const each = (grid.clientWidth - 3 * 8) / 4;
      const need = Math.max(...words.map(w => w.offsetWidth)) + 2 * 12 + 1;
      setBare(need > each);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    for (const w of words) ro.observe(w);
    return () => ro.disconnect();
  });
  const existing = ratingOf(cardId, reviewId, ts);
  if (!existing && ts === null) return null;

  const rate = (rating: SessionRating) => {
    if (existing?.rating === rating) return;
    if (!existing) onRated?.();
    void ctx.mutate(s => {
      const key = `${s.currentProfileId}:${cardId}`;
      if (!s.cardWorks[key]) s.cardWorks[key] = { profileId: s.currentProfileId, cardId, history: [] };
      const h = s.cardWorks[key]!.history;
      const i = reviewEntryIndex(h, reviewId, ts);
      if (i !== -1) { h[i]!.rating = rating; return; }
      if (ts === null) return;
      h.push({ ts, rating, id: reviewId });
      h.sort((a, b) => a.ts - b.ts);
    }).then(() => setTick(x => x + 1));
  };

  return (
    <div class="space-y-2">
      <p class="text-xs text-dim text-center">{t(existing ? 'study.ratedHint' : 'study.ratingHint')}</p>
      {/* Always the four in a row (2026-10-30, the user's call); their words
          go — all at once, the glyphs staying — when any one of them would
          no longer fit its quarter. Measured on the words' natural widths
          (the twins below), never on what is shown, so it cannot flip. */}
      <div ref={gridRef} class="relative grid grid-cols-4 gap-2">
        {RATING_BUTTONS.map(({ rating, key, cls }) => (
          <button
            key={rating}
            class={`${cls} min-w-0 ${existing?.rating === rating ? 'ring-2 ring-current' : ''}`}
            title={t(key)}
            aria-label={t(key)}
            aria-pressed={existing ? existing.rating === rating : undefined}
            onClick={() => rate(rating)}
          >
            {bare ? glyphOf(rating) : t(key)}
          </button>
        ))}
        <span class="absolute w-0 h-0 overflow-hidden invisible pointer-events-none" aria-hidden="true">
          {RATING_BUTTONS.map(({ rating, key }) => (
            <span key={rating} data-rating-word class="block w-max whitespace-nowrap text-sm font-semibold">{t(key)}</span>
          ))}
        </span>
      </div>
      {existing && (
        <button
          class="btn-ghost py-1.5 text-xs w-full text-danger hover:text-danger"
          title={fmtDateTime(existing.ts, { seconds: true })}
          onClick={() => { void removeRating(ctx, cardId, reviewId, ts).then(() => setTick(x => x + 1)); }}
        >
          {t('study.deleteReview')}
        </button>
      )}
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
  const known = findByExternalId(`thesession:${ann.tuneId}`, user.cards);
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

  const range = ann.end === null
    ? `${fmtLongTime(ann.start)} · ${t('sessions.inProgress')}`
    : pending
      ? `${fmtLongTime(ann.start)} – ${fmtLongTime(ann.end)} · ${t('sessions.consolidating')}`
      : `${fmtLongTime(ann.start)} – ${fmtLongTime(ann.end)}`;

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


  return (
    // A tune that IS a card sits on `surface`, one without stays on the page's
    // own `bg` (2026-10-15): the muted name alone was too faint in the light
    // themes. Both ways round were tried on screen and the user kept this one —
    // what is yours has substance, what is not stays flat. A neutral tone on
    // purpose: an accent tint would read as a call to attention.
    <div class={`detection-card border ${known || !hasLibrary() ? 'bg-surface' : 'bg-bg'} ${
      focus ? 'p-4 min-[480px]:p-5 rounded-xl space-y-3' : 'p-3 rounded-lg space-y-1.5'} ${isOpen ? 'border-accent/60' : 'border-border'}`} data-ann-id={ann.id} data-tour="detection">
      <div class="flex items-center gap-2">
        {isOpen && <span class="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />}
        {pending && <span class="text-dim shrink-0" title={t('sessions.consolidating')}><HourglassIcon size={12} /></span>}

        {opts.onPlay && (() => {
          const state = { playing: !!playing, fromDrive: !!opts.playFromDrive, loading: opts.playLoadingId === ann.id };
          return <PlayDisc {...state} title={playDiscTitle(state)} onClick={() => opts.onPlay!(ann)} />;
        })()}

        <AbcPreview
          settingId={ann.settingId} displayName={ann.displayName} cardId={known?.id} ctx={opts.ctx}
          playAlong={opts.follow && detectionPlayAlong(opts.sessionId, ann, opts.follow.here, opts.follow.beforeOpen)}
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
        <button
          class={`${focus ? 'text-xs px-2.5 py-1' : 'text-[10px] px-1.5 py-0.5'} rounded-full shrink-0 inline-flex items-center gap-1 ${
            ann.userConfirmed ? 'bg-success/15 text-success' : BUCKET_BADGE[ann.bucket]
          } ${opts.onSelectAlternate ? 'cursor-pointer hover:brightness-110 transition-[filter]' : 'cursor-default'}`}
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
          {ann.userConfirmed ? <span>✓</span> : (
            <>
              {/* Siblings of the chevron rather than a wrapper around them: the
                  button's own flex gap then simply skips the word once the
                  container query hides it, instead of spacing an empty box.
                  The percentage never hides — see .analysis-list. */}
              <span class="detection-conf-word">{bucketWord}</span>
              <span class="tabular-nums">{confidencePct}</span>
            </>
          )}
          {opts.onSelectAlternate && (
            <span class="flex items-center opacity-70"><ChevronDownIcon size={9} /></span>
          )}
        </button>

        {opts.onToggleLike && (
          <button
            class={`shrink-0 cursor-pointer transition-colors ${ann.liked ? 'text-danger' : 'text-dim hover:text-danger'}`}
            title={t(ann.liked ? 'sessions.unlike' : 'sessions.like')}
            onClick={(e) => { e.stopPropagation(); opts.onToggleLike!(ann.id); }}
          >
            <HeartIcon size={focus ? 20 : 13} filled={ann.liked} />
          </button>
        )}

        {/* Beside the heart, at the end of the row that carries this
            detection's identity — which is what deleting it is about. It used
            to sit alone on a row of its own below (2026-09-20). */}
        {opts.onDelete && (
          <button
            class="shrink-0 text-dim hover:text-danger transition-colors cursor-pointer"
            title={t('common.delete')}
            onClick={(e) => { e.stopPropagation(); opts.onDelete!(); }}
          >
            <TrashIcon size={12} />
          </button>
        )}
      </div>

      <NavigableName layout={focus ? 'large' : 'below'} label={ann.displayName} tuneId={ann.tuneId} settingId={ann.settingId} knownCardId={known?.id} onOpenCard={opts.onOpenCard} />
      {focus && opts.focusNote && <div class="flex">{opts.focusNote}</div>}

      {opts.details !== false && <div class={`${focus ? 'text-sm' : 'text-xs'} text-muted flex items-center gap-1.5 flex-wrap`}>
        {/* No meter (2026-10-28, the user's call): a reel's 4/4 and a jig's
            6/8 are in the dance's name already. */}
        <span><TuneFacts dance={ann.dance} settingId={hasRecognisedSetting(ann) ? ann.settingId : undefined} /> ·</span>
        {opts.onEditBounds ? (
          <button
            class="inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 font-mono tabular-nums text-muted hover:border-accent hover:text-primary transition-colors cursor-pointer group"
            title={t('sessions.bounds.edit')}
            onClick={(e) => { e.stopPropagation(); opts.onEditBounds!(); }}
          >
            <span>{range}</span>
            <span class="text-dim group-hover:text-accent flex items-center transition-colors"><PencilIcon size={10} /></span>
          </button>
        ) : (
          <span>{range}</span>
        )}
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
