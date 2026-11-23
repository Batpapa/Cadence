import type { ComponentChild, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { anyOverlayOpen } from '../../components/overlayStack';
import { ArrowLeftIcon, ArrowRightIcon, SkipToEndIcon } from '../../components/icons';
import { EmptyState } from '../../components/ui';
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
// The set the tune belongs to, if any, holds its card, as in the lists — the
// set's rank of this tune in its pill.
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
/** The least of a tune's name worth showing beside its arrow: a word or so
 *  and the ellipsis. Narrower, the arrow goes alone. */
const NAV_NAME_MIN = 56;

/** How much the row spells out, as it narrows (the user's order): everything;
 *  then the arrows without their names; then "Live" for "Back to live".
 *  Never the dot alone — a lone red dot reads as the recording's own switch. */
type NavWords = 'all' | 'bare' | 'short';

/** One way the arrows can go: what it does, and the tune it goes to. */
interface NavStep { go: () => void; title?: string }

/** The keyboard's ← and → doing `prev` and `next`. One place on screen at a
 *  time has them — the caller decides which (AnalysisNav, the Focus view). */
export function useArrowKeys(on: boolean, prev: (() => void) | undefined, next: (() => void) | undefined): void {
  // Read at the key press, so the listener need not follow every render.
  const stepsRef = useRef({ prev, next });
  stepsRef.current = { prev, next };
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // Alt+← is the browser's own back; a modifier is never ours.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
      // A dialog on top (the score viewer has arrows of its own), or a field,
      // or a slider — a detection's seek bar steps its head with them.
      if (anyOverlayOpen()) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || active?.isContentEditable
        || active?.getAttribute('role') === 'slider') return;
      const step = e.key === 'ArrowLeft' ? stepsRef.current.prev : stepsRef.current.next;
      if (!step) return;
      e.preventDefault(); // or the page scrolls sideways
      step();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [on]);
}

/** The Focus view's arrows, FIRST in the view (2026-10-30): tapped in quick
 *  succession, they moved under the finger while they sat under the card, as
 *  names wrapped and sets came and went above them. On top, nothing of the
 *  view is above them, and the row itself never changes: one line, the same
 *  three (or two) columns whatever the state.
 *
 *  Each arrow names the tune it goes to, cut short to its half — as the
 *  analyses' line names the analysis (AnalysisNav): the two ways of stepping
 *  then read alike (2026-11-23, the user, trying it out; until then "Previous"
 *  and "Next", the card saying where one is). And drawn plain, no box: a 48 px
 *  target still — a phone put down at a session is tapped without aiming —
 *  but the card below is what the screen is about, not the way past it. At
 *  either end, the arrow alone, greyed.
 *
 *  On a feed, the way back to the latest sits between them (the user's pick
 *  over a floating button, which covered the rating buttons): "Back to live"
 *  with the REC dot on a live recording, the skip-to-end arrow on an import.
 *  It is always there — greyed when already on the latest — so that its
 *  coming and going never shifts the arrows. It keeps its box: it is a
 *  state as much as a way.
 *
 *  The names give way as the row narrows (NavWords), measured: a name's
 *  least useful width against each arrow's room, for each stage in turn,
 *  never from what is on screen — so the answer cannot flip back and forth.
 *  The way and the name stay each button's accessible name. */
function NavArrows({ prev, next, prevLabel, nextLabel, feed, keys }: {
  /** Absent: greyed, there is nothing that way. */
  prev?: NavStep;
  next?: NavStep;
  /** Which way, for a screen reader and the tooltip, before the name. */
  prevLabel: string;
  nextLabel: string;
  feed?: FocusFeed;
  /** The keyboard's ← and → press these buttons (useArrowKeys). */
  keys?: boolean;
}) {
  useArrowKeys(!!keys, prev?.go, next?.go);

  const rowRef = useRef<HTMLDivElement>(null);
  const longLiveRef = useRef<HTMLSpanElement>(null);
  const shortLiveRef = useRef<HTMLSpanElement>(null);
  const [words, setWords] = useState<NavWords>('all');

  const kind = feed?.kind;
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      /** The middle button's width with this word, or with its icon. */
      const middle = (word: HTMLElement | null) => kind === 'live' ? NAV_PAD + NAV_DOT + NAV_GAP + (word?.offsetWidth ?? 0)
        : kind === 'import' ? NAV_PAD + NAV_ICON
        : 0;
      const gaps = (kind ? 2 : 1) * NAV_GAP;
      /** Each arrow's room, the middle at this width. */
      const room = (mid: number) => (row.clientWidth - gaps - mid) / 2;
      const named = NAV_PAD + NAV_ICON + NAV_GAP + NAV_NAME_MIN;
      const bare = NAV_PAD + NAV_ICON + 1;
      const longMid = middle(longLiveRef.current);
      setWords(named <= room(longMid) ? 'all'
        : kind !== 'live' || bare <= room(longMid) ? 'bare'
        : 'short');
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [row, longLiveRef.current, shortLiveRef.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [kind]);

  const box = 'h-12 px-3 rounded-md border flex items-center gap-2 text-sm transition-colors';
  const longLive = t('sessions.focus.backToLive');
  const shortLive = t('sessions.focus.live');

  /** One of the two arrows, its content against its outer edge. */
  const arrow = (target: NavStep | undefined, dir: 'prev' | 'next') => {
    const way = dir === 'prev' ? prevLabel : nextLabel;
    const label = target?.title ? `${way} · ${target.title}` : way;
    return (
      <button
        class={`${box} border-transparent min-w-0 justify-start ${dir === 'next' ? 'flex-row-reverse' : ''} ${
          target ? 'cursor-pointer text-muted hover:text-accent hover:bg-accent/5' : 'text-dim opacity-40 cursor-default'}`}
        disabled={!target}
        aria-label={label}
        title={label}
        onClick={() => target?.go()}
      >
        <span class="shrink-0 flex items-center">{dir === 'prev' ? <ArrowLeftIcon size={20} /> : <ArrowRightIcon size={20} />}</span>
        {words === 'all' && target?.title && <span class="truncate">{target.title}</span>}
      </button>
    );
  };

  /** Back to the latest — the middle column of a feed. */
  const back = (f: FocusFeed) => {
    const label = f.kind === 'live' ? longLive : t('sessions.focus.toLatest');
    return (
      <button
        class={`${box} border-border bg-bg font-medium justify-center ${f.latest ? 'text-primary opacity-40 cursor-default' : 'cursor-pointer text-primary hover:border-accent/60 hover:bg-accent/5'}`}
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
      {/* The live words laid out on one line, out of sight: what is measured. */}
      <span class="absolute w-0 h-0 overflow-hidden invisible pointer-events-none" aria-hidden="true">
        {kind === 'live' && <span ref={longLiveRef} class="block w-max whitespace-nowrap text-sm font-medium">{longLive}</span>}
        {kind === 'live' && <span ref={shortLiveRef} class="block w-max whitespace-nowrap text-sm font-medium">{shortLive}</span>}
      </span>
    </div>
  );
}

/** The tunes either side, as the arrows' two ways. The keyboard's arrows go
 *  with them wherever the Focus view is — on an analysis, instead of the
 *  analyses' chevrons, and stopping at the first and last tune (2026-11-23, the
 *  user: going on to the next analysis from there was tried and dropped). */
function FocusNav({ anns, spot, onGo, feed }: {
  anns: Detection[];
  spot: FocusSpot;
  onGo: (ann: Detection) => void;
  feed?: FocusFeed;
}) {
  const { prev, next } = neighboursOf(anns, spot);
  const step = (ann: Detection | undefined): NavStep | undefined => ann && { go: () => onGo(ann), title: tuneName(ann).text };
  return (
    <NavArrows
      prev={step(prev)}
      next={step(next)}
      prevLabel={t('sessions.focus.prev')}
      nextLabel={t('sessions.focus.next')}
      feed={feed}
      keys
    />
  );
}

/** What a live or import feed adds to the Focus view: whether the latest
 *  detection is the one shown, and the way back to it. */
type FocusFeed = { kind: 'live' | 'import'; latest: boolean; onBack: () => void };

export function FocusView({ anns, spot, chains, renderCard, renderSet, onGo, feed }: {
  /** The analysis's detections, in playing order. */
  anns: Detection[];
  spot: FocusSpot;
  /** The sets, each as its detections — none when the sets are off. */
  chains: Detection[][];
  /** The card, drawn large; `note` goes under its name. */
  renderCard: (ann: Detection, note: ComponentChild) => ComponentChild;
  /** The set the shown tune belongs to, round its card — the screen's own
   *  set card, as in its list; `position` for its pill. */
  renderSet: (chain: Detection[], card: ComponentChild, position: { at: number; of: number }) => ComponentChild;
  /** The arrows: go to that tune. */
  onGo: (ann: Detection) => void;
  /** On a live or import feed: whether the latest detection is the one shown,
   *  and the way back to it. */
  feed?: FocusFeed;
}) {
  const shown = shownOf(anns, spot);
  const chain = shown ? chains.find(c => c.some(d => d.id === shown.id)) : undefined;
  /** In a set, the card inside the set's own, as the lists nest them — its
   *  play, score, deck, heart and notes (2026-11-23, the user). The set was
   *  a line of its tunes' names above the card before, which came and went
   *  and wrapped, moving the card at every tune. */
  const withSet = (card: ComponentChild) => chain && shown
    ? renderSet(chain, card, { at: chain.indexOf(shown) + 1, of: chain.length })
    : card;
  const { outerRef, innerRef } = useHighWater(anns.length > 0);

  if (anns.length === 0) {
    return <EmptyState class="py-10">{t('sessions.focus.empty')}</EmptyState>;
  }

  return (
    <div ref={outerRef}>
    <div ref={innerRef} class="space-y-3">
      <FocusNav anns={anns} spot={spot} onGo={onGo} feed={feed} />

      {/* The one status worth a word: over, and the latest heard — what
          "playing" would say, the card's pulsing dot already does (the
          user's call). Under the name, in the card. */}
      {shown ? withSet(renderCard(shown, shown.end !== null && feed?.latest ? (
        <span class="inline-flex px-2 py-0.5 rounded-full bg-elevated text-xs text-muted font-medium">{t('sessions.focus.ended')}</span>
      ) : undefined)) : spot?.kind === 'gap' ? (
        // A silence the play head stands in — said as the list says it.
        <div class="p-6 rounded-xl border border-dashed border-border text-center space-y-1">
          <p class="text-lg text-muted">{t('sessions.gap', { d: fmtLongTime(spot.gap.len) })}</p>
          <p class="text-xs text-dim font-mono tabular-nums">
            {fmtLongTime(spot.gap.from)} – {fmtLongTime(spot.gap.from + spot.gap.len)}
          </p>
        </div>
      ) : null}

    </div>
    </div>
  );
}

/** Wider than this, a change of width is the screen's — a phone turned, a
 *  window resized — and the heights seen are no longer this layout's. Under
 *  it, the scroll bar the kept height itself brings or takes away: reacting
 *  to that would take the height away, the bar with it, and round again
 *  (feedback: a measured layout can loop). */
const HIGH_WATER_RESET_PX = 40;

/** The Focus view never gets shorter than it has been (2026-11-23, the
 *  user): a shorter card after a long one shortened the page, the browser
 *  pulled a page scrolled down back up, and the arrows moved under the finger
 *  tapping through. The tallest the view has been is kept as its least height
 *  — on the outer box, while the inner one is measured, so the kept height
 *  never feeds back into what is measured. Until the view goes (another view,
 *  another analysis) or the screen's width changes.
 *
 *  Direct style writes: a height that only grows is nothing to re-render. */
function useHighWater(on: boolean): { outerRef: RefObject<HTMLDivElement>; innerRef: RefObject<HTMLDivElement> } {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Once, while the boxes are there — not at each render, which would forget
  // the height kept.
  useLayoutEffect(() => {
    const outer = outerRef.current, inner = innerRef.current;
    if (!on || !outer || !inner) return;
    let high = 0;
    let width = inner.clientWidth;
    let raf = 0;
    // The inner box alone is watched — its width is the outer's, and the
    // height written never changes it — and the height is written at the
    // next frame, outside the observer's delivery: written inside it, onto a
    // box it watched, the browser reported a loop ("ResizeObserver loop
    // completed with undelivered notifications", 2026-11-23).
    const measure = () => {
      raf = 0;
      const w = inner.clientWidth;
      if (Math.abs(w - width) > HIGH_WATER_RESET_PX) { width = w; high = 0; }
      const h = inner.offsetHeight;
      if (h <= high) return;
      high = h;
      outer.style.minHeight = `${h}px`;
    };
    measure();
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(measure); });
    ro.observe(inner);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [on]);
  return { outerRef, innerRef };
}
