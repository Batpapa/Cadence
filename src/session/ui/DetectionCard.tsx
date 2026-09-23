import { useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';
import type { AppContext, SessionRating } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon, HourglassIcon, ChevronDownIcon, PencilIcon, TrashIcon } from '../../components/icons';
import { playIcon, pauseIcon } from '../../components/playbackIcons';
import { findByExternalId } from '../../services/theSessionService';
import { AbcPreview } from './abcPreview';
import { showAlternatesPopover } from './AlternatesPopover';
import { BUCKET_BADGE, tuneName, useTuneNames, TuneDeckButton, transferReviewEntry } from './sessionUiShared';
import { getContext } from '../../store';
import { viterbiPickOf, type Detection, type DetectionAlternate } from '../model';
import { reviewEntryIndex } from '../../services/reviewEntries';
import { detectionReviewId, reviewEntryTs } from '../reviewLink';

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
   *  Choosing anything is only allowed once the detection is finalized
   *  (see the picker's own doc) — requires `getLatestDetection` too. */
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

const RATING_GLYPHS: Array<{ rating: SessionRating; glyph: string; cls: string; labelKey: string }> = [
  { rating: 'again', glyph: '✗', cls: 'text-danger',  labelKey: 'rating.again' },
  { rating: 'hard',  glyph: '△', cls: 'text-warn',    labelKey: 'rating.hard' },
  { rating: 'good',  glyph: '○', cls: 'text-accent',  labelKey: 'rating.good' },
  { rating: 'easy',  glyph: '✓', cls: 'text-success', labelKey: 'rating.easy' },
];

/** The rating this detection carries, if any. Read from live state, so the
 *  card and the control below always agree on whether there is one. */
function ratingOf(cardId: string, reviewId: string, ts: number | null) {
  const user = getContext().user;
  const history = user.cardWorks[`${user.currentProfileId}:${cardId}`]?.history ?? [];
  const at = reviewEntryIndex(history, reviewId, ts);
  return at === -1 ? undefined : history[at];
}

function ReviewLogControl({ cardId, reviewId, ts, ctx }: {
  cardId: string;
  /** What this rating is filed under — opaque to the card's history, built by
   *  this module (reviewLink.ts). */
  reviewId: string;
  /** Null when the session has no date: nothing new can be filed, since the
   *  instant is the rating's only place in time. */
  ts: number | null;
  ctx: AppContext;
}) {
  // Local re-render trigger after a mutation — mirrors the original's
  // `.then(render)` self-refresh exactly (not signal-driven): this card tree
  // is mounted into a detached node by the bridge below, outside the app's
  // main reactive tree, so nothing else would re-render it automatically.
  const [, setTick] = useState(0);
  const existing = ratingOf(cardId, reviewId, ts);

  if (existing) {
    const glyph = RATING_GLYPHS.find(r => r.rating === existing.rating);
    return (
      <span class="inline-flex items-center gap-1.5">
        <button
          class="text-xs text-muted cursor-pointer inline-flex items-center gap-1 hover:text-danger"
          title={new Date(existing.ts).toLocaleString()}
          onClick={() => {
            void ctx.mutate(s => {
              const h = s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history;
              if (!h) return;
              const i = reviewEntryIndex(h, reviewId, ts);
              if (i !== -1) h.splice(i, 1);
            }).then(() => setTick(x => x + 1));
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

  return (
    <span class="inline-flex items-center gap-1.5">
      <span class="text-xs text-dim">{t('sessions.review.log')}</span>
      {RATING_GLYPHS.map(({ rating, glyph, cls, labelKey }) => (
        <button
          key={rating}
          class={`text-xs cursor-pointer transition-transform hover:scale-125 ${cls}`}
          title={t(labelKey)}
          onClick={() => {
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
  );
}

function NavigableName({ label, tuneId, settingId, knownCardId, onOpenCard }: {
  label: string; tuneId: string; settingId: string; knownCardId: string | undefined; onOpenCard?: (cardId: string) => void;
}) {
  // The card's name, else TheSession's, else the recogniser's re-cased — see
  // tuneName in sessionUiShared. No CSS `capitalize` any more: it was what
  // produced "Mcgoldrick's", and each of the three sources above is already
  // cased properly.
  const cls = 'text-sm font-semibold text-primary truncate flex-1 cursor-pointer hover:text-accent transition-colors';
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

  // Closed is enough — a detection still consolidating gets the rating
  // buttons too (2026-09-20, user request). It is only the EDIT controls that
  // wait for `finalized`, because those act on bounds the decoder can still
  // move; having played the tune is already true the moment it closes.
  //
  // The rating's instant follows the detection's end (repinReviewEntry), and
  // the detection it names is what finds it again — so a rating survives a
  // bound edit, a date change, a merge and a corrected tune alike. The card
  // still needs an end: that is what "the tune was played" is measured from.
  const reviewId = detectionReviewId(opts.sessionId, ann.id);
  const reviewTs = opts.sessionStartMs !== undefined && ann.end !== null
    ? reviewEntryTs(opts.sessionStartMs, ann.end)
    : null;
  // A dateless session shows the row only when it already holds a rating —
  // there is one to take back, but no new one to give.
  const showReviewLog = !!known && ann.end !== null
    && (reviewTs !== null || !!ratingOf(known.id, reviewId, null));

  // Read once, shown in up to three places (the two halves of the badge and
  // its aria-label) — and the dynamic key is built in exactly one spot, which
  // is what i18nKeys.test.ts counts.
  const bucketWord = t(`sessions.confidence.${ann.bucket}`);
  const confidencePct = `${Math.round(ann.confidence * 100)}%`;

  return (
    <div class={`detection-card p-3 rounded-lg border bg-bg space-y-1.5 ${isOpen ? 'border-accent/60' : 'border-border'}`} data-ann-id={ann.id}>
      <div class="flex items-center gap-2">
        {isOpen && <span class="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />}
        {pending && <span class="text-dim shrink-0" title={t('sessions.consolidating')}><HourglassIcon size={12} /></span>}

        {opts.onPlay && (
          <button
            class={`w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
              playing ? 'bg-accent text-white' : 'bg-accent/10 text-accent hover:bg-accent/20'}`}
            title={t('sessions.playSlice')}
            dangerouslySetInnerHTML={{ __html: playing ? pauseIcon(10) : playIcon(10) }}
            onClick={(e) => { e.stopPropagation(); opts.onPlay!(ann); }}
          />
        )}

        <AbcPreview settingId={ann.settingId} displayName={ann.displayName} cardId={known?.id} ctx={opts.ctx} />

        <TuneDeckButton
          tuneId={ann.tuneId}
          ctx={opts.ctx}
          getPinnedDeckIds={opts.getPinnedDeckIds}
          onCardAdded={opts.onCardAdded}
        />

        <NavigableName label={ann.displayName} tuneId={ann.tuneId} settingId={ann.settingId} knownCardId={known?.id} onOpenCard={opts.onOpenCard} />

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
          class={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 inline-flex items-center gap-1 ${
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
            showAlternatesPopover(
              ann,
              opts.getLatestDetection ? () => opts.getLatestDetection!(ann.id) : undefined,
              (pick) => {
                // BOTH read before the pick is applied. `ann` is not a
                // snapshot: the summary assigns the new identity onto this very
                // object (Object.assign on the detection it found in the
                // session), and the live and import engines do the same to
                // theirs — so a line below reads the tune that is ARRIVING,
                // never the one leaving, and the transfer would compare a value
                // with itself (2026-09-23, user debugging).
                const leaving = ann.tuneId;
                const arriving = (pick ?? viterbiPickOf(ann)).tuneId;
                opts.onSelectAlternate!(ann.id, pick);
                // A rating lives in the history of the CARD this detection
                // points at, so correcting the tune moves it to another card —
                // otherwise it stays credited to the one the recogniser got
                // wrong, and the corrected tune offers to be rated afresh
                // (2026-09-23, user report). `null` hands the detection back to
                // the decoder, whose own pick is then the tune.
                void transferReviewEntry(opts.ctx, reviewId, leaving, arriving, reviewTs)
                  .then(moved => { if (moved) setReviewTick(x => x + 1); });
              },
              opts.onAddManualAlternate ? (tune) => opts.onAddManualAlternate!(ann.id, tune) : undefined,
              opts.onRemoveManualAlternate ? (tuneId) => opts.onRemoveManualAlternate!(ann.id, tuneId) : undefined,
            );
          } : undefined}
        >
          {/* Three widths, one badge. The word and the number drop out in turn
              as the card narrows (see .detection-card in styles.css) so the
              tune's NAME keeps the room — it is the thing being read, and the
              badge's colour already carries the verdict on its own. Confirmed,
              there is only ever the check. */}
          {ann.userConfirmed ? <span>✓</span> : (
            <>
              {/* Siblings of the chevron rather than a wrapper around them: the
                  button's own flex gap then simply skips the word once the
                  container query hides it, instead of spacing an empty box.
                  The percentage never hides — see .detection-card. */}
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
            <HeartIcon size={13} filled={ann.liked} />
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

      <div class="text-xs text-muted flex items-center gap-1.5 flex-wrap">
        <span>{ann.dance} · {ann.meter} ·</span>
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
      </div>

      {showReviewLog && (
        <div class="flex items-center gap-3 flex-wrap">
          <ReviewLogControl cardId={known!.id} reviewId={reviewId} ts={reviewTs} ctx={opts.ctx} />
        </div>
      )}

      {opts.extraControls?.()}
    </div>
  );
}
