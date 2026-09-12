import { useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';
import type { AppContext, SessionRating } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon, HourglassIcon, ChevronDownIcon } from '../../components/icons';
import { playIcon, pauseIcon } from '../../components/playbackIcons';
import { findByExternalId } from '../../services/theSessionService';
import { AbcPreview } from './abcPreview';
import { showAlternatesPopover } from './AlternatesPopover';
import { BUCKET_BADGE, tuneName, useTuneNames, TuneDeckButton } from './sessionUiShared';
import { getContext } from '../../store';
import type { Detection, DetectionAlternate } from '../model';

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
  /** Unix ms of the session's t=0. When set, closed annotations of known cards
   *  get the "log this as a review" control (summary + live feed; the import
   *  feed has no date until the user sets one in the summary). */
  sessionStartMs?: number;
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
// time, in the same history the card view and FSRS read. The exact timestamp
// doubles as the marker that this detection was already logged: when an entry
// exists at that instant the four rating buttons are replaced by a single
// remove control.

const RATING_GLYPHS: Array<{ rating: SessionRating; glyph: string; cls: string; labelKey: string }> = [
  { rating: 'again', glyph: '✗', cls: 'text-danger',  labelKey: 'rating.again' },
  { rating: 'hard',  glyph: '△', cls: 'text-warn',    labelKey: 'rating.hard' },
  { rating: 'good',  glyph: '○', cls: 'text-accent',  labelKey: 'rating.good' },
  { rating: 'easy',  glyph: '✓', cls: 'text-success', labelKey: 'rating.easy' },
];

function ReviewLogControl({ cardId, ts, ctx }: { cardId: string; ts: number; ctx: AppContext }) {
  // Local re-render trigger after a mutation — mirrors the original's
  // `.then(render)` self-refresh exactly (not signal-driven): this card tree
  // is mounted into a detached node by the bridge below, outside the app's
  // main reactive tree, so nothing else would re-render it automatically.
  const [, setTick] = useState(0);
  const user = getContext().user;
  const existing = user.cardWorks[`${user.currentProfileId}:${cardId}`]?.history.find(e => e.ts === ts);

  if (existing) {
    const glyph = RATING_GLYPHS.find(r => r.rating === existing.rating);
    return (
      <span class="inline-flex items-center gap-1.5">
        <button
          class="text-xs text-muted cursor-pointer inline-flex items-center gap-1 hover:text-danger"
          title={new Date(ts).toLocaleString()}
          onClick={() => {
            void ctx.mutate(s => {
              const h = s.cardWorks[`${s.currentProfileId}:${cardId}`]?.history;
              const i = h?.findIndex(e => e.ts === ts) ?? -1;
              if (h && i !== -1) h.splice(i, 1);
            }).then(() => setTick(x => x + 1));
          }}
        >
          <span class={glyph?.cls ?? ''}>{glyph?.glyph ?? ''}</span>
          <span class="hover:underline">{t('sessions.review.remove')}</span>
        </button>
      </span>
    );
  }

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
              s.cardWorks[key]!.history.push({ ts, rating });
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

  const showReviewLog = known && opts.sessionStartMs !== undefined && ann.end !== null;

  return (
    <div class={`p-3 rounded-lg border bg-bg space-y-1.5 ${isOpen ? 'border-accent/60' : 'border-border'}`} data-ann-id={ann.id}>
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
          onClick={opts.onSelectAlternate ? (e) => {
            e.stopPropagation();
            showAlternatesPopover(
              ann,
              opts.getLatestDetection ? () => opts.getLatestDetection!(ann.id) : undefined,
              (pick) => opts.onSelectAlternate!(ann.id, pick),
            );
          } : undefined}
        >
          <span>{ann.userConfirmed ? '✓' : `${t(`sessions.confidence.${ann.bucket}`)} ${Math.round(ann.confidence * 100)}%`}</span>
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
      </div>

      <div class="text-xs text-muted">{ann.dance} · {ann.meter} · {range}</div>

      {showReviewLog && (
        <div class="flex items-center gap-3 flex-wrap">
          <ReviewLogControl cardId={known!.id} ts={opts.sessionStartMs! + ann.end! * 1000} ctx={opts.ctx} />
        </div>
      )}

      {opts.extraControls?.()}
    </div>
  );
}
