import type { ComponentChild } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { ArrowLeftIcon, ArrowRightIcon, SkipToEndIcon, TuneSetIcon } from '../../components/icons';
import type { Detection } from '../model';
import { fmtLongTime, tuneName } from './sessionUiShared';
import type { ListGap } from './timelineModel';

// ── The Focus view (2026-10-30) ──────────────────────────────────────────────
// One tune at a time, large, for a phone put down beside you at a session (a
// tester's request). The fourth of the analysis views (analysisView.ts), on
// the finished analysis and on the live and import feeds alike.
//
// What is shown is decided by the screen, which alone knows where "now" is:
//  • on the feeds, the latest detection — "the live" — until the arrows take
//    you back; being on the latest one again IS being back (the user's rule),
//    and a button says how to get there from anywhere else;
//  • on the finished analysis, wherever the play head stands, which can be a
//    silence: the head can drop you between two tunes.
// The arrows themselves only ever step from tune to tune, never onto a silence.
//
// After the last tune of a feed has ended, it stays on screen, marked as over,
// rather than a "nothing detected" — the user's call: what was just played is
// what one wants to rate, as long as it is clear that it is behind us.
//
// The set the tune belongs to, if any, is named above it, its tunes in order
// and each one a way to it.
//
// The card is the screen's own <DetectionCard>, with its `focus` option: one
// card, whatever its size, so nothing it does can differ from the list's.

/** What the Focus view shows: a detection, a silence the play head stands in,
 *  or nothing at all (nothing detected yet). */
export type FocusSpot = { kind: 'ann'; id: string } | { kind: 'gap'; gap: ListGap } | null;

/** Where a live or import feed's Focus view stands: on the latest detection
 *  unless the arrows took it elsewhere. Only that elsewhere is remembered, by
 *  id; a detection the decoder retracts there drops the view back to the
 *  latest — nothing special, as the user asked. */
export function useFeedFocus(anns: Detection[]): {
  spot: FocusSpot;
  latest: boolean;
  onGo: (ann: Detection) => void;
  onBack: () => void;
} {
  const [pinned, setPinned] = useState<string | null>(null);
  const last = anns[anns.length - 1];
  const held = pinned !== null && pinned !== last?.id && anns.some(a => a.id === pinned) ? pinned : null;
  const shownId = held ?? last?.id;
  return {
    spot: shownId ? { kind: 'ann', id: shownId } : null,
    latest: held === null,
    onGo: (ann) => setPinned(ann.id === last?.id ? null : ann.id),
    onBack: () => setPinned(null),
  };
}

/** The shown detection, if a detection is shown — not a silence, not nothing. */
function shownOf(anns: Detection[], spot: FocusSpot): Detection | undefined {
  return spot?.kind === 'ann' ? anns.find(a => a.id === spot.id) : undefined;
}

/** Previous and next — the tunes either side of the one shown, or of the
 *  silence the head stands in. */
function neighboursOf(anns: Detection[], spot: FocusSpot): { prev?: Detection; next?: Detection } {
  const shown = shownOf(anns, spot);
  if (shown) {
    const at = anns.indexOf(shown);
    return { prev: anns[at - 1], next: anns[at + 1] };
  }
  if (spot?.kind !== 'gap') return {};
  return {
    prev: spot.gap.prevId ? anns.find(a => a.id === spot.gap.prevId) : undefined,
    next: spot.gap.followingId ? anns.find(a => a.id === spot.gap.followingId) : undefined,
  };
}

/** The fixed parts of the row's buttons, in layout pixels: `px-3` on both
 *  sides, a 1 px border on both, the 20 px arrow, `gap-2` — and the REC dot. */
const NAV_PAD = 2 * 12 + 2;
const NAV_ICON = 20;
const NAV_GAP = 8;
const NAV_DOT = 10;

/** How much the row spells out, as it narrows (the user's order): everything;
 *  then the arrows without their words; then "Live" for "Back to live".
 *  Never the dot alone — a lone red dot reads as the recording's own switch. */
type NavWords = 'all' | 'bare' | 'short';

/** The Focus view's arrows, FIRST in the view (2026-10-30): tapped in quick
 *  succession, they moved under the finger while they sat under the card, as
 *  names wrapped and sets came and went above them. On top, nothing of the
 *  view is above them, and the row itself never changes: one line, the same
 *  three (or two) columns whatever the state. "Previous" and "Next", no tune
 *  names: the card right below says where one is (the user's call).
 *
 *  On a feed, the way back to the latest sits between them (the user's pick
 *  over a floating button, which covered the rating buttons): "Back to live"
 *  with the REC dot on a live recording, the skip-to-end arrow on an import.
 *  It is always there — greyed when already on the latest — so that its
 *  coming and going never shifts the arrows.
 *
 *  The words give way as the row narrows (NavWords), measured: the words'
 *  natural widths (invisible twins below) against the row's, for each stage
 *  in turn, never from what is on screen — so the answer cannot flip back and
 *  forth. Both arrows lose their words together, as soon as either would be
 *  cut. The words stay as each button's accessible name. */
function FocusNav({ anns, spot, onGo, feed }: {
  anns: Detection[];
  spot: FocusSpot;
  onGo: (ann: Detection) => void;
  feed?: FocusFeed;
}) {
  const { prev, next } = neighboursOf(anns, spot);
  const rowRef = useRef<HTMLDivElement>(null);
  const prevWordRef = useRef<HTMLSpanElement>(null);
  const nextWordRef = useRef<HTMLSpanElement>(null);
  const longLiveRef = useRef<HTMLSpanElement>(null);
  const shortLiveRef = useRef<HTMLSpanElement>(null);
  const [words, setWords] = useState<NavWords>('all');

  const kind = feed?.kind;
  useLayoutEffect(() => {
    const row = rowRef.current;
    const prevWord = prevWordRef.current;
    const nextWord = nextWordRef.current;
    if (!row || !prevWord || !nextWord) return;
    const measure = () => {
      /** The middle button's width with this word, or with its icon. */
      const middle = (word: HTMLElement | null) => kind === 'live' ? NAV_PAD + NAV_DOT + NAV_GAP + (word?.offsetWidth ?? 0)
        : kind === 'import' ? NAV_PAD + NAV_ICON
        : 0;
      const gaps = (kind ? 2 : 1) * NAV_GAP;
      /** Each arrow's room, the middle at this width. */
      const room = (mid: number) => (row.clientWidth - gaps - mid) / 2;
      const worded = NAV_PAD + NAV_ICON + NAV_GAP + Math.max(prevWord.offsetWidth, nextWord.offsetWidth) + 1;
      const bare = NAV_PAD + NAV_ICON + 1;
      const longMid = middle(longLiveRef.current);
      setWords(worded <= room(longMid) ? 'all'
        : kind !== 'live' || bare <= room(longMid) ? 'bare'
        : 'short');
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [row, prevWord, nextWord, longLiveRef.current, shortLiveRef.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [kind]);

  const box = 'h-12 px-3 rounded-lg border border-border bg-bg flex items-center gap-2 text-sm font-medium transition-colors';
  const usable = (on: boolean) => on ? 'cursor-pointer text-primary hover:border-accent/60 hover:bg-accent/5' : 'text-dim opacity-50 cursor-default';
  const prevLabel = t('sessions.focus.prev');
  const nextLabel = t('sessions.focus.next');
  const longLive = t('sessions.focus.backToLive');
  const shortLive = t('sessions.focus.live');

  /** One of the two arrows, its content against its outer edge. */
  const arrow = (target: Detection | undefined, dir: 'prev' | 'next') => {
    const label = dir === 'prev' ? prevLabel : nextLabel;
    return (
      <button
        class={`${box} min-w-0 justify-start ${dir === 'next' ? 'flex-row-reverse' : ''} ${usable(!!target)}`}
        disabled={!target}
        aria-label={label}
        onClick={() => target && onGo(target)}
      >
        <span class="shrink-0 flex items-center">{dir === 'prev' ? <ArrowLeftIcon size={20} /> : <ArrowRightIcon size={20} />}</span>
        {words === 'all' && <span class="whitespace-nowrap">{label}</span>}
      </button>
    );
  };

  /** Back to the latest — the middle column of a feed. */
  const back = (f: FocusFeed) => {
    const label = f.kind === 'live' ? longLive : t('sessions.focus.toLatest');
    return (
      <button
        class={`${box} justify-center ${usable(!f.latest)}`}
        disabled={f.latest}
        title={label}
        aria-label={label}
        onClick={f.onBack}
      >
        {f.kind === 'live' ? (
          <>
            <span class={`w-2.5 h-2.5 rounded-full shrink-0 bg-danger ${f.latest ? '' : 'animate-pulse'}`} />
            <span class="whitespace-nowrap">{words === 'short' ? shortLive : longLive}</span>
          </>
        ) : (
          <span class="shrink-0 flex items-center"><SkipToEndIcon size={20} /></span>
        )}
      </button>
    );
  };

  return (
    <div class="relative">
      <div ref={rowRef} class={`grid gap-2 ${feed ? 'grid-cols-[1fr_auto_1fr]' : 'grid-cols-2'}`}>
        {arrow(prev, 'prev')}
        {feed && back(feed)}
        {arrow(next, 'next')}
      </div>
      {/* The words laid out on one line, out of sight: what is measured. */}
      <span class="absolute w-0 h-0 overflow-hidden invisible pointer-events-none" aria-hidden="true">
        <span ref={prevWordRef} class="block w-max whitespace-nowrap text-sm font-medium">{prevLabel}</span>
        <span ref={nextWordRef} class="block w-max whitespace-nowrap text-sm font-medium">{nextLabel}</span>
        {kind === 'live' && <span ref={longLiveRef} class="block w-max whitespace-nowrap text-sm font-medium">{longLive}</span>}
        {kind === 'live' && <span ref={shortLiveRef} class="block w-max whitespace-nowrap text-sm font-medium">{shortLive}</span>}
      </span>
    </div>
  );
}

/** What a live or import feed adds to the Focus view: whether the latest
 *  detection is the one shown, and the way back to it. */
type FocusFeed = { kind: 'live' | 'import'; latest: boolean; onBack: () => void };

export function FocusView({ anns, spot, chains, renderCard, onGo, feed }: {
  /** The analysis's detections, in playing order. */
  anns: Detection[];
  spot: FocusSpot;
  /** The sets, each as its detections — none when the sets are off. */
  chains: Detection[][];
  /** The card, drawn large; `note` goes under its name. */
  renderCard: (ann: Detection, note: ComponentChild) => ComponentChild;
  /** The arrows and the set's names: go to that tune. */
  onGo: (ann: Detection) => void;
  /** On a live or import feed: whether the latest detection is the one shown,
   *  and the way back to it. */
  feed?: FocusFeed;
}) {
  const shown = shownOf(anns, spot);
  const chain = shown ? chains.find(c => c.some(d => d.id === shown.id)) : undefined;

  if (anns.length === 0) {
    return <p class="text-sm text-dim text-center py-10">{t('sessions.focus.empty')}</p>;
  }

  return (
    <div class="space-y-3">
      <FocusNav anns={anns} spot={spot} onGo={onGo} feed={feed} />

      {/* Its tunes as the set's own name spells them — " / " between them
          (TUNESET_NAME_SEPARATOR), the user's call — wrapping in a column of
          their own, the "Set" pill alone at the right. */}
      {chain && (
        <div class="flex items-start gap-3 text-xs text-muted">
          <div class="flex-1 min-w-0 flex items-center gap-x-1.5 gap-y-1 flex-wrap">
            {chain.map((d, k) => (
              <span key={d.id} class="inline-flex items-center gap-1.5 min-w-0">
                {k > 0 && <span class="text-dim">/</span>}
                {d.id === shown!.id
                  ? <span class="font-semibold text-primary">{tuneName(d).text}</span>
                  : <button class="cursor-pointer hover:text-accent hover:underline transition-colors" onClick={() => onGo(d)}>{tuneName(d).text}</button>}
              </span>
            ))}
          </div>
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border shrink-0">
            <TuneSetIcon size={11} />
            {t('sessions.set.label')}
          </span>
        </div>
      )}

      {/* The one status worth a word: over, and the latest heard — what
          "playing" would say, the card's pulsing dot already does (the
          user's call). Under the name, in the card. */}
      {shown ? renderCard(shown, shown.end !== null && feed?.latest ? (
        <span class="inline-flex px-2 py-0.5 rounded-full bg-elevated text-xs text-muted font-medium">{t('sessions.focus.ended')}</span>
      ) : undefined) : spot?.kind === 'gap' ? (
        // A silence the play head stands in — said as the list says it.
        <div class="p-6 rounded-xl border border-dashed border-border text-center space-y-1">
          <p class="text-lg text-muted">{t('sessions.gap', { d: fmtLongTime(spot.gap.len) })}</p>
          <p class="text-xs text-dim font-mono tabular-nums">
            {fmtLongTime(spot.gap.from)} – {fmtLongTime(spot.gap.from + spot.gap.len)}
          </p>
        </div>
      ) : null}

    </div>
  );
}
