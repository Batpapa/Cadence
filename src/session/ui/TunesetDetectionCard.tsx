import { useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon, HourglassIcon, TuneSetIcon } from '../../components/icons';
import { getContext } from '../../store';
import { hasRecognisedSetting, type Detection, type TunesetRecord } from '../model';
import { setCardFor, chainSpan, isSettled } from '../tunesets';
import { hasLibrary } from '../../services/pageMode';
import { experimentalSets } from '../detections';
import { HeardSetAbc } from './abcPreview';
import { PlayDisc, playDiscTitle } from './PassRow';
import { ReviewLogControl, ratingOf } from './DetectionCard';
import { fmtLongTime, tuneName, type ClipSessionRef } from './sessionUiShared';
import { SetClipControls, TunesetDeckButton, setReviewId } from './tunesetShared';
import { reviewEntryTs } from '../reviewLink';
import { TUNESET_NAME_SEPARATOR } from '../../services/stateNormalise';
import { withChains, type ListAnn, type ListChain, type ListGap } from './timelineModel';
import { FeedSilence, setRows, withCutMark, type SetOpens } from './setBreaks';
// ── A set heard in an analysis (2026-10-19) ──────────────────────────────────
// Shaped like a detection and holding its detections, shown as they are —
// "detections inside a detection" (the user's design). A set here is only a
// chain: tunes played with no silence between them (timelineModel.ts). So it
// has no score of its own (the pill says "Set" where a tune shows its %), and
// no bounds of its own to edit: its span is its tunes', moved through theirs.

export interface TunesetCardOptions {
  ctx: AppContext;
  session: ClipSessionRef;
  /** Its entry in the analysis's table — none while the set is still being
   *  decoded, or on the live and import feeds, which keep no table: then the
   *  set can be read and heard, and nothing else. */
  record?: TunesetRecord;
  onOpenCard?: (cardId: string) => void;
  getPinnedDeckIds?: () => Set<string>;
  /** After anything this card wrote to the user blob. */
  onChanged?: () => void;
  onPlay?: (chain: Detection[]) => void;
  playingId?: string | null;
  playFromDrive?: boolean;
  playLoadingId?: string | null;
  onToggleLike?: (record: TunesetRecord) => void;
  /** Unix ms of the session's t=0 — what a rating is filed against. */
  sessionStartMs?: number;
  /** Where the clip controls go — absent on the feeds, which have none. */
  clip?: { audioAvailable: boolean; getAudio: () => Promise<Blob | undefined> };
  /** The span line and its clip controls. Default true; the analysis's simple
   *  view leaves it out, as it does its tunes' (analysisView.ts). */
  details?: boolean;
  /** The review row. Default true; the analysis's "Study" switch. */
  study?: boolean;
}

/** A live or import feed's list: tunes alone and sets. The sets are the
 *  summary's very rule (withChains), measured against the furthest point heard
 *  so far. A feed never had silence rows: it shows only those a set could be
 *  carried on across — small, for the link (2026-10-20). */
type FeedItem = ListAnn | ListChain | ListGap;

export function feedItems(anns: Detection[]): { duration: number; items: FeedItem[] } {
  const duration = anns.reduce((m, a) => Math.max(m, a.end ?? a.start), 0);
  // With the sets turned off in the module's settings, the feed is the flat
  // list it always was.
  if (!experimentalSets(getContext().user)) return { duration, items: anns.map((ann, i) => ({ kind: 'ann', ann, i, cut: false })) };
  return { duration, items: withChains(anns, duration).filter(x => x.kind !== 'gap' || !!x.nextId) };
}

/** A feed, its marks and the controls that set them — the same for a live
 *  recording and an import. The screen draws each tune and each set.
 *  No `onSetOpens`, no controls: a feed outside the editor view
 *  (analysisView.ts), as the finished analysis does it. */
export function FeedList({ feed, renderAnn, renderSet, onSetOpens }: {
  feed: ReturnType<typeof feedItems>;
  renderAnn: (ann: Detection) => ComponentChild;
  renderSet: (chain: Detection[], children: ComponentChild) => ComponentChild;
  onSetOpens?: SetOpens;
}) {
  const silence = (g: ListGap, linked: boolean) => (
    <FeedSilence key={`gap-${g.from}`} len={g.len} linked={linked} onSetOpens={onSetOpens && ((o) => onSetOpens(g.nextId!, o))} />
  );
  return (
    <>
      {feed.items.map(item => {
        if (item.kind === 'gap') return silence(item, false);
        const node = item.kind === 'ann'
          ? renderAnn(item.ann)
          : renderSet(item.members.map(m => m.ann), setRows(item.rows, r => renderAnn(r.ann), g => silence(g, true), onSetOpens));
        return onSetOpens ? withCutMark(item, node, onSetOpens) : node;
      })}
    </>
  );
}

/** A feed's sets, each as its detections — what the Focus view names. */
export function feedChains(feed: ReturnType<typeof feedItems>): Detection[][] {
  return feed.items
    .filter((x): x is ListChain => x.kind === 'chain')
    .map(x => x.members.map(m => m.ann));
}

/** The id the set plays under, in whichever player plays it. */
export function chainPlayId(chain: readonly Detection[]): string {
  return `set:${chain[0]?.id ?? ''}`;
}

export function TunesetDetectionCard({ chain, opts, children }: {
  chain: Detection[];
  opts: TunesetCardOptions;
  /** The tunes' own cards, rendered by the screen exactly as it renders any. */
  children: ComponentChild;
}) {
  const [missing, setMissing] = useState<string[] | null>(null);
  const user = getContext().user;
  const tuneIds = chain.map(d => d.tuneId);
  const setCard = setCardFor(tuneIds, user.cards);
  // Settled = every tune closed and finalized: enough to create the set card
  // or cut its clip. The heart and the review need more — the set's entry in
  // the analysis's table, which only a saved analysis has.
  const settled = isSettled(chain);
  const tracked = settled && !!opts.record;
  const open = chain.some(d => d.end === null);
  const pending = !open && !isSettled(chain);
  const span = chainSpan(chain, opts.session.duration);
  const names = chain.map(d => tuneName(d).text);
  const name = setCard?.name ?? names.join(TUNESET_NAME_SEPARATOR);

  const range = open
    ? `${fmtLongTime(span.start)} · ${t('sessions.inProgress')}`
    : `${fmtLongTime(span.start)} – ${fmtLongTime(span.end)}`;

  const playId = chainPlayId(chain);
  const playing = !!opts.onPlay && opts.playingId === playId;

  const reviewId = opts.record ? setReviewId(opts.session.id, opts.record.id) : null;
  const reviewTs = opts.sessionStartMs !== undefined && !open ? reviewEntryTs(opts.sessionStartMs, span.end) : null;
  const showReview = !!setCard && !!reviewId && tracked && (reviewTs !== null || !!ratingOf(setCard.id, reviewId, reviewTs));

  return (
    // A double line where a tune has a single one (the user's call,
    // 2026-10-20): the set stands out from the tunes it holds and from those
    // around it, = beside -. Three pixels is the least that draws both lines.
    <div
      class={`detection-card p-3 rounded-lg border-[3px] border-double space-y-2 ${setCard || !hasLibrary() ? 'bg-surface' : 'bg-bg'} ${open ? 'border-accent/60' : 'border-border'}`}
      data-set-id={opts.record?.id}
    >
      <div class="flex items-center gap-2">
        {open && <span class="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />}
        {pending && <span class="text-dim shrink-0" title={t('sessions.consolidating')}><HourglassIcon size={12} /></span>}

        {opts.onPlay && (() => {
          const state = { playing, fromDrive: !!opts.playFromDrive, loading: opts.playLoadingId === playId };
          return <PlayDisc {...state} title={playDiscTitle(state)} onClick={() => opts.onPlay!(chain)} />;
        })()}

        <HeardSetAbc
          title={name}
          tunes={chain.map((d, i) => ({ label: names[i]!, settingId: hasRecognisedSetting(d) ? d.settingId : null }))}
        />

        <TunesetDeckButton
          tuneIds={tuneIds}
          setCard={setCard}
          settled={settled}
          ctx={opts.ctx}
          getPinnedDeckIds={opts.getPinnedDeckIds}
          onChanged={() => { setMissing(null); opts.onChanged?.(); }}
          onExplain={(ids) => setMissing(m => (m ? null : ids ?? []))}
        />

        {/* No name (2026-10-30, the user's call): its tunes, just below, say
            it already, each on its own card. Only the Focus view, which shows
            one tune at a time, names the set (FocusView.tsx). */}
        <span class="flex-1" />

        {/* Where a tune shows how sure the recogniser is: a set is not one of
            its results, so it says what it is instead. Once the set is a card,
            the way to it — the name used to be. */}
        {setCard ? (
          <button
            class="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 inline-flex items-center gap-1 border border-border text-muted cursor-pointer hover:text-accent hover:border-accent/50 transition-colors"
            title={`${name} · ${t('sessions.openCard')}`}
            onClick={() => opts.onOpenCard?.(setCard.id)}
          >
            <TuneSetIcon size={11} />
            {t('sessions.set.label')}
          </button>
        ) : (
          <span class="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 inline-flex items-center gap-1 border border-border text-muted" title={name}>
            <TuneSetIcon size={11} />
            {t('sessions.set.label')}
          </span>
        )}

        {opts.onToggleLike && opts.record && (
          <button
            class={`shrink-0 cursor-pointer transition-colors ${opts.record.liked ? 'text-danger' : 'text-dim hover:text-danger'}`}
            title={t(opts.record.liked ? 'sessions.set.unlike' : 'sessions.set.like')}
            onClick={(e) => { e.stopPropagation(); opts.onToggleLike!(opts.record!); }}
          >
            <HeartIcon size={13} filled={!!opts.record.liked} />
          </button>
        )}
      </div>

      {/* Under the + it answers. */}
      {missing && (
        <p class="text-[11px] text-dim leading-snug">
          {missing.length > 0
            ? t('sessions.set.needCards', { names: missing.map(id => names[tuneIds.indexOf(id)]).join(', ') })
            : t('sessions.set.notSettled')}
        </p>
      )}

      <div class="space-y-1.5">{children}</div>

      {/* The set's own lines AFTER its tunes (2026-10-30, the user's call):
          the span sums up what was just read, and the review closes the set.
          The span only: its tunes say what they are (2026-10-19). Plain
          text — no pencil: the set's bounds are its tunes'. */}
      {opts.details !== false && <div class="text-xs text-muted flex items-center gap-1.5 flex-wrap">
        <span class="font-mono tabular-nums">{range}</span>
        {opts.clip && (
          <span class="ml-auto flex items-center gap-1.5">
            <SetClipControls
              session={opts.session}
              setCard={setCard}
              span={span}
              audioAvailable={opts.clip.audioAvailable}
              getAudio={opts.clip.getAudio}
              ctx={opts.ctx}
              onAttached={opts.onChanged}
              disabled={!settled}
            />
          </span>
        )}
      </div>}

      {showReview && opts.study !== false && (
        <div class="flex items-center gap-3 flex-wrap">
          <ReviewLogControl cardId={setCard!.id} reviewId={reviewId!} ts={reviewTs} ctx={opts.ctx} />
        </div>
      )}
    </div>
  );
}
