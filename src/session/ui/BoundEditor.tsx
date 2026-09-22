import { render } from 'preact';
import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, closeModal } from '../../components/modal';
import { playIcon, pauseIcon } from '../../components/playbackIcons';
import { ResetIcon } from '../../components/icons';
import type { Detection } from '../model';
import {
  contextWindow, waveformFitsContext, loupeDecodeWindow, clampBound,
  snapMarks, findSnap, findTwin, clampLinked, missingRanges,
  LOUPE_HALF_S, PEAK_BUCKET_S, type SnapMark, type BoundTwin,
} from './boundEditorModel';
import {
  makePeakBuffer, readInto, isRead, levelOver,
  type PeakBuffer, type WaveRead,
} from '../audio/localWaveform';

// ── Bound editor ─────────────────────────────────────────────────────────────
// Replaced the two ±5 s steppers that used to sit on every detection card
// (sessionUiShared's BoundControls, now gone). Those asked the user to correct
// a bound whose estimate is off by about a second, in steps of five, with a
// three-second preview played blind and each press written to disk with no way
// back.
//
// It serves all three screens — the finished summary, a live recording and a
// file import — from the same `getAudio` blob, which is why the recording is
// asked for rather than passed: a live one is assembled from its chunks on
// demand. Offered on a FINALIZED detection only, everywhere, since until then
// the decoder can still move the very bounds being edited.
//
// Three ideas hold this screen up.
//
// TWO SCALES, BECAUSE THERE ARE TWO GESTURES. A three-minute detection across
// a phone's 350 px is 2 px per second — aiming to the second there is simply
// not possible. So the context strip is for seeing and aiming roughly (drag a
// handle), and the magnifier below it, 8 s across, is for placing (a second is
// about 45 px). One state, two speeds.
//
// IN THE MAGNIFIER THE SOUND MOVES, NOT THE BOUND. The mark stays in the
// middle and the recording scrolls under it, the way a video trimmer's film
// strip does. Nothing tiny to catch, travel that never runs out, and the thumb
// never covers the place being aimed at.
//
// THE WAVEFORM IS NOT ENOUGH. Between two tunes OF A SET there is no silence
// at all: the waveform is flat and says nothing. So the strip also draws the
// recogniser's own observation windows — Detection.evidence[], already stored
// on every detection — this tune's in the accent colour, its neighbours' in
// grey. Where the grey stops and the coloured start is the join. The waveform
// answers the other case, the real pause between two sets, which it shows
// plainly and the evidence does not.
//
// Nothing is written until "Save": the draft lives here, and Cancel leaves the
// detection exactly as it was found.

/** A neighbour's bound, moved because it was joined to one of ours. */
export interface TwinEdit {
  id: string;
  /** Which of the NEIGHBOUR's bounds moves. */
  edge: 'start' | 'end';
  t: number;
}

/** Everything a save writes. More than this detection's two bounds since
 *  2026-09-21: a join that two detections share moves on both sides at once,
 *  so the caller is told about the neighbours it has to write as well. */
export interface BoundEdit {
  start: number;
  end: number;
  twins: TwinEdit[];
}

/** What one press of an arrow key moves. A quarter of a second: a fraction of
 *  the error being corrected, and still audible as a difference when the loop
 *  replays.
 *
 *  The two ±0.25 s buttons that used to sit in the transport row are gone
 *  (2026-09-21, user request) — the magnifier's jog does the same job with the
 *  sound under the finger, and the arrows remain for anyone on a keyboard. */
const NUDGE_S = 0.25;
/** With Shift, for crossing a phrase rather than trimming one. */
const NUDGE_COARSE_S = 2;
/** How far BEFORE the bound listening always starts.
 *
 *  Never at the bound itself. What is being judged is a transition, and a
 *  transition cannot be heard from its far side: dropped exactly on the cut,
 *  the ear has nothing to compare the new tune to. A couple of seconds is
 *  enough to already be somewhere when it happens (2026-09-20, user request:
 *  "on doit écouter un peu avant la borne pour se rendre compte de la
 *  transition"). */
const PRE_ROLL_S = 2;
/** And how far past it the loop runs before going back to the top. The same as
 *  the lead-in: the cut sits in the middle of the loop, so each pass gives the
 *  before and the after equal weight.
 *
 *  Two seconds, settled by ear (2026-09-20): three made every pass a wait. The
 *  two are separate constants although they hold the same number, because they
 *  answer different questions — how much run-up the ear needs, and how long to
 *  keep listening once the answer is in. */
const POST_ROLL_S = 2;
/** Travel below which a press on the magnifier counts as a click rather than a
 *  jog. A finger never holds perfectly still. */
const LOUPE_CLICK_SLOP_PX = 4;

const fmtFine = (s: number): string => {
  const m = Math.floor(Math.max(0, s) / 60);
  const r = Math.max(0, s) - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
};
const fmtShort = (s: number): string => {
  const m = Math.floor(Math.max(0, s) / 60);
  return `${m}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
};
const fmtDelta = (d: number): string => `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} s`;

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

/** What `class="capitalize"` does, for text going into a canvas.
 *
 *  A detection's displayName is LOWERCASE — that is how the recognition index
 *  holds it (see Detection.displayName), and every view that shows it adds the
 *  CSS class. A canvas cannot, so the same rule is applied by hand: first
 *  letter of each word, nothing else. Deliberately no cleverer than CSS, for
 *  the reason the model states — re-casing is guesswork the moment a name
 *  contains "McGuire", and failing identically everywhere beats failing
 *  differently here. */
const capitalizeWords = (s: string): string => s.replace(/\b\p{L}/gu, ch => ch.toUpperCase());

/** Sizes a canvas to its box in real device pixels and hands back a context
 *  whose coordinates are plain layout pixels.
 *
 *  The scale is read from the bounding rect rather than assumed to be the
 *  device ratio: the app can be under a CSS zoom on <html>, which multiplies
 *  the rect without touching clientWidth (see the zoom note in utils). Drawing
 *  through the ratio alone would then be soft on exactly the strips that are
 *  meant to be read to the pixel. */
function fitCanvas(cv: HTMLCanvasElement, box: HTMLElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = box.clientWidth, h = box.clientHeight;
  if (w <= 0 || h <= 0) return null;
  const rect = box.getBoundingClientRect();
  const scale = (rect.width / w) * Math.min(3, window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
  if (cv.width !== bw) cv.width = bw;
  if (cv.height !== bh) cv.height = bh;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/** The envelope, drawn as a mirrored bar per pixel column.
 *
 *  A column nobody has decoded yet is a hairline, never a bar: an unread
 *  stretch drawn at zero height is indistinguishable from silence, and the one
 *  thing this strip must not do is invent a pause where the file has music. */
function drawWave(
  g: CanvasRenderingContext2D, w: number, yTop: number, yH: number,
  t0: number, t1: number, buf: PeakBuffer | null, inFrom: number, inTo: number,
): void {
  const mid = yTop + yH / 2, half = yH / 2 - 1;
  const cOut = cssVar('--color-dim'), cIn = cssVar('--color-accent');
  const perPx = (t1 - t0) / w;
  for (let x = 0; x < w; x++) {
    const ta = t0 + x * perPx;
    const inside = ta >= inFrom && ta < inTo;
    if (!buf || !isRead(buf, ta)) {
      g.globalAlpha = .2;
      g.fillStyle = cOut;
      g.fillRect(x, mid - .5, 1, 1);
      continue;
    }
    const level = perPx <= PEAK_BUCKET_S ? levelOver(buf, ta, ta + PEAK_BUCKET_S) : levelOver(buf, ta, ta + perPx);
    const bar = Math.max(1, level * half);
    g.globalAlpha = inside ? .95 : .5;
    g.fillStyle = inside ? cIn : cOut;
    g.fillRect(x, mid - bar, 1, bar * 2);
  }
  g.globalAlpha = 1;
}

interface BoundEditorProps {
  ann: Detection;
  /** Every detection of the analysis, this one included — the neighbours are
   *  drawn and offered as snap marks. */
  anns: Detection[];
  duration: number;
  /** The recording, read once when the editor opens — for the waveform AND
   *  for listening, which is why it is a blob and not also a URL: a live
   *  recording's is assembled from its chunks on demand, and assembling it
   *  twice for one screen would be a second pass over the whole thing.
   *  Resolves to undefined when the device does not hold the recording. */
  getAudio: () => Promise<Blob | undefined>;
  /** Fired on every change, so the modal's Save button can read the draft
   *  without owning it. */
  onDraft: (edit: BoundEdit) => void;
  /** Replaces the name/dance/meter line at the top. For a detection being
   *  ADDED, whose identity is not settled yet and is chosen right there — see
   *  AddDetection.tsx. Handed the live draft, because the length belongs on
   *  that line and belongs to the bounds rather than to the tune. */
  identitySlot?: (draft: { start: number; end: number }) => ComponentChild;
  /** Whether a bound that opens flush against a neighbour starts out linked to
   *  it. True everywhere but the add-detection screen, where the bounds are
   *  seeded from a SILENCE: they touch the neighbours because the hole is
   *  bounded by them, which is the opposite of a join. Linking there by
   *  default would stretch the tunes on either side over the pause as soon as
   *  the user tightened the new detection. The toggle is still offered, off. */
  linkByDefault?: boolean;
}

export function BoundEditor({ ann, anns, duration, getAudio, onDraft, identitySlot, linkByDefault = true }: BoundEditorProps) {
  const origin = useRef({ start: ann.start, end: ann.end ?? duration }).current;
  /** The whole recording — what a bound may reach. */
  const reach: [number, number] = [0, duration];

  const [draft, setDraftState] = useState({ start: origin.start, end: origin.end });
  const [bound, setBound] = useState<'start' | 'end'>('start');
  const [magnet, setMagnet] = useState(true);
  const [loop, setLoop] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** Bumped whenever the waveform gains ground. The peak array is mutated in
   *  place by the reader, so nothing else would tell Preact to repaint — and
   *  the value itself is never read, since the repaint effect below runs on
   *  every render and reads the buffer straight through its ref. Same shape as
   *  SessionSummary's own `bump`. */
  const [, setWaveTick] = useState(0);
  /** Made from the same blob the envelope is read out of, so the recording is
   *  fetched once. Null until it arrives — and for good on a device that does
   *  not hold it, which is what greys out every listening control. */
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  /** The device does not hold this recording — settled only once the lookup
   *  has come back, so the explanation does not flash while it is still being
   *  read (a live recording's blob is assembled from its chunks and takes a
   *  moment). */
  const [audioMissing, setAudioMissing] = useState(false);

  const bufRef = useRef<PeakBuffer | null>(null);
  const blobRef = useRef<Blob | null>(null);
  /** Stretches already ordered, so a drag does not order the same seconds
   *  again on every frame. Grows only; the reads themselves land in `buf`. */
  const orderedRef = useRef<Array<[number, number]>>([]);
  const readsRef = useRef<WaveRead[]>([]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const ctxBoxRef = useRef<HTMLDivElement>(null);
  const ctxCvRef = useRef<HTMLCanvasElement>(null);
  const loupeBoxRef = useRef<HTMLDivElement>(null);
  const loupeCvRef = useRef<HTMLCanvasElement>(null);
  const ctxHeadRef = useRef<HTMLDivElement>(null);
  const loupeHeadRef = useRef<HTMLDivElement>(null);
  const handleRefs = {
    start: useRef<HTMLDivElement>(null),
    end: useRef<HTMLDivElement>(null),
  };
  const headRef = useRef(origin.start);
  /** Whether the head has ever been PUT somewhere — by a press on a strip, or
   *  by the play button. Its starting value is the bound itself, which is not
   *  a place anyone chose to listen at, so it is not a mark until then. */
  const headSetRef = useRef(false);

  /** The recording is not on this device, so every control here is inert.
   *
   *  Not a degraded mode but a closed door (2026-09-21, user request): a bound
   *  is placed BY EAR, and without the audio there is no cue to place it
   *  against — dragging a handle over a blank strip would only let the user
   *  make the bounds worse while feeling productive. The summary already keeps
   *  this screen shut in that case, and says why on the page; this is the
   *  backstop for the recording being forgotten while the editor is open. */
  const locked = audioMissing;

  const active = bound === 'start' ? draft.start : draft.end;
  const activeRef = useRef(active);
  activeRef.current = active;
  const loopRef = useRef(loop);
  loopRef.current = loop;

  // ── Joins that move as one ─────────────────────────────────────────────────
  // When this detection's start sits exactly on the previous tune's end, that
  // is not two bounds agreeing — it is ONE frontier, written twice. Moving our
  // side alone does not correct it: it opens a hole or an overlap exactly as
  // wide as the move. So the neighbour comes along (user request, 2026-09-21).
  //
  // ON by default, and only ever offered where the bounds already touch — so
  // the default is simply "a join stays a join", and the toggle is there for
  // the one case where the user means to break it apart. That is also why
  // availability is read from the bounds as they OPENED: a link that switched
  // itself on mid-drag, the instant a snap made the numbers agree, would start
  // moving a second detection under the user's finger.
  const opening = useRef({
    start: findTwin(anns, ann.id, origin.start, 'end', duration),
    end: findTwin(anns, ann.id, origin.end, 'start', duration),
  }).current;
  const [linked, setLinked] = useState({
    start: linkByDefault && !!opening.start,
    end: linkByDefault && !!opening.end,
  });
  /** The twin actually travelling with each bound, or null. */
  const twin: Record<'start' | 'end', BoundTwin | null> = {
    start: linked.start ? opening.start : null,
    end: linked.end ? opening.end : null,
  };
  const linkedIds = new Set([twin.start?.id, twin.end?.id].filter((v): v is string => !!v));

  /** Where a neighbour's bound stands right now — its own, unless it is linked
   *  to ours and travelling with it. Everything that draws or measures a
   *  neighbour goes through this, or the strip would show the join splitting
   *  while the save puts it back together. */
  const boundOf = (d: Detection, edge: 'start' | 'end'): number => {
    if (twin.start?.id === d.id && twin.start.edge === edge) return draft.start;
    if (twin.end?.id === d.id && twin.end.edge === edge) return draft.end;
    return edge === 'start' ? d.start : (d.end ?? duration);
  };

  /** A linked bound answers to the far side of the tune it drags along, or the
   *  neighbour would end before it began. Every move goes through this. */
  const withTwins = (pair: { start: number; end: number }) => clampLinked(
    pair,
    twin.start ? anns.find(a => a.id === twin.start!.id) ?? null : null,
    twin.end ? anns.find(a => a.id === twin.end!.id) ?? null : null,
    duration,
  );

  /** What a save would write to the neighbours. Empty unless a link is on. */
  const twinEdits = (next: { start: number; end: number }): TwinEdit[] => [
    ...(twin.start ? [{ id: twin.start.id, edge: twin.start.edge, t: next.start }] : []),
    ...(twin.end ? [{ id: twin.end.id, edge: twin.end.edge, t: next.end }] : []),
  ];

  const setDraft = (next: { start: number; end: number }) => {
    setDraftState(next);
    onDraft({ start: next.start, end: next.end, twins: twinEdits(next) });
  };

  /** The fixed marks — neighbouring bounds and this detection's other one.
   *  What the magnifier DRAWS, since a canvas only repaints on a render. */
  const marks = snapMarks(anns, ann.id, draft, bound, duration, linkedIds);

  /** The marks as they stand at this instant, play head included.
   *
   *  Read as a function and never kept, because the head moves between renders
   *  (2026-09-22, user request — the head replaces the "Bound here" button,
   *  whose "here" pointed at nothing the eye could find).
   *
   *  Two conditions, and both are about the head being a PLACE rather than a
   *  position. It has to have been put somewhere: until the first press it
   *  sits on the bound itself, which nobody chose, against a line hidden
   *  behind the crosshair. And the sound has to be stopped: a running head is
   *  a sweep, not a target — under the loop it crosses the very spot being
   *  dragged every few seconds, and a mark that comes to meet the finger is
   *  not a mark. Stopped, it stands exactly where the ear left it. */
  const marksNow = (): SnapMark[] => {
    const a = audioRef.current;
    const still = headSetRef.current && (!a || a.paused);
    return still ? [...marks, { t: headRef.current, head: true }] : marks;
  };

  /** Moves the active bound, snapping unless the caller is being exact. The
   *  one route every keyboard, button and jog movement takes — so the lock
   *  below only has to be stated here and at the three pointer entries. */
  const moveTo = (v: number, { snap = true } = {}) => {
    if (locked) return;
    const target = snap && magnet ? (findSnap(v, marksNow())?.t ?? v) : v;
    setDraft(withTwins(clampBound(bound, target, draft, reach)));
  };

  // ── What the context strip shows ───────────────────────────────────────────
  // Recomputed from the draft, not fixed at open time (2026-09-20, user
  // request): pulling a bound back has to uncover what lies BEFORE it, rather
  // than run into a wall, so the thirty seconds of margin travel with the
  // bounds and a bound may reach anywhere in the recording.
  const win = contextWindow(draft.start, draft.end, duration);
  /** The same window, reachable from the frame loop below.
   *
   *  That loop is registered once and runs until the editor closes, so it
   *  holds the FIRST render's closures for good — which is why everything it
   *  reads across frames is a ref (activeRef, loopRef, headRef). `win` was
   *  missed: once a bound had moved, the strip's span changed but the loop
   *  kept mapping the play head through the span the editor opened with, so
   *  the head was painted at the wrong place and a press on the strip appeared
   *  to land somewhere else (2026-09-21, user report). The press itself was
   *  always right — `ctxTimeAt` reads `win` from a fresh handler — it was the
   *  mark that lied, and only while the sound was running, which is exactly
   *  when a press on the strip leaves it running. */
  const winRef = useRef(win);
  winRef.current = win;

  // ── Reading the recording ──────────────────────────────────────────────────
  // The peak envelope is allocated for the WHOLE recording — at one value per
  // 10 ms that is 4 MB for three hours, next to a recording that is already
  // held in memory by the tens of megabytes — and filled in piece by piece as
  // the view asks for it. One array means the two strips can never disagree
  // about a second they both cover, and audio uncovered by a moving bound is
  // simply the next piece to fill.
  //
  // The magnifier's dozen seconds are always ordered first: that is where the
  // precise work happens, and it is ready before the user has looked away from
  // the title. Everything else follows into the same array.
  /** Orders whatever of `[from, to]` has not been asked for yet. */
  const ensureDecoded = (from: number, to: number) => {
    const buf = bufRef.current, blob = blobRef.current;
    if (!buf || !blob) return;
    // Rounded outwards to whole seconds: a drag changes the window by a pixel
    // at a time, and without this each frame would order its own sliver.
    const want: [number, number] = [Math.max(0, Math.floor(from)), Math.min(duration, Math.ceil(to))];
    for (const piece of missingRanges(want, orderedRef.current)) {
      orderedRef.current.push(piece);
      readsRef.current.push(readInto(blob, buf, piece[0], piece[1],
        () => setWaveTick(x => x + 1),
        () => setWaveTick(x => x + 1),
      ));
    }
  };

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void getAudio().then(blob => {
      if (cancelled) return;
      if (!blob) { setAudioMissing(true); return; }
      blobRef.current = blob;
      url = URL.createObjectURL(blob);
      setAudioUrl(url);
      bufRef.current = makePeakBuffer(0, duration);
      ensureDecoded(...loupeDecodeWindow(origin.start, reach));
      setWaveTick(x => x + 1);
    });
    return () => {
      cancelled = true;
      for (const r of readsRef.current) r.cancel();
      readsRef.current = [];
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line
  }, []);

  // Whatever is on screen gets ordered. The magnifier first, always, and then
  // the context strip — unless the detection has grown past the cap, where the
  // strip goes without its envelope and only the magnifier keeps one.
  useEffect(() => {
    if (!bufRef.current) return;
    ensureDecoded(...loupeDecodeWindow(active, reach));
    if (waveformFitsContext(win)) ensureDecoded(win[0], win[1]);
    // eslint-disable-next-line
  });

  // ── Listening ──────────────────────────────────────────────────────────────
  // A rAF poll rather than the element's own 'timeupdate': that fires about
  // four times a second, which is fine for a head crossing a whole session in
  // the summary's strip and far too coarse here — the magnifier shows eight
  // seconds, so a quarter-second step is a visible jump, and a loop would
  // overshoot its end by as much.
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const a = audioRef.current;
      if (a && !a.paused) {
        if (loopRef.current) {
          const lo = activeRef.current - PRE_ROLL_S, hi = activeRef.current + POST_ROLL_S;
          if (a.currentTime >= hi || a.currentTime < lo - .5) a.currentTime = Math.max(0, lo);
        }
        headRef.current = a.currentTime;
        paintHeads();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line
  }, []);

  // Leaving takes the sound with it. The element is about to be unmounted
  // anyway, but a paused element is what the summary's own player expects to
  // find when it takes over again.
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const seek = (tSec: number) => {
    const a = audioRef.current;
    headRef.current = Math.max(0, Math.min(duration, tSec));
    headSetRef.current = true;
    if (a) a.currentTime = headRef.current;
    paintHeads();
  };
  const playFrom = (tSec: number) => {
    const a = audioRef.current;
    if (!a || !audioUrl) return;
    seek(tSec);
    void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  /** Listening at the active bound always means starting PRE_ROLL_S before it. */
  const playAtBound = () => playFrom(activeRef.current - PRE_ROLL_S);
  const toggleLoop = () => {
    if (loop) { audioRef.current?.pause(); setPlaying(false); setLoop(false); return; }
    setLoop(true);
    playAtBound();
  };
  /** A bound has moved, so whatever was playing is now about the old one:
   *  start again from the lead-in to the new one (2026-09-20, user request).
   *
   *  Only when something IS playing — looping or not. Starting the sound on
   *  its own for every arrow key would turn a quiet correction into a noise,
   *  and the loop and the play button are both one tap away. */
  const rearmListening = () => {
    const a = audioRef.current;
    if (!a || a.paused) return;
    playAtBound();
  };

  // ── Painting ───────────────────────────────────────────────────────────────
  const paintHeads = () => {
    const h = headRef.current;
    const ctxBox = ctxBoxRef.current, ctxHead = ctxHeadRef.current;
    if (ctxBox && ctxHead) {
      // Through the ref, never the closure: see winRef.
      const [t0, t1] = winRef.current;
      const p = (h - t0) / (t1 - t0);
      ctxHead.style.left = `${p * ctxBox.clientWidth}px`;
      ctxHead.style.opacity = p < 0 || p > 1 ? '0' : '.9';
    }
    const lBox = loupeBoxRef.current, lHead = loupeHeadRef.current;
    if (lBox && lHead) {
      const q = (h - (activeRef.current - LOUPE_HALF_S)) / (2 * LOUPE_HALF_S);
      lHead.style.left = `${q * lBox.clientWidth}px`;
      lHead.style.opacity = q < 0 || q > 1 ? '0' : '.9';
    }
  };

  const drawContext = () => {
    const box = ctxBoxRef.current, cv = ctxCvRef.current;
    if (!box || !cv) return;
    const fitted = fitCanvas(cv, box);
    if (!fitted) return;
    const { g, w, h } = fitted;
    const [t0, t1] = win, span = t1 - t0;
    const X = (tt: number) => ((tt - t0) / span) * w;

    const yNb = 0, hNb = Math.round(h * .14);
    const yWav = Math.round(h * .18), hWav = Math.round(h * .55);
    const yEv = Math.round(h * .77), hEv = Math.round(h * .08);
    const yEv2 = Math.round(h * .88), hEv2 = Math.round(h * .06);

    // What is being kept, behind everything else.
    g.fillStyle = cssVar('--color-accent-dim');
    g.fillRect(X(draft.start), yWav - 2, Math.max(1, X(draft.end) - X(draft.start)), hWav + 4);

    drawWave(g, w, yWav, hWav, t0, t1, bufRef.current, draft.start, draft.end);

    // The neighbours, drawn plainly even where they bite into this one: joins
    // overlap as a rule, and hiding that would make the strip lie.
    g.font = '500 9px "IBM Plex Sans", system-ui, sans-serif';
    for (const d of anns) {
      if (d.id === ann.id) continue;
      // Through boundOf, so a neighbour linked to a bound we are dragging is
      // drawn where it is GOING, not where it was.
      const x0 = X(boundOf(d, 'start')), x1 = X(boundOf(d, 'end'));
      if (x1 < 0 || x0 > w) continue;
      g.globalAlpha = .3;
      g.fillStyle = cssVar('--color-dim');
      g.fillRect(x0, yNb, Math.max(2, x1 - x0), hNb);
      g.globalAlpha = 1;
      g.fillStyle = cssVar('--color-muted');
      const label = capitalizeWords(d.displayName);
      if (x1 - x0 > g.measureText(label).width + 10) g.fillText(label, Math.max(2, x0) + 4, yNb + hNb - 3);
    }

    // The recogniser's testimony: this tune's windows, then everyone else's.
    for (const e of ann.evidence ?? []) {
      g.globalAlpha = .25 + .65 * Math.max(0, Math.min(1, e.score));
      g.fillStyle = cssVar('--color-accent');
      g.fillRect(X(e.t), yEv, Math.max(1, X(e.tEnd ?? e.t + 10) - X(e.t) - 1), hEv);
    }
    for (const d of anns) {
      if (d.id === ann.id) continue;
      for (const e of d.evidence ?? []) {
        g.globalAlpha = .2 + .4 * Math.max(0, Math.min(1, e.score));
        g.fillStyle = cssVar('--color-dim');
        g.fillRect(X(e.t), yEv2, Math.max(1, X(e.tEnd ?? e.t + 10) - X(e.t) - 1), hEv2);
      }
    }
    g.globalAlpha = 1;

    // Written straight to the nodes rather than through the style props: the
    // strip is redrawn on every pixel of a drag, and the handles have to land
    // in the same frame as the canvas under them.
    if (handleRefs.start.current) handleRefs.start.current.style.left = `${X(draft.start)}px`;
    if (handleRefs.end.current) handleRefs.end.current.style.left = `${X(draft.end)}px`;
  };

  const drawLoupe = () => {
    const box = loupeBoxRef.current, cv = loupeCvRef.current;
    if (!box || !cv) return;
    const fitted = fitCanvas(cv, box);
    if (!fitted) return;
    const { g, w, h } = fitted;
    const c = active, t0 = c - LOUPE_HALF_S, t1 = c + LOUPE_HALF_S;
    const X = (tt: number) => ((tt - t0) / (t1 - t0)) * w;

    // Which side of the mark is inside the tune. Unmistakable, and it flips
    // with the bound being edited — that is the whole answer to "what am I
    // including".
    const inFrom = bound === 'start' ? c : t0 - 1;
    const inTo = bound === 'start' ? t1 + 1 : c;
    g.fillStyle = cssVar('--color-accent-dim');
    g.fillRect(X(Math.max(t0, inFrom)), 0, Math.max(0, X(Math.min(t1, inTo)) - X(Math.max(t0, inFrom))), h);

    drawWave(g, w, Math.round(h * .16), Math.round(h * .58), t0, t1, bufRef.current, inFrom, inTo);

    // Half-second ticks, whole seconds taller: the scale has to be readable
    // without a label on every line.
    g.strokeStyle = cssVar('--color-border');
    g.lineWidth = 1;
    for (let k = Math.ceil(t0 * 2) / 2; k <= t1; k += .5) {
      const x = Math.round(X(k)) + .5;
      const whole = Math.abs(k - Math.round(k)) < .01;
      g.beginPath();
      g.moveTo(x, h - Math.round(h * .2));
      g.lineTo(x, h - Math.round(h * (whole ? .08 : .13)));
      g.stroke();
    }

    // The marks the bound can click onto.
    g.font = '500 9px "IBM Plex Sans", system-ui, sans-serif';
    for (const m of marks) {
      if (m.t < t0 || m.t > t1) continue;
      // The one the bound is already sitting on is drawn by the crosshair and
      // named by the tag under it. Drawn again here, its line would hide
      // behind the crosshair and its label behind the crosshair's grip — which
      // is exactly what it looked like: a name with its first letters eaten.
      if (Math.abs(m.t - c) < .01) continue;
      const x = Math.round(X(m.t)) + .5;
      const colour = cssVar('--color-muted');
      g.strokeStyle = colour;
      g.setLineDash([2, 4]);
      g.beginPath();
      g.moveTo(x, Math.round(h * .1));
      g.lineTo(x, h - Math.round(h * .2));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = colour;
      g.fillText(labelOf(m), x + 3, Math.round(h * .14));
    }

    // Where each observation window begins and ends — at this scale a window
    // is wider than the view, so only its edges can be shown, and the edges
    // are what a bound is being lined up against anyway.
    for (const d of anns) {
      for (const e of d.evidence ?? []) {
        for (const edge of [e.t, e.tEnd ?? e.t + 10]) {
          if (edge < t0 || edge > t1) continue;
          g.globalAlpha = .55;
          g.fillStyle = d.id === ann.id ? cssVar('--color-accent') : cssVar('--color-dim');
          g.fillRect(Math.round(X(edge)), h - Math.round(h * .07), 1, Math.round(h * .06));
        }
      }
    }
    g.globalAlpha = 1;
  };

  const labelOf = (m: SnapMark): string => {
    if (m.head) return t('sessions.bounds.snapHead');
    if (!m.name) return t(m.edge === 'start' ? 'sessions.bounds.snapOwnStart' : 'sessions.bounds.snapOwnEnd');
    return t(m.edge === 'start' ? 'sessions.bounds.snapStart' : 'sessions.bounds.snapEnd', { name: capitalizeWords(m.name) });
  };

  // Repaint on anything that changes what either strip shows. Cheap: a few
  // hundred pixel columns each, and nothing here runs per frame.
  useEffect(() => {
    drawContext();
    drawLoupe();
    paintHeads();
    // eslint-disable-next-line
  });

  // Re-registered on every render, deliberately, like the keyboard handler
  // below: `drawContext` reads the draft, the window and the peaks it has so
  // far, so a listener registered once would redraw a rotated phone with
  // whatever the editor opened on. Adding and removing one listener per render
  // is cheaper than the redraw it guards.
  useEffect(() => {
    const onResize = () => { drawContext(); drawLoupe(); paintHeads(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // ── Keyboard ───────────────────────────────────────────────────────────────
  // The arrows are the exact route: a quarter second, two seconds with Shift.
  // Space plays, as it does in the summary and in the score viewer. Ignored
  // while a field or a button has focus, for the reason the summary states —
  // a button already answers the space bar by activating itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        moveTo(activeRef.current + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? NUDGE_COARSE_S : NUDGE_S), { snap: false });
        rearmListening();
      } else if (e.code === 'Space' && tag !== 'button') {
        e.preventDefault();
        const a = audioRef.current;
        if (!a || !audioUrl) return;
        if (a.paused) playAtBound(); else { a.pause(); setPlaying(false); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ── Gestures ───────────────────────────────────────────────────────────────
  const ctxTimeAt = (clientX: number): number => {
    const box = ctxBoxRef.current;
    if (!box) return win[0];
    const r = box.getBoundingClientRect();
    return win[0] + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (win[1] - win[0]);
  };

  const onHandleDown = (which: 'start' | 'end') => (e: PointerEvent) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    setBound(which);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const v = ctxTimeAt(ev.clientX);
      const target = magnet ? (findSnap(v, marksNow())?.t ?? v) : v;
      setDraft(withTwins(clampBound(which, target, draft, win)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      rearmListening();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  /** A press on the strip itself listens there. Deliberately not a second way
   *  to move a bound: the handles do that, and a strip where every touch moved
   *  something would make listening around impossible. */
  const onCtxDown = (e: PointerEvent) => {
    if (locked) return;
    if (loop) setLoop(false);
    playFrom(ctxTimeAt(e.clientX));
  };

  const loupeDragRef = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const onLoupeDown = (e: PointerEvent) => {
    if (locked) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    loupeDragRef.current = { x: e.clientX, from: active, moved: false };
  };
  const onLoupeMove = (e: PointerEvent) => {
    const d = loupeDragRef.current;
    const box = loupeBoxRef.current;
    if (!d || !box) return;
    // A press that never travels is a click, not a jog. A few pixels of slack,
    // because a finger never holds perfectly still.
    if (!d.moved && Math.abs(e.clientX - d.x) < LOUPE_CLICK_SLOP_PX) return;
    d.moved = true;
    // Pull the film strip right and the mark moves EARLIER — the mark is
    // standing still while the recording travels under it.
    //
    // Measured against the BOUNDING RECT, not clientWidth. The app runs under
    // a CSS zoom on <html> — 125% on a desktop by default (zoomService) — and
    // the two are not the same width then: clientWidth is layout pixels,
    // while a pointer's clientX is viewport pixels, like the rect. Dividing
    // one by the other made the sound travel 1.25× the distance of the
    // finger, on every desktop, which is exactly how far off it felt.
    const width = box.getBoundingClientRect().width || box.clientWidth;
    const secPerPx = (2 * LOUPE_HALF_S) / width;
    moveTo(d.from - (e.clientX - d.x) * secPerPx);
  };
  /** Read at pointerup, like the summary's own timeline: a drag has already
   *  done its work, a plain press means "listen here" — the same thing a press
   *  on the context strip means, so the two read alike (2026-09-20, user
   *  request). */
  const onLoupeUp = (e: PointerEvent) => {
    const d = loupeDragRef.current;
    if (!d) return;
    loupeDragRef.current = null;
    if (d.moved) { rearmListening(); return; }
    const box = loupeBoxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const at = (active - LOUPE_HALF_S) + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (2 * LOUPE_HALF_S);
    if (loop) setLoop(false);
    playFrom(at);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const dStart = draft.start - origin.start;
  const dEnd = draft.end - origin.end;
  const dirty = Math.abs(dStart) > .004 || Math.abs(dEnd) > .004;
  const noWave = !waveformFitsContext(win);
  const snapped = magnet ? findSnap(active, marksNow(), 0.002) : null;

  const boundBtn = (which: 'start' | 'end', value: number, delta: number) => (
    <button
      class={`rounded-lg border px-3 py-1.5 text-left transition-colors cursor-pointer ${
        bound === which ? 'border-accent bg-accent/10' : 'border-border bg-bg hover:border-dim'}`}
      aria-pressed={bound === which}
      onClick={() => { setBound(which); rearmListening(); }}
    >
      <span class={`block text-[10px] uppercase tracking-widest ${bound === which ? 'text-accent' : 'text-dim'}`}>
        {t(which === 'start' ? 'sessions.bounds.start' : 'sessions.bounds.end')}
      </span>
      <span class="block text-base font-mono font-semibold tabular-nums text-primary leading-snug">{fmtFine(value)}</span>
      <span class="block text-[11px] text-warn tabular-nums h-4">{Math.abs(delta) > .004 ? fmtDelta(delta) : ''}</span>
    </button>
  );

  return (
    <div class="space-y-4">
      {identitySlot ? identitySlot(draft) : (
        <div>
          <p class="text-sm font-semibold text-primary capitalize truncate">{ann.displayName}</p>
          <p class="text-xs text-muted">
            {ann.dance} · {ann.meter} · {t('sessions.bounds.length', { d: fmtShort(draft.end - draft.start) })}
          </p>
        </div>
      )}

      <div class="grid grid-cols-2 gap-2">
        {boundBtn('start', draft.start, dStart)}
        {boundBtn('end', draft.end, dEnd)}
      </div>

      {/* Only for the bound being worked on, and only where a neighbour is
          actually joined to it — a control that is absent most of the time
          says more by appearing than a permanently greyed one ever could. It
          names the neighbour, because "move both" is meaningless until you
          know which other tune you are about to change. */}
      {opening[bound] && (
        <button
          class={`w-full flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[11px] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
            linked[bound] ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-primary'}`}
          disabled={locked}
          aria-pressed={linked[bound]}
          title={t('sessions.bounds.linkHint')}
          onClick={() => {
            const next = { ...linked, [bound]: !linked[bound] };
            setLinked(next);
            // The draft's own numbers did not move, but what a save would
            // write just did — the caller has to hear about it.
            onDraft({
              start: draft.start,
              end: draft.end,
              twins: [
                ...(next.start && opening.start ? [{ id: opening.start.id, edge: opening.start.edge, t: draft.start }] : []),
                ...(next.end && opening.end ? [{ id: opening.end.id, edge: opening.end.edge, t: draft.end }] : []),
              ],
            });
          }}
        >
          {/* One glyph in both states, like the loop and magnet toggles: the
              border and colour already say which it is, and a "broken chain"
              needs a combining overlay that half the fonts draw as two marks. */}
          <span class="shrink-0 text-sm leading-none">⛓</span>
          <span class="flex-1 min-w-0 truncate">
            {t(linked[bound] ? 'sessions.bounds.linkOn' : 'sessions.bounds.linkOff', {
              name: capitalizeWords(opening[bound]!.name),
            })}
          </span>
        </button>
      )}

      {/* ── Context ── */}
      <div>
        <div class="flex items-center justify-between gap-2 mb-1">
          <span class="text-[10px] uppercase tracking-widest text-dim">{t('sessions.bounds.context')}</span>
          <span class="text-[11px] text-dim truncate">{t('sessions.bounds.contextHint')}</span>
        </div>
        <div
          ref={ctxBoxRef}
          class={`relative h-[84px] rounded-lg overflow-hidden bg-elevated touch-none select-none ${
            locked ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
          onPointerDown={onCtxDown}
        >
          <canvas ref={ctxCvRef} class="block w-full h-full" />
          {noWave && (
            <span class="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[11px] text-dim px-3 pointer-events-none">
              {t('sessions.bounds.tooLong')}
            </span>
          )}
          {audioMissing && !noWave && (
            <span class="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[11px] text-dim px-3 pointer-events-none">
              {t('sessions.bounds.noAudio')}
            </span>
          )}
          {(['start', 'end'] as const).map(which => (
            <div
              key={which}
              ref={handleRefs[which]}
              class={`absolute inset-y-0 w-9 -ml-[18px] flex justify-center z-[3] ${
                locked ? 'cursor-default' : 'cursor-ew-resize'}`}
              style={{ left: '0px' }}
              onPointerDown={onHandleDown(which)}
              title={t(which === 'start' ? 'sessions.bounds.start' : 'sessions.bounds.end')}
            >
              <div class={`w-0.5 h-full ${bound === which ? 'bg-accent' : 'bg-dim opacity-70'}`} />
              <div class={`absolute top-0 w-4 h-4 rounded-b flex items-center justify-center ${
                bound === which ? 'bg-accent' : 'bg-dim opacity-70'}`}
              >
                <span class="block w-1.5 h-2 border-x border-white/70" />
              </div>
            </div>
          ))}
          <div ref={ctxHeadRef} class="absolute inset-y-0 w-0.5 bg-primary pointer-events-none z-[4]" style={{ left: '0px', opacity: 0 }} />
        </div>
        <div class="flex justify-between text-[10px] text-dim font-mono tabular-nums mt-0.5">
          {[0, .25, .5, .75, 1].map(f => <span key={f}>{fmtShort(win[0] + (win[1] - win[0]) * f)}</span>)}
        </div>
      </div>

      {/* ── Magnifier ── */}
      <div>
        <div class="flex items-center justify-between gap-2 mb-1">
          <span class="text-[10px] uppercase tracking-widest text-dim">
            {t('sessions.bounds.loupe')} · {t(bound === 'start' ? 'sessions.bounds.start' : 'sessions.bounds.end')}
          </span>
          <span class="text-[11px] text-dim truncate">{t('sessions.bounds.loupeHint')}</span>
        </div>
        <div
          ref={loupeBoxRef}
          class={`relative h-[96px] rounded-lg overflow-hidden bg-elevated touch-none select-none ${
            locked ? 'cursor-default opacity-60' : 'cursor-ew-resize'}`}
          onPointerDown={onLoupeDown}
          onPointerMove={onLoupeMove}
          onPointerUp={onLoupeUp}
          onPointerCancel={onLoupeUp}
        >
          <canvas ref={loupeCvRef} class="block w-full h-full" />
          <div class="absolute inset-y-0 left-1/2 -ml-px w-0.5 bg-accent pointer-events-none z-[3]">
            <span class="absolute top-0 -left-[7px] w-4 h-4 rounded-b bg-accent" />
          </div>
          <span class="absolute left-1/2 -translate-x-1/2 top-5 z-[4] pointer-events-none rounded-full border border-accent bg-bg px-2.5 py-0.5 font-mono tabular-nums text-xs font-semibold text-primary whitespace-nowrap">
            {fmtFine(active)}
          </span>
          {snapped && (
            <span class="absolute left-1/2 -translate-x-1/2 bottom-1.5 z-[4] pointer-events-none rounded-full bg-bg px-2 text-[10px] text-warn whitespace-nowrap">
              ◎ {labelOf(snapped)}
            </span>
          )}
          <div ref={loupeHeadRef} class="absolute inset-y-0 w-0.5 bg-primary pointer-events-none z-[4]" style={{ left: '0px', opacity: 0 }} />
        </div>
        <div class="flex justify-between text-[10px] text-dim font-mono mt-0.5">
          <span>−4 s</span><span>−2 s</span><span>0</span><span>+2 s</span><span>+4 s</span>
        </div>
      </div>

      {/* ── Transport ── */}
      <div class="flex items-center gap-2 flex-wrap">
        <button
          class="w-9 h-9 p-0 rounded-full flex items-center justify-center shrink-0 bg-accent/10 text-accent hover:bg-accent/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          disabled={!audioUrl}
          title={t(playing ? 'sessions.bounds.pause' : 'sessions.bounds.play')}
          dangerouslySetInnerHTML={{ __html: playing ? pauseIcon(12) : playIcon(12) }}
          onClick={() => {
            const a = audioRef.current;
            if (!a) return;
            if (!a.paused) { a.pause(); setPlaying(false); return; }
            playAtBound();
          }}
        />
        <button
          class={`min-h-9 px-3 rounded-full border text-xs inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
            loop ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:border-accent hover:text-primary'}`}
          disabled={!audioUrl}
          aria-pressed={loop}
          title={t('sessions.bounds.loopHint')}
          onClick={toggleLoop}
        >
          ⟲ {t('sessions.bounds.loop')}
        </button>
        {/* Snapping sits in the transport row since 2026-09-22, in the place
            the "Bound here" button held: what it now clicks onto is mostly the
            play head, and the head is what the two controls to its left move.
            The button it replaced said "here" about a thin line the eye never
            found — dragging the bound ONTO that line says the same thing with
            the sound and the waveform under the finger, and needs no word.
            Pushed to the far right (`ml-auto`), because it is a setting and
            not a transport control: the play and loop buttons act now, this
            one only changes how the next drag behaves. */}
        <button
          class={`ml-auto min-h-9 px-3 rounded-full border text-xs inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
            magnet ? 'border-accent text-accent bg-accent/10' : 'border-border text-muted hover:border-accent hover:text-primary'}`}
          aria-pressed={magnet}
          title={t('sessions.bounds.magnetHint')}
          onClick={() => setMagnet(m => !m)}
        >
          ◎ {t('sessions.bounds.magnet')}
        </button>
      </div>

      {/* The colour legend stood here until 2026-09-21. Removed at the user's
          request — "très clair déjà": the accent block is under the crosshair
          being dragged and the grey ones carry the neighbours' names, so both
          say what they are without a key. */}
      {/* Nothing but Reset is left on this line, so it only exists once there
          is something to reset — an empty row would still spend its margin. */}
      {dirty && (
        <div class="flex items-center justify-end">
          <button
            class="text-[11px] text-dim hover:text-primary inline-flex items-center gap-1 transition-colors cursor-pointer"
            onClick={() => { setDraft({ ...origin }); rearmListening(); }}
          >
            <ResetIcon size={11} /> {t('sessions.bounds.reset')}
          </button>
        </div>
      )}

      <audio ref={audioRef} class="hidden" src={audioUrl ?? undefined} onPause={() => setPlaying(false)} />
    </div>
  );
}

/** Imperative bridge — showModal still needs a plain HTMLElement body, and it
 *  already owns the title bar, the close button, Escape and the click-outside
 *  (see AlternatesPopover's identical bridge, and modal.tsx for why the Preact
 *  tree inside has to be unmounted by hand on the way out).
 *
 *  `onSave` receives the draft only when the user says so: every path out
 *  other than the Save button leaves the detection untouched, which is the one
 *  thing the old ±5 s steppers could not offer. */
export function showBoundEditor(opts: {
  ann: Detection;
  anns: Detection[];
  duration: number;
  getAudio: () => Promise<Blob | undefined>;
  onSave: (edit: BoundEdit) => void;
}): void {
  const body = document.createElement('div');
  const cleanup = () => render(null, body);
  // Seeded with no twins: the editor reports them on its first change, and
  // saving without touching anything must not write to a neighbour.
  let draft: BoundEdit = { start: opts.ann.start, end: opts.ann.end ?? opts.duration, twins: [] };

  render(
    <BoundEditor
      ann={opts.ann}
      anns={opts.anns}
      duration={opts.duration}
      getAudio={opts.getAudio}
      onDraft={(edit) => { draft = edit; }}
    />,
    body,
  );

  showModal(t('sessions.bounds.title'), body, [
    { label: t('common.cancel'), onClick: () => { closeModal(); cleanup(); } },
    { label: t('common.save'), primary: true, onClick: () => { closeModal(); cleanup(); opts.onSave(draft); } },
  ], { maxWidth: '34rem', onDismiss: cleanup });
}
