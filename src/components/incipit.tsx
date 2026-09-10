import { useEffect, useRef, useState } from 'preact/hooks';
import type { AbcOpenMode, AppState, Card, IncipitDisplay } from '../types';
// Type-only: erased at compile time, so it costs nothing at runtime and the
// module itself stays lazily imported below.
import type { TuneObject, MidiBuffer } from 'abcjs';
import { isTuneset } from '../services/cardTypeService';
import { INCIPIT_BARS, abcIncipit, abcOpenMode, isAbcFile, decodeAbc, splitAbcTunes, parseAbcBlock } from '../services/abcService';
import { resolveCardRef } from '../services/cardRefService';
import { appState } from '../store';
import { playIcon, stopIcon } from './playbackIcons';
import { MusicNoteIcon } from './icons';
import { t } from '../services/i18nService';

// ── The opening bars, in place ───────────────────────────────────────────────
// Asked for from the field (2026-09-10): in a session, looking at a set, a
// player wants a reminder of how each tune STARTS — "sans cliquer trop sur les
// écrans en dessous". Not a score to read: two bars, at a glance.
//
// Two bars and one ▸, and nothing else. The play button was added the day
// after, for the same reason the feature exists at all: plenty of players
// learn by ear and read notation slowly or not at all, so a reminder they
// cannot hear is only half a reminder. Everything else — the transport bar,
// the cursor, the tempo and instrument controls — stays in the viewer, which
// this deliberately does not touch.

/** The widest a two-bar stave is ever drawn, so it stays the size of a line of
 *  music and not of the screen it happens to be on. A narrower row gets a
 *  narrower stave — see `staffWidthFor`. */
const INCIPIT_STAFF_WIDTH = 420;

/** `staffwidth` is measured in abcjs's own units, BEFORE `scale`: 420 at 0.8
 *  produces an svg whose width attribute is 525, painted through a transform
 *  at 420. `fitToInk` folds that transform away, so what finally lands on the
 *  page is `staffwidth` pixels wide — which is why nothing below multiplies
 *  by this. It is here to be passed to abcjs, and nowhere else. */
const INCIPIT_SCALE = 0.8;

/** Below this the stave stops being readable and scrolling is the better
 *  answer, so a genuinely tiny column gets a scrollbar rather than a squint.
 *  Low on purpose: a floor high enough to overflow a phone would be the bug
 *  this whole function exists to fix. Measured on a 228 px column, a floor of
 *  200 drew 251 px and cut the last bar off — exactly what was reported. */
const MIN_STAFF_WIDTH = 120;

/** abcjs does not honour `staffwidth` to the pixel — measured, it came back
 *  1.4 px over on one width and exact on another — and a stave that misses by
 *  one is a stave with a scrollbar. Cheaper to give back four pixels than to
 *  model whatever abcjs adds. */
const FIT_MARGIN = 4;

/** How much the row has to change width before the stave is re-engraved.
 *  Wide enough to swallow a scrollbar appearing (~15 px), which is the one
 *  width change a redraw can cause by itself. */
const RESIZE_HYSTERESIS = 20;

/** The stave width that fits `avail` layout pixels — the phone fix.
 *
 *  A fixed 420 is 525 px of SVG, and a phone card column is about 380: the
 *  last bar was simply cut off the right edge. Capped rather than merely
 *  scaled, so a desktop keeps the size that was tuned by eye instead of
 *  stretching a two-bar reminder across the whole page. */
export function staffWidthFor(avail: number): number {
  if (avail <= 0) return INCIPIT_STAFF_WIDTH;         // not measured yet
  return Math.round(Math.max(MIN_STAFF_WIDTH, Math.min(INCIPIT_STAFF_WIDTH, avail - FIT_MARGIN)));
}

/** Whether the opening bars belong on this screen, for this user. */
export function showsIncipit(user: Pick<AppState, 'incipitDisplay'>, where: 'card' | 'study'): boolean {
  const setting: IncipitDisplay = user.incipitDisplay ?? 'card';
  if (setting === 'none') return false;
  if (where === 'card') return true;      // both 'card' and 'study' cover it
  return setting === 'study';
}

/** One tune's opening, from its own starred score. Null when it has none. */
function tuneIncipit(card: Card | null | undefined): string | null {
  const attachment = card?.content?.attachments?.find(a => a.type === 'file' && isAbcFile(a));
  if (!attachment || attachment.type !== 'file') return null;
  let blocks: string[];
  try { blocks = splitAbcTunes(decodeAbc(attachment)); } catch { return null; }
  const index = Math.max(0, Math.min(blocks.length - 1, attachment.preferredIndex ?? 0));
  const block = blocks[index];
  return block ? abcIncipit(block, INCIPIT_BARS) : null;
}

/** What to draw for a card: one opening per tune.
 *
 *  A set gives one entry PER MEMBER, stacked in playing order, rather than
 *  the fused single line this first shipped as. Two reasons, both the user's
 *  (2026-09-11): each opening then gets its own ▸ — a set is three tunes and
 *  you want to hear the one you have forgotten, not all three — and the tune
 *  list sitting directly above already names them in the same order, so the
 *  labels on the staves were saying it twice.
 *
 *  A member with no score is skipped rather than drawn as a bar of silence:
 *  in a fused score that silence held the tune's PLACE in a line that had to
 *  stay continuous; separate staves keep their order without it, and an empty
 *  stave would be a row that says nothing. */
export function incipitScores(card: Card, cards: Record<string, Card>): Array<{ key: string; abc: string }> {
  if (!isTuneset(card)) {
    const abc = tuneIncipit(card);
    return abc ? [{ key: card.id, abc }] : [];
  }
  const out: Array<{ key: string; abc: string }> = [];
  for (const [i, ref] of (card.tunes ?? []).entries()) {
    const abc = tuneIncipit(resolveCardRef(ref, cards));
    if (abc) out.push({ key: `${ref.id}-${i}`, abc });
  }
  return out;
}

/** The whole thing, decided and drawn: the one call a screen makes.
 *
 *  Renders nothing at all — no heading, no frame — when the setting says no,
 *  when the card has no score, or while abcjs is still on its way. A screen
 *  therefore never has to guard the call, and never shows an empty slot. */
export function IncipitRow({ card, where, class: className = '' }: {
  card: Card;
  where: 'card' | 'study';
  class?: string;
}) {
  const user = appState.value;
  /** Which face the openings show — ONE switch for the whole section, beside
   *  its title (the user's call, 2026-09-11). A set stacks three staves and
   *  they are three views of the same question; flipping them one at a time
   *  was three taps to answer it, and left the section half in one notation
   *  and half in the other.
   *
   *  Starts from the user's preference, the same one the full viewer opens
   *  on, and never writes it back: this is a look at the source, not a new
   *  default. */
  const [mode, setMode] = useState<AbcOpenMode>(() => abcOpenMode(appState.value));

  if (!showsIncipit(user, where)) return null;
  const scores = incipitScores(card, user.cards);
  if (scores.length === 0) return null;
  return (
    <div class={`space-y-1 ${className}`}>
      <div class="flex items-center gap-2">
        <span class="section-title">{t('card.section.incipit')}</span>
        <button
          type="button"
          class="tap-btn shrink-0 cursor-pointer"
          title={t(mode === 'sheet' ? 'card.incipit.showSource' : 'card.incipit.showScore')}
          onClick={() => setMode(m => (m === 'sheet' ? 'text' : 'sheet'))}
        >
          {/* Shows the face it would switch TO, in the viewer's own
              vocabulary — the "ABC" tab there is this "ABC" here. */}
          <span class="w-6 h-6 rounded-full flex items-center justify-center bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
            {mode === 'sheet'
              ? <span class="text-[8px] font-mono font-bold leading-none">ABC</span>
              : <MusicNoteIcon size={11} />}
          </span>
        </button>
      </div>
      {scores.map(s => <Incipit key={s.key} abc={s.abc} mode={mode} />)}
    </div>
  );
}

/** Makes what abcjs produced occupy exactly the room it draws in — no more.
 *
 *  Two separate pieces of dead space, both of them abcjs's own doing and
 *  neither visible to the compiler. Measured in the browser, on the phone
 *  that reported them.
 *
 *  **Above the staff.** abcjs lays a score out with room for the things a
 *  score usually has — the title, the tempo mark — and those are hidden here,
 *  not absent: the tempo stays in the ABC so the ▸ plays at the right speed,
 *  and it is taken out with CSS. abcjs had already reserved its height by
 *  then, so the staff sat low in a box 12 px too tall, beside a centred ▸ that
 *  read as misaligned. Cropping the viewBox to the ink fixes that whatever the
 *  cause — a title, a tempo, a future field — instead of subtracting a magic
 *  number.
 *
 *  **To the right.** `scale` is applied as a CSS TRANSFORM on the svg
 *  (`transform: scale(0.8)`, origin 0 0), so the element still takes its full
 *  untransformed width in the layout while painting only 80 % of it: a 228 px
 *  box showing 182 px of music and 46 px of nothing. Folding the factor into
 *  the width and height attributes — the viewBox already carries the drawing's
 *  own coordinates — paints exactly the same picture in a box that matches it.
 *
 *  It also writes `overflow: hidden` and a fixed width/height onto OUR
 *  container, which is what beat `overflow-x-auto` and turned an overflow into
 *  a clean cut with the last bar missing. Handing those back to the stylesheet
 *  is the rest of the fix. */
/** The y of the middle of the five staff lines, in the drawing's own units.
 *
 *  Found by shape rather than by class: abcjs names only the top line, and a
 *  staff line is unmistakable anyway — a rule two pixels thick running the
 *  whole width. Five of them, so the middle one is the median. Anything else
 *  (a barline is tall and narrow, a ledger line is short, a beam is thick)
 *  fails one of the two tests.
 *
 *  Null when the staff cannot be recognised, which leaves the caller doing
 *  nothing rather than guessing — a misplaced score is worse than one sitting
 *  where abcjs put it. */
function middleStaffLineY(svg: SVGSVGElement, width: number): number | null {
  const ys: number[] = [];
  for (const el of Array.from(svg.querySelectorAll('path'))) {
    let box: DOMRect;
    try { box = (el as SVGGraphicsElement).getBBox(); } catch { continue; }
    if (box.height > 2) continue;                 // not a rule
    if (box.width < width * 0.8) continue;        // not a full-width one
    ys.push(box.y + box.height / 2);
  }
  if (ys.length < 5) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)] ?? null;
}

function fitToInk(host: HTMLElement): void {
  // abcjs styles the container it was handed. Ours is laid out by CSS.
  host.style.removeProperty('overflow');
  host.style.removeProperty('width');
  host.style.removeProperty('height');

  const svg = host.querySelector('svg');
  if (!svg) return;
  let top = Infinity, bottom = -Infinity;
  for (const el of Array.from(svg.querySelectorAll('path, text, rect'))) {
    let box: DOMRect;
    try { box = (el as SVGGraphicsElement).getBBox(); } catch { continue; }
    if (!box.width && !box.height) continue;
    top = Math.min(top, box.y);
    bottom = Math.max(bottom, box.y + box.height);
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return;
  const width = parseFloat(svg.getAttribute('width') ?? '') || svg.getBoundingClientRect().width;
  const height = bottom - top;
  // Read back rather than assumed: if abcjs ever stops scaling this way, the
  // factor is 1 and everything below is a no-op.
  const scale = parseFloat(/scale\(\s*([\d.]+)/.exec(svg.style.transform)?.[1] ?? '1') || 1;
  svg.setAttribute('viewBox', `0 ${top} ${width} ${height}`);
  svg.setAttribute('width', String(width * scale));
  svg.setAttribute('height', String(height * scale));
  svg.style.removeProperty('transform');
  svg.style.removeProperty('transform-origin');

  // Sit the MIDDLE STAFF LINE on the row's centre line, so the ▸ beside it
  // and the staff read as being on the same line. Cropping to the ink centres
  // the INK, which is not the same thing at all: a tune that climbs high puts
  // more ink above the staff than below, and the staff then rides low while
  // the row's other controls stay centred.
  //
  // A CSS transform, deliberately: it moves the paint and not the layout, so
  // the row keeps exactly the height the ink asked for and the notes that now
  // fall outside simply show — which is why the host no longer clips. The
  // user's call: the height must not move, the music may spill.
  const mid = middleStaffLineY(svg, width);
  if (mid === null) return;
  const dy = (height * scale) / 2 - (mid - top) * scale;
  if (Math.abs(dy) > 0.5) svg.style.transform = `translateY(${dy}px)`;
}

/** Draws one ABC string as a small stave, with a ▸ beside it.
 *
 *  abcjs is imported lazily — 512 KB that only ever loaded when someone opened
 *  a score, and this must not turn that into a cost every card page pays up
 *  front. It arrives, the stave appears; until then the row simply is not
 *  there. Nothing waits on it and nothing reports its failure: this improves a
 *  page, it is not a feature anyone is blocked on. */
function Incipit({ abc, mode, class: className = '' }: { abc: string; mode: AbcOpenMode; class?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Everything the play button needs, filled in by the render below. A ref,
  // not state: nothing on screen depends on it until the button is pressed.
  const audio = useRef<{ visualObj: TuneObject | null; synth: MidiBuffer | null }>({ visualObj: null, synth: null });
  const [playing, setPlaying] = useState(false);
  const [audible, setAudible] = useState(false);
  /** How much room the stave actually has, in layout pixels. */
  const [avail, setAvail] = useState(0);

  // Measured, never assumed. A ResizeObserver and not a window listener: the
  // sidebar opening or closing changes this row's width without the window
  // changing size at all, and so does rotating a phone mid-view.
  //
  // Two precautions, both learnt the hard way from "ResizeObserver loop
  // completed with undelivered notifications" while dragging a window edge:
  //
  //  1. The measurement is deferred to the next frame. Redrawing a score is
  //     layout work, and doing layout work INSIDE the callback is what turns
  //     one notification into a loop the browser gives up on.
  //  2. Small changes are ignored. Redrawing changes the stave's HEIGHT,
  //     which can make the page's scrollbar appear or vanish, which changes
  //     every width on the page — a genuine oscillation, not just a warning.
  //     A stave is capped at 420 px and scales with CSS in between, so a few
  //     pixels of width are worth nothing and a redraw for them is worth less.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    let last = -1;
    const measure = () => {
      const w = host.clientWidth;
      if (last >= 0 && Math.abs(w - last) < RESIZE_HYSTERESIS) return;
      last = w;
      setAvail(w);
    };
    measure();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(host);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [mode]);

  // The sound belongs to the MUSIC, not to the drawing: built from `abc`
  // alone, so switching faces neither stops it nor throws the primed buffer
  // away. Only a different tune — or leaving the page — ends it.
  useEffect(() => {
    setPlaying(false);
    return () => {
      try { audio.current.synth?.stop(); } catch { /* never started */ }
      audio.current = { visualObj: null, synth: null };
    };
  }, [abc]);

  useEffect(() => {
    let alive = true;
    void import('abcjs').then(abcjs => {
      if (!alive) return;
      try {
        const host = hostRef.current;
        // No host means the source is on screen instead of the stave. Parse
        // it anyway: the synth never needed the engraving, only the parse,
        // and the ▸ has to work on either face — someone reading the ABC is
        // exactly the person who wants to check it against the sound.
        const visual = host ? abcjs.renderAbc(host, abc, {
          // NOT `responsive: 'resize'`. That makes the SVG fill its container,
          // and a two-bar stave stretched across a 1600 px desktop is drawn at
          // four times the size of the text around it — which is exactly how
          // it first shipped. A fixed staff width keeps an incipit the size of
          // a line of music; the wrapper scrolls it on a narrow screen.
          add_classes: true,
          paddingtop: 0, paddingbottom: 0, paddingleft: 0, paddingright: 0,
          staffwidth: staffWidthFor(avail),
          scale: INCIPIT_SCALE,
          // Belt and braces on top of the header trimming in abcIncipit: even
          // if a field slips through, none of it gets a visible size here.
          // The tempo mark is the exception — abcjs ignores a zero-sized
          // `tempofont`, so it is hidden in CSS instead (`.abcjs-tempo`),
          // which keeps `Q:` in the ABC for the play button.
          format: { titlefont: 'Verdana 0', composerfont: 'Verdana 0', annotationfont: 'Verdana 9' },
        }) : abcjs.parseOnly(abc);
        if (host) fitToInk(host);
        audio.current.visualObj = visual?.[0] ?? null;
        // Only offer the button where sound can actually come out.
        if (alive && abcjs.synth.supportsAudio()) setAudible(true);
      } catch {
        if (alive) setFailed(true);
      }
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [abc, mode, avail]);

  /** Plays, pauses, resumes — the whole point being that not everyone reads
   *  music.
   *
   *  Built on the first press, never before: priming a synth allocates an
   *  audio buffer, and a card page with a stave on it should cost nothing
   *  until someone asks to hear it. The click is also the user gesture
   *  browsers require before any audio may start at all.
   *
   *  `start()` returns void — it is NOT a promise, whatever it looks like.
   *  Awaiting it (the first version did) resolves on the spot and flips the
   *  button back to ▸ while the sound is still playing. The end is announced
   *  by `onEnded`, which is why it is wired at init — and it goes INSIDE
   *  `options`, see below. */
  const toggle = async () => {
    const abcjs = await import('abcjs');
    const { visualObj } = audio.current;
    if (!visualObj) return;

    const synth = audio.current.synth;
    if (synth) {
      // STOP, not pause (the user's call, 2026-09-11): two bars are over in
      // three seconds, so there is nothing to come back to in the middle of
      // them. Pressing it again plays the opening from the top, which is what
      // "remind me how it starts" means.
      if (playing) { synth.stop(); setPlaying(false); }
      else { synth.start(); setPlaying(true); }
      return;
    }

    try {
      const created = new abcjs.synth.CreateSynth();
      const program = appState.value.abcInstrument;
      await created.init({
        visualObj,
        // `onEnded` belongs INSIDE `options`, and the typing lies about it:
        // `MidiBufferOptions` declares it at the top level too, so tsc accepts
        // it there — but `create-synth.js` only ever reads
        // `options.options.onEnded`. Passed at the top level it is silently
        // dropped, the end of the sound is never announced, and the button
        // stays on ⏹ forever.
        options: { ...(program !== undefined ? { program } : {}), onEnded: () => setPlaying(false) },
      });
      await created.prime();
      audio.current.synth = created;
      created.start();
      setPlaying(true);
    } catch {
      // No audio on this device, or the buffer would not build. Take the
      // button away rather than leave one that does nothing.
      setAudible(false);
      setPlaying(false);
    }
  };

  if (failed) return null;
  return (
    <div class={`flex items-center gap-2 ${className}`}>
      {audible && (
        <button
          type="button"
          class="tap-btn shrink-0 cursor-pointer"
          title={t(playing ? 'card.incipit.stop' : 'card.incipit.play')}
          onClick={() => { void toggle(); }}
        >
          {/* The same small accent disc the detection rows and the trending
              table already use for their per-row actions — a bare glyph
              beside a stave read as part of the notation. The touch target
              is the button around it, not the disc. */}
          <span
            class="w-6 h-6 rounded-full flex items-center justify-center bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            dangerouslySetInnerHTML={{ __html: playing ? stopIcon(11) : playIcon(11) }}
          />
        </button>
      )}
      {mode === 'text'
        // The NOTES ALONE — `parseAbcBlock` cuts at `K:`, the one structural
        // rule of an ABC body. The same reasoning as the stave, which shows
        // no title, no rhythm and no tempo mark either: this is a reminder of
        // how a tune starts, and four lines of header above two bars of music
        // would bury the answer under its own paperwork. The full source is
        // one tap away in the viewer.
        //
        // Selectable, unlike the stave — reading it or lifting it out is the
        // reason to want this face at all. `whitespace-pre`, not `pre-wrap`:
        // a wrapped bar is a different bar to read, so it scrolls instead.
        ? <pre class="flex-1 text-xs font-mono text-primary whitespace-pre overflow-x-auto min-w-0 m-0">{parseAbcBlock(abc).music}</pre>
        // `flex-1`, and not merely `min-w-0`: an EMPTY flex item that may
        // shrink measures zero, and this one has to be measured before there
        // is anything in it to give abcjs a width to draw at.
        //
        // No `overflow-x-auto` any more. It was the guard against a stave too
        // wide for the row, and the CSS cap in `.incipit svg` now makes that
        // impossible — while clipping was actively in the way, because a box
        // that scrolls on one axis cannot stay visible on the other, and the
        // vertical centring below spills on purpose.
        : <div ref={hostRef} class="incipit flex-1 min-w-0" aria-hidden="true" />}
    </div>
  );
}
