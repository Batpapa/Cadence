import LZString from 'lz-string';
import type { AbcOpenMode, AbcPaper, FileEntry } from '../types';
import { entryToObjectUrl, entryToBytes, arrayBufferToBase64, focusIfDesktop } from '../utils';
import { renderMarkdown, sanitizeEmphasisOnly } from './markdown';
import { mkCustomSelect } from './customSelectVanilla';
import { starIconElement, iconElement, ExternalLinkIcon, GearIcon, TrashIcon, PlusIcon, ExpandIcon, CollapseIcon,
  MetronomeIcon, TuningForkIcon, SwingStraightIcon, SwingTripletIcon, SwingDottedIcon,
  WarningTriangleIcon } from './icons';
import { t } from '../services/i18nService';
import { TUNE_TEMPOS, isAbcFile, decodeAbc, splitAbcTunes, parseAbcBlock, abcOpenMode,
  abcPaper, abcPaperSetting, ABC_PAPER_AUTO, abcBarsPerLine, abcSwing, meterCanSwing,
  ABC_PAPERS, BARS_PER_LINE_CHOICES, DEFAULT_BARS_PER_LINE,
  SWING_CHOICES, NO_SWING } from '../services/abcService';
import { modalMaxH, modalMaxW, getZoom } from '../services/zoomService';
import { showModal, updateTopModal, confirmModal } from './modal';
import { splitFileName, renamedFileName } from '../services/attachmentNames';
import { playIcon, pauseIcon, stopIcon, repeatIcon } from './playbackIcons';
import { appState, mutate } from '../store';
import { registerOverlay } from './overlayStack';

// ── ABC Transcription Tools share-link integration ────────────────────────────
// https://michaeleskin.com/abctools/userguide.html#generate_share_link — the
// documented, sanctioned integration format: LZ-String-compress the ABC text
// into a URL-safe string and pass it as `lzw=`. format=noten/editor=1 opens
// the tune straight into the editor with standard notation, matching what
// this modal already shows.
const ABC_TOOLS_BASE_URL = 'https://michaeleskin.com/abctools/abctools.html';

function abcToolsShareUrl(tuneText: string): string {
  const titleMatch = tuneText.match(/^T:\s*(.+)/m);
  const name = titleMatch ? titleMatch[1]!.trim() : 'Cadence_Tune';
  const params = new URLSearchParams({
    lzw: LZString.compressToEncodedURIComponent(tuneText),
    format: 'noten',
    name,
    editor: '1',
  });
  return `${ABC_TOOLS_BASE_URL}?${params.toString()}`;
}

// General MIDI program numbers (0-indexed) for instruments relevant to Irish
// trad — GM happens to have dedicated Fiddle/Whistle/Banjo/Bagpipe patches.
const ABC_INSTRUMENTS = [
  { value: '',    labelKey: 'fileViewer.abc.instrument.default' },
  { value: '110', labelKey: 'fileViewer.abc.instrument.fiddle' },
  { value: '78',  labelKey: 'fileViewer.abc.instrument.whistle' },
  { value: '73',  labelKey: 'fileViewer.abc.instrument.flute' },
  { value: '21',  labelKey: 'fileViewer.abc.instrument.accordion' },
  { value: '105', labelKey: 'fileViewer.abc.instrument.banjo' },
  { value: '109', labelKey: 'fileViewer.abc.instrument.pipes' },
  { value: '25',  labelKey: 'fileViewer.abc.instrument.guitar' },
];

/** Score playback speed, as a percentage of what is written. The bounds are
 *  what abcjs will actually warp to without the audio falling apart, and the
 *  low end is the point of the setting: a tune you are learning is worth
 *  hearing at half speed. */
const DEFAULT_TEMPO_PERCENT = 100;
const MIN_TEMPO_PERCENT = 10;
const MAX_TEMPO_PERCENT = 300;

/** What one press of the speed stepper is worth, in points of percentage —
 *  and the percentage is of the tune's own written tempo, which is how this
 *  music is practised ("take it at three-quarter speed"). It is also the unit
 *  `setWarp` takes, so nothing is converted on the way. */
const TEMPO_STEP_PERCENT = 5;

/** Where the transport sits, in both the dialog and the full-page reader: at
 *  the BOTTOM, centred, under the music.
 *
 *  It was pinned to the top until 2026-09-21, above the score, on the
 *  reasoning that following the cursor down a long tune must not push play out
 *  of reach. Sticking it to the bottom keeps that and answers the real
 *  objection: the controls belong where a hand rests, which is not at the top
 *  of a phone. The full-page reader had already been built that way and the
 *  user asked for the dialog to match it.
 *
 *  `-bottom-4` cancels the modal body's own `py-4`: a scroll container's
 *  padding is part of its scrollport, so content passes visibly through it and
 *  a bar stuck at `bottom-0` would leave a 16 px strip of score showing under
 *  itself. Offset by exactly the padding, it lands flush with the edge.
 *  Opaque background and a stacking order, or the notation shows through. */
const TRANSPORT_CLASS = 'abc-transport sticky -bottom-4 z-10 bg-elevated py-2 flex items-center justify-center gap-2 flex-wrap';

function abcTempoPercent(): number {
  const stored = appState.value.abcTempoPercent;
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_TEMPO_PERCENT;
  return Math.max(MIN_TEMPO_PERCENT, Math.min(MAX_TEMPO_PERCENT, Math.round(stored)));
}

// ── How big the music is drawn ────────────────────────────────────────────────
//
// A score ZOOM lived here until 2026-09-21: nine levels from 50 % to 300 %,
// stored on the User, applied by laying the score out to a narrower
// `staffwidth`. It was taken out — "sur téléphone c'est bof" — and what
// replaced it is not a zoom at all, because a zoom was the wrong answer.
//
// THE MEASUREMENT, taken in the browser on the bundle as served. `renderAbc`
// was called with `responsive: 'resize'` and NO `staffwidth`, so abcjs laid
// every score out at its own default of 740 units and the viewBox was then
// stretched or crushed to whatever box it landed in. The engraved staff — five
// lines, top to bottom, the one number legibility actually depends on — came
// out at:
//
//     348 px box → 3,9 mm      818 px → 9,3 mm
//     390 px     → 4,4 mm     1200 px → 13,6 mm
//
// against the 7 mm of printed music. A factor of 3,5 between the two ends, and
// no setting anywhere that touched it: the size of the music was a side effect
// of the width of its box. On a phone it was HALF the size of paper; on a wide
// screen nearly double, and still five bars to a line either way.
//
// THE FIX, measured the same way: hand abcjs the box's real width as
// `staffwidth` — so nothing is scaled afterwards — and let `wrap` decide how
// many bars fit. The staff then comes out at 7,7 / 7,8 / 8,0 / 8,1 / 8,2 mm
// across those same five widths, and it is the LINE that gives way, holding
// two bars on a phone and four on a desktop. Printed-score size everywhere.
//
// Which is why the zoom is not coming back as it was: on a phone the score is
// bounded by width, so magnifying it never filled the height. Re-wrapping does.

/** Narrower than this and abcjs is drawing for nobody — the modal itself never
 *  gets this small, but a box measured mid-layout can report anything. */
const MIN_ENGRAVE_WIDTH = 180;

/** How far the box has to change width before the score is re-engraved.
 *  Re-engraving rebuilds the audio buffer (see redrawPreservingPlayback), so
 *  this is deliberately coarser than the incipit's: wide enough to swallow a
 *  scrollbar appearing, which is the one width change a redraw causes itself. */
const ENGRAVE_HYSTERESIS = 24;

interface EngraveSettings {
  width: number;
  barsPerLine: number;
  ink: string;
  transpose: number;
}

/** Everything about how a score is DRAWN, in one place, so the four callers
 *  that redraw one cannot drift apart. */
function engraveOptions(s: EngraveSettings): Record<string, unknown> {
  return {
    // NO `responsive: 'resize'`, since 2026-09-21. It existed to scale a
    // 740-unit layout into whatever box it landed in, and there is nothing
    // left to scale now that the layout IS the box's width: measured at 327,
    // 390, 818 and 1150 px, the svg's own width attribute came back equal to
    // the box every time and the ink stopped 12 px short of the edge.
    //
    // Dropping it is what makes `cropToInk` below possible: a responsive
    // render writes `overflow:hidden` and a fixed height onto its target and
    // puts the drawing's height into a percentage padding, so a cropped
    // viewBox would have been clipped by the very box it was shrinking.
    add_classes: true,
    staffwidth: Math.max(MIN_ENGRAVE_WIDTH, Math.round(s.width)),
    wrap: { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: s.barsPerLine },
    // abcjs's own defaults for the sides (15/50) leave the last note of a line
    // hanging outside the box at some widths — measured. These are symmetric
    // and verified to keep the ink inside from 348 px to 1200 px.
    // `paddingtop: 0` because `cropToInk` takes the top margin off anyway, and
    // any value here is simply cropped away again.
    paddingleft: 12, paddingright: 12, paddingtop: 0, paddingbottom: 8,
    // `currentColor` is abcjs 6's own default and would work if the score were
    // drawn into the themed page; it is stated instead because the box sets its
    // own paper, which is not the colour the surrounding app uses for text.
    foregroundColor: s.ink,
    visualTranspose: s.transpose,
    format: {
      gchordfont: 'Verdana 12',
      annotationfont: 'Verdana 12',
      // Everything above the first staff that the screen around it already
      // says, or that nobody asked the score for: the title (the modal's own
      // heading, one centimetre higher), the composer, and the rhythm line
      // (`R: reel` — the card knows what kind of tune it is). Three lines of
      // vertical budget on a phone, spent saying nothing new.
      //
      // `partsfont` is deliberately LEFT ALONE: a set's fused score names its
      // tunes with `[P:]` markers, and those are the only labels in this
      // notation that carry information the reader needs.
      titlefont: 'Verdana 0',
      subtitlefont: 'Verdana 0',
      composerfont: 'Verdana 0',
      infofont: 'Verdana 0',
    },
  };
}

/** Takes the empty band off the top of an engraved score.
 *
 *  Measured on 2026-09-21, at the options above: the first staff line sat 42 px
 *  down a score whose own ink started at 27, and every pixel between was
 *  reserved for things that are not drawn — the zero-sized title block still
 *  claims ~10 px of box, and abcjs's own top margin the rest. Reported as "tout
 *  un espace inutile en haut de la partition", and it was.
 *
 *  Fixing the FONTS does not fix this; the layout is already done by the time
 *  a zero-sized font paints nothing, which is also why hiding the tempo mark in
 *  CSS reclaimed nothing. The only thing that moves the music up is re-stating
 *  the viewBox over the ink — the same trick the incipit's `fitToInk` plays,
 *  for the same reason.
 *
 *  abcjs also writes `overflow:hidden` and a fixed `height` onto the element it
 *  drew into; both are cleared, or the box stays as tall as the uncropped
 *  drawing and the space comes back underneath. */
function cropToInk(host: HTMLElement): void {
  host.style.removeProperty('overflow');
  host.style.removeProperty('height');
  host.style.removeProperty('width');
  const svg = host.querySelector('svg');
  if (!svg) return;
  const width = parseFloat(svg.getAttribute('width') ?? '') || svg.getBoundingClientRect().width;
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of Array.from(svg.querySelectorAll('path, text, rect'))) {
    let box: DOMRect;
    // getBBox throws on a detached or undisplayed element, and returns zeros
    // for an empty one; neither is ink.
    try { box = (el as SVGGraphicsElement).getBBox(); } catch { continue; }
    if (!box.width && !box.height) continue;
    top = Math.min(top, box.y);
    bottom = Math.max(bottom, box.y + box.height);
  }
  // Nothing recognisable: leave abcjs's own drawing exactly as it is rather
  // than write a viewBox computed from infinities.
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return;
  const height = bottom - top;
  svg.setAttribute('viewBox', `0 ${top.toFixed(2)} ${width} ${height.toFixed(2)}`);
  svg.setAttribute('height', String(Math.ceil(height)));
}

/** How many beats a bar of this metre is counted in, for the metronome.
 *
 *  A compound metre is counted in dotted beats, not in its own denominator: a
 *  jig in 6/8 is TWO, not six, and clicking six would be unusable at any speed
 *  this music is played at. 9/8 is three, 12/8 four; everything else counts its
 *  numerator. */
function beatsPerBar(meter: string): number {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(meter.trim());
  if (!m) return 4;
  const top = parseInt(m[1]!, 10);
  const bottom = parseInt(m[2]!, 10);
  if (!Number.isFinite(top) || top <= 0) return 4;
  if (bottom === 8 && top % 3 === 0 && top > 3) return top / 3;
  return top;
}

/** A `%%MIDI drum` pattern: one stroke per beat, the first one accented.
 *
 *  The spec is a run of `d`/`z` followed by one MIDI note per stroke and then
 *  one velocity per stroke. 76 and 77 are the two woodblocks — the pair every
 *  metronome sound in General MIDI is built from — and the first is louder so
 *  the bar has a shape to follow rather than a flat tick. */
function drumPattern(beats: number): string {
  const n = Math.max(1, Math.min(12, beats));
  const strokes = 'd'.repeat(n);
  const notes = ['76', ...Array(n - 1).fill('77')].join(' ');
  const volumes = ['95', ...Array(n - 1).fill('60')].join(' ');
  return `${strokes} ${notes} ${volumes}`;
}

// ── MIME helpers ──────────────────────────────────────────────────────────────

function isText(entry: FileEntry): boolean {
  return entry.mimeType.startsWith('text/') ||
    entry.name.endsWith('.md') || entry.name.endsWith('.txt');
}

function isMarkdown(entry: FileEntry): boolean {
  return entry.mimeType === 'text/markdown' || entry.name.endsWith('.md');
}


/** Gives a tune a `Q:` when it has none, from what its `R:` says it is — which
 *  is the normal case for TheSession's ABC.
 *
 *  It was taken OUT for a few hours on 2026-09-21, to buy back the 27 px a
 *  tempo mark reserves above the first staff, with the speed handed to the
 *  synth as `audioParams.qpm` instead. That was wrong, and measured wrong:
 *  the `Q:` is what the MIDI flattener stamps `currentTrackMilliseconds` from,
 *  and those stamps are what clicking a note seeks to. Without it they came
 *  out at 111 ms per quaver instead of 167 — while the audio kept the right
 *  speed, because SynthController takes that from `millisecondsPerMeasure()`
 *  by a different route. Two clocks, one score: every click on a note landed
 *  somewhere else.
 *
 *  `qpm` does not rescue it — passing it changed nothing in the stamps
 *  (measured both ways). So the `Q:` stays, and the 27 px are taken back by
 *  hiding the tempo MARK in CSS: `cropToInk` measures ink, and an element with
 *  `display:none` has none. */
function injectDefaultTempo(abc: string): string {
  if (/^Q:/m.test(abc)) return abc;
  const rMatch = abc.match(/^R:\s*(.+)/m);
  const tempo = rMatch ? TUNE_TEMPOS[rMatch[1]!.trim().toLowerCase()] : undefined;
  if (!tempo) return abc;
  return abc.replace(/^(K:[^\n]*)/m, `$1\nQ: ${tempo}`);
}

/** The header fields dropped before a score is ENGRAVED. The file on disk keeps
 *  every one of them; this is only what the reader is shown.
 *
 *  `S:` is a URL back to TheSession and `Z:` is who transcribed it: both are
 *  facts about where the setting came from, not things to read while playing,
 *  and the card's own source pin already says the first. `settingIndexInScore`
 *  reads `S:` off the FILE, which is untouched.
 *
 *  The fields that stay (`T:`, `R:`, `C:`) are silenced with zero-sized fonts
 *  in engraveOptions instead — that works for them because they sit in a block
 *  whose height collapses with their text. */
const STRIPPED_FOR_RENDER = /^[SZ]:/;

function stripForRender(abc: string): string {
  return abc.split('\n').filter(l => !STRIPPED_FOR_RENDER.test(l)).join('\n');
}

/** How far before a clicked note to seek — see the click handler for why an
 *  exact seek lands on the wrong note. */
const SEEK_BACKOFF_MS = 10;

/** The nearest scrolling box, starting with the element itself — the score has
 *  its own viewport, and it is that one, not the modal around it, that should
 *  move. Walking on up is a fallback for whatever hosts a score tomorrow. */
function nearestScroller(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** Playback preferences, reachable from any score's header and stored on the
 *  user, so they travel with everything else through Drive. They describe the
 *  listener rather than the tune: which instrument to hear it on, and how fast
 *  a score should open when you are still learning it.
 *
 *  `onApply` re-primes the score that is open, so a change is heard at once
 *  instead of at the next opening. */
export function showAbcPrefsModal(onApply: () => void): void {
  const body = document.createElement('div');
  body.className = 'space-y-4';

  /** One setting per line: its name on the left, its control on the right. */
  const row = (labelKey: string, control: HTMLElement): HTMLElement => {
    const line = document.createElement('div');
    line.className = 'flex items-center justify-between gap-3';
    const label = document.createElement('label');
    label.className = 'label shrink-0';
    label.textContent = t(labelKey);
    line.append(label, control);
    return line;
  };

  // ── Default speed ──
  const speedControl = document.createElement('div');
  speedControl.className = 'flex items-center gap-2 shrink-0';
  const speedInput = document.createElement('input');
  speedInput.type = 'number';
  speedInput.min = String(MIN_TEMPO_PERCENT);
  speedInput.max = String(MAX_TEMPO_PERCENT);
  speedInput.step = '5';
  speedInput.className = 'input w-20 text-sm';
  speedInput.value = String(abcTempoPercent());
  const speedUnit = document.createElement('span');
  speedUnit.className = 'text-xs text-dim';
  speedUnit.textContent = '%';
  speedControl.append(speedInput, speedUnit);

  /** Saved on every change, with no confirmation step: each setting is one
   *  value, instantly undone by setting it back. A Cancel button would only
   *  invite the question of what it reverts. */
  const persist = () => {
    const raw = parseInt(speedInput.value, 10);
    const percent = isNaN(raw) ? DEFAULT_TEMPO_PERCENT
      : Math.max(MIN_TEMPO_PERCENT, Math.min(MAX_TEMPO_PERCENT, raw));
    speedInput.value = String(percent);
    const instrument = getInstrument();
    void mutate(st => {
      // Absent rather than stored when it is the default: nothing to carry
      // through Drive, and nothing to explain to a future reader.
      if (percent === DEFAULT_TEMPO_PERCENT) delete st.abcTempoPercent; else st.abcTempoPercent = percent;
      if (instrument === '') delete st.abcInstrument; else st.abcInstrument = parseInt(instrument, 10);
    });
  };

  // Speed is SAVED ONLY. Re-priming the score would stop whatever is playing —
  // renderTune pauses and rebuilds the audio buffer — and it could not even
  // change the speed, which is frozen at the moment the score opened. All
  // disruption, no effect.
  //
  // `change`, not `input`: typing "150" passes through "1" and "15", and each
  // would be written as a preference nobody asked for.
  speedInput.addEventListener('change', persist);

  // ── Instrument ──
  const stored = appState.value.abcInstrument;
  const { el: instrSelect, getValue: getInstrument } = mkCustomSelect(
    ABC_INSTRUMENTS.map(i => ({ value: i.value, label: t(i.labelKey) })),
    stored === undefined ? '' : String(stored),
    // The instrument DOES re-prime: hearing it is the whole point of picking
    // one, and it is a change the current score can actually take on.
    () => { persist(); onApply(); },
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
  );
  // The select's own wrapper is `flex:1`, so it takes what the label leaves.
  instrSelect.style.maxWidth = '14rem';

  // ── Write a set's repeats out ──
  // The odd one out here: speed and instrument describe how a score SOUNDS,
  // this one changes what a set's fused score CONTAINS. It sits here anyway
  // because this is where a reader of that score is when the question occurs
  // to them — and because a fused score is rebuilt on every read, so the
  // change is visible the next time one is opened, with nothing stored to
  // migrate.
  const repeatsBox = document.createElement('input');
  repeatsBox.type = 'checkbox';
  repeatsBox.className = 'card-checkbox';
  repeatsBox.checked = appState.value.abcIncludeRepeats === true;
  // Re-primes like the instrument, and for a stronger reason: this one changes
  // the NOTATION, so the score on screen would otherwise keep showing how it
  // was built a moment ago. The viewer re-reads its source on apply — see
  // PreviewModalOpts.reloadEntry.
  repeatsBox.addEventListener('change', () => {
    const on = repeatsBox.checked;
    void mutate(st => { if (on) st.abcIncludeRepeats = true; else delete st.abcIncludeRepeats; })
      .then(() => onApply());
  });

  // ── Which face a score opens on ──
  // Saved only, like the speed: it describes the NEXT score to be opened, and
  // flipping the one already on screen would answer a question nobody asked —
  // the tabs are right there, two centimetres away. The incipit reads the same
  // value, so a preference set here is honoured on the card page too.
  const { el: openSelect } = mkCustomSelect(
    [
      { value: 'sheet', label: t('fileViewer.abc.sheetTab') },
      { value: 'text',  label: t('fileViewer.abc.textTab') },
    ],
    abcOpenMode(appState.value),
    (v) => void mutate(st => { st.abcOpenMode = v as AbcOpenMode; }),
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
  );
  openSelect.style.maxWidth = '14rem';

  // ── How a score is DRAWN ──
  // Here rather than on the score's own toolbar (the user's call,
  // 2026-09-21): both are set once and then left alone, which is what this
  // dialog is for, while the toolbar is for what you reach for mid-tune.
  // Both re-apply at once — they change the engraving, and the score on
  // screen would otherwise go on showing the old one.
  const { el: paperSelect } = mkCustomSelect(
    [
      { value: ABC_PAPER_AUTO, label: t('fileViewer.abc.paper.theme') },
      { value: 'dark',  label: t('fileViewer.abc.paper.dark') },
      { value: 'sepia', label: t('fileViewer.abc.paper.sepia') },
      { value: 'white', label: t('fileViewer.abc.paper.white') },
    ],
    abcPaperSetting(appState.value),
    (v) => {
      // "Thème" is the ABSENCE of a stored value, which is what lets the paper
      // keep following the app when the app changes. Anything else is written
      // explicitly — a choice that happens to match today's theme still has to
      // be stored, or switching to the light theme would silently take the
      // score with it.
      void mutate(st => {
        if (v === ABC_PAPER_AUTO) delete st.abcPaper; else st.abcPaper = v as AbcPaper;
      }).then(() => onApply());
    },
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
  );
  paperSelect.style.maxWidth = '14rem';

  const { el: densitySelect } = mkCustomSelect(
    BARS_PER_LINE_CHOICES.map(n => ({ value: String(n), label: t('fileViewer.abc.barsPerLine', { n: String(n) }) })),
    String(abcBarsPerLine(appState.value)),
    (v) => {
      const n = parseInt(v, 10);
      void mutate(st => {
        if (n === DEFAULT_BARS_PER_LINE) delete st.abcBarsPerLine; else st.abcBarsPerLine = n;
      }).then(() => onApply());
    },
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
  );
  densitySelect.style.maxWidth = '14rem';

  body.append(
    row('fileViewer.abc.prefs.speed', speedControl),
    row('fileViewer.abc.instrument', instrSelect),
    row('fileViewer.abc.paper', paperSelect),
    row('fileViewer.abc.prefs.barsPerLine', densitySelect),
    row('fileViewer.abc.prefs.includeRepeats', repeatsBox),
    row('fileViewer.abc.prefs.openOn', openSelect),
  );

  // No footer: nothing to confirm, so nothing to press. The ✕ is the only way
  // out, and it closes on a state that has already been saved.
  showModal(t('fileViewer.abc.prefs.title'), body, []);
  focusIfDesktop(speedInput);
}

/** How far up or down the score is written out, asked in a dialog of its own.
 *
 *  The same shape as the analyser's pitch control, deliberately: one round
 *  button in the bar, and the choice made somewhere with room to say what it
 *  means. Unlike that one there is no sign to untangle here — `visualTranspose`
 *  raises the written music by the number it is given, which is what every
 *  musician means by "up two".
 *
 *  `onPick` fires on every press, not on a confirmation: each tap IS the
 *  change, the score behind redraws, and the ✕ is the only way out that makes
 *  sense for a control you judge by looking at the result. */
function showTransposeModal(current: number, limit: number, onPick: (semitones: number) => void): void {
  let value = current;

  const body = document.createElement('div');
  body.className = 'space-y-4';

  const row = document.createElement('div');
  row.className = 'flex items-center justify-center gap-5';
  const stepBtn = 'btn-ghost border border-border w-11 h-11 p-0 rounded-full flex items-center justify-center shrink-0 text-lg leading-none';

  const down = document.createElement('button');
  down.className = stepBtn;
  down.textContent = '−';
  down.setAttribute('aria-label', t('fileViewer.abc.transposeDown'));
  const readout = document.createElement('span');
  readout.className = 'font-mono tabular-nums text-2xl text-center';
  readout.style.width = '3ch';
  const up = document.createElement('button');
  up.className = stepBtn;
  up.textContent = '+';
  up.setAttribute('aria-label', t('fileViewer.abc.transposeUp'));
  row.append(down, readout, up);

  const said = document.createElement('p');
  said.className = 'text-sm text-primary text-center leading-relaxed';

  const reset = document.createElement('button');
  reset.className = 'btn-ghost text-xs w-full';
  reset.textContent = t('fileViewer.abc.transposeReset');

  /** The number said out loud, so the sign never has to be read to know what
   *  was set — the failure the analyser's control was rebuilt to fix. */
  const describe = (n: number): string => {
    if (n === 0) return t('fileViewer.abc.transpose.asWritten');
    const dir = n < 0 ? 'down' : 'up';
    const m = Math.abs(n);
    if (m === 1) return t(dir === 'up' ? 'fileViewer.abc.transpose.semitoneUp' : 'fileViewer.abc.transpose.semitoneDown');
    if (m === 2) return t(dir === 'up' ? 'fileViewer.abc.transpose.toneUp' : 'fileViewer.abc.transpose.toneDown');
    return t(dir === 'up' ? 'fileViewer.abc.transpose.semitonesUp' : 'fileViewer.abc.transpose.semitonesDown', { n: String(m) });
  };

  const paint = () => {
    readout.textContent = value === 0 ? '0' : (value > 0 ? `+${value}` : String(value));
    readout.className = `font-mono tabular-nums text-2xl text-center ${value === 0 ? 'text-dim' : 'text-accent font-semibold'}`;
    readout.style.width = '3ch';
    said.textContent = describe(value);
    down.toggleAttribute('disabled', value <= -limit);
    up.toggleAttribute('disabled', value >= limit);
    // `display`, not `visibility`: hidden by visibility it still held its line,
    // and an empty band under the sentence is a gap nobody can explain.
    reset.style.display = value === 0 ? 'none' : '';
  };
  const step = (d: number) => {
    const next = Math.max(-limit, Math.min(limit, value + d));
    if (next === value) return;
    value = next;
    paint();
    onPick(value);
  };
  down.onclick = () => step(-1);
  up.onclick = () => step(1);
  reset.onclick = () => { if (value !== 0) { value = 0; paint(); onPick(0); } };
  paint();

  body.append(row, said, reset);
  showModal(t('fileViewer.abc.transpose'), body, [], { maxWidth: '20rem' });
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function modalWidth(entry: FileEntry): string {
  const m = entry.mimeType;
  if (m.startsWith('audio/') || (isText(entry) && !isAbcFile(entry))) return '560px';
  return '860px';
}

export interface PreviewModalOpts {
  /** Multi-tune ABC files: which splitAbcTunes() index to open at — the
   *  attachment's stored `preferredIndex`, if any. */
  initialIndex?: number;
  /** Called when the user stars a version as the new default. Independent of
   *  `onSave` — available in read-only contexts (study) too, since picking a
   *  favorite version isn't "editing" the card's content. */
  /** `undefined` clears the preference — see the star button for what that means. */
  onSetPreferredIndex?: (index: number | undefined) => void;
  /** Which version wears the ★, `undefined` meaning none does.
   *
   *  Separate from `initialIndex` because the two only coincide where the
   *  viewer opens a score AT its favourite. A session summary opens one at the
   *  version just PLAYED, while the star belongs wherever the card actually put
   *  it — possibly nowhere.
   *
   *  Deliberately NOT defaulted to `initialIndex`: that would make "no
   *  favourite" indistinguishable from "field omitted" and light the star on
   *  whatever version happened to be opened, which is exactly what a session
   *  preview showed on 2026-09-06. Every caller offering `onSetPreferredIndex`
   *  states it. */
  favoriteIndex?: number;
  /** Re-reads the file, for an entry whose content is DERIVED and can change
   *  while it is open. A set's fused score is rebuilt from its member tunes on
   *  every read, so a preference that changes how it is built — writing the
   *  repeats out, say — has to reach the score already on screen; the viewer
   *  otherwise redraws the text it decoded when it opened.
   *
   *  Called on every preference re-apply. Return null to keep what is shown. */
  reloadEntry?: () => FileEntry | null;
  /** Makes the title renamable (the extension stays as it is). Gets the full
   *  new name; the viewer shows it itself. */
  onRename?: (name: string) => void;
}

/** What a save did. `false`: nothing was saved — the user backed out of a
 *  question the save had to ask — and the edit stays pending on screen. A
 *  string: saved, under that file name, which the viewer's title then shows. */
export type PreviewSaveResult = void | false | string;

export function showPreviewModal(
  entry: FileEntry,
  onSave?: (data: string) => PreviewSaveResult | Promise<PreviewSaveResult>,
  opts?: PreviewModalOpts,
): void {
  // What the title shows, as renames and a save-as-copy change it.
  let shownName = entry.name;
  // Overlay/dialog/header/close-button/outside-click/Escape are the shared
  // Preact modal shell (modal.tsx, 2026-08-26) now — only this format-specific
  // body is still hand-built here. `stopAudio`/`closed` (assigned deeper in
  // the audio/abc branches below) are read by onDismiss, called once the
  // modal actually closes for any reason (✕, outside click, Escape).
  let stopAudio: () => void = () => {};
  let closed = false;
  // Set by the ABC branch, which is the only one with a keyboard shortcut to
  // take down. A document-level listener outliving its modal would keep
  // swallowing the space bar for the rest of the session.
  let releaseKeys: () => void = () => {};
  // Set by the PDF branch when pdf.js draws the pages: its worker and canvases
  // go with the modal.
  let releasePdf: () => void = () => {};
  // Set by the ABC branch: a score given the whole page lives in an overlay of
  // its own, outside this dialog, and has to come down with it.
  let releaseFullscreen: () => void = () => {};
  const onDismiss = () => { closed = true; stopAudio(); releaseKeys(); releasePdf(); releaseFullscreen(); };

  const body = document.createElement('div');
  body.className = 'w-full flex items-center justify-center';

  // Filled in by the ABC branch; the header gear needs a way to re-prime the
  // score once preferences change, and only that branch knows how.
  let reapplyAbcPrefs: (() => void) | null = null;
  // Same shape, for the dialog's own "Full page": the score branch is the only
  // one that sizes anything against the room the dialog has.
  let onModalExpanded: ((expanded: boolean) => void) | null = null;

  const m = entry.mimeType;
  // 0.85 (not 0.9) to match the shared modal shell's own dialog max-height
  // (modal.tsx) now that this modal is portaled through it — media sized
  // against a bigger budget than the dialog actually allows would overflow.
  const mediaMaxH = `calc(${modalMaxH(0.85)} - 80px)`;

  if (m.startsWith('audio/')) {
    body.classList.replace('items-center', 'items-start');
    import('./audioPlayer').then(({ renderAudioPlayer, stopCurrentAudio }) => {
      // Modal may already have been dismissed while this dynamic import was
      // in flight — don't spin up an AudioContext nobody will ever close.
      if (closed) return;
      body.appendChild(renderAudioPlayer(entry));
      stopAudio = stopCurrentAudio;
    });

  } else if (m.startsWith('video/')) {
    const video = document.createElement('video'); video.controls = true; video.className = 'max-w-full rounded';
    video.style.maxHeight = mediaMaxH;
    video.src = entryToObjectUrl(entry);
    body.appendChild(video);

  } else if (m.startsWith('image/')) {
    const img = document.createElement('img'); img.src = entryToObjectUrl(entry); img.alt = entry.name;
    img.className = 'max-w-full object-contain rounded';
    img.style.maxHeight = mediaMaxH;
    img.style.cursor = 'zoom-in';

    img.addEventListener('click', () => {
      const lightbox = document.createElement('div');
      lightbox.style.cssText = 'position:fixed;inset:0;z-index:100;background:black;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
      const big = document.createElement('img');
      big.src = img.src; big.alt = img.alt;
      big.style.cssText = `max-width:${modalMaxW(1.0)};max-height:${modalMaxH(1.0)};object-fit:contain;`;
      lightbox.appendChild(big);
      let unregisterLightbox = () => {};
      const closeLightbox = () => {
        unregisterLightbox();
        lightbox.remove();
      };
      // No Escape listener of its own. It used to need a CAPTURING one with
      // stopImmediatePropagation, for one reason: the modal underneath ran its
      // own listener, and without cutting the event off, one Escape closed the
      // enlarged image and the dialog behind it. Registering as an overlay
      // says the same thing properly — this is on top, so this is what closes.
      lightbox.addEventListener('click', closeLightbox);
      document.body.appendChild(lightbox);
      unregisterLightbox = registerOverlay(closeLightbox);
    });

    body.appendChild(img);

  } else if (m === 'application/pdf') {
    // `!== false`, not truthy: a browser too old to have the property at all
    // is a desktop one with its viewer, and keeps getting the frame it had.
    if (navigator.pdfViewerEnabled !== false) {
      // An <embed> loading a blob: URL is governed by the page's object-src —
      // which must keep allowing blob: (webpack.config.js's CSP). With 'none'
      // this rendered an empty frame and said nothing (2026-09-06 to 14).
      const embed = document.createElement('embed'); embed.src = entryToObjectUrl(entry);
      embed.type = 'application/pdf'; embed.className = 'w-full rounded';
      embed.style.height = mediaMaxH;
      body.appendChild(embed);
    } else {
      // No inline PDF viewer here — Chrome on Android, first of all — so an
      // <embed> would stay an empty frame. The pages are drawn with pdf.js
      // instead, loaded only now (see pdfCanvas.ts). Handing the file to the
      // device was tried first and turned down: on the phone it downloaded.
      const frame = document.createElement('div');
      frame.className = 'w-full overflow-y-auto';
      frame.style.maxHeight = mediaMaxH;
      const loading = document.createElement('p');
      loading.className = 'text-sm text-muted text-center py-6';
      loading.textContent = t('fileViewer.pdf.loading');
      frame.appendChild(loading);
      body.appendChild(frame);

      import('./pdfCanvas')
        .then(({ renderPdfPages }) => renderPdfPages(frame, entryToBytes(entry), () => closed))
        .then(release => { if (closed) release(); else releasePdf = release; })
        .catch(() => {
          if (closed) return;
          // Last resort — a PDF pdf.js cannot read, or its code not loadable
          // (offline before it was ever fetched): the device may still open it.
          const box = document.createElement('div');
          box.className = 'flex flex-col items-center gap-4 py-6 text-center';
          const msg = document.createElement('p');
          msg.className = 'text-sm text-muted leading-relaxed max-w-sm';
          msg.textContent = t('fileViewer.pdf.failed');
          const open = document.createElement('a');
          open.href = entryToObjectUrl(entry);
          open.download = entry.name;
          open.className = 'btn-primary';
          open.textContent = t('fileViewer.pdf.open');
          box.append(msg, open);
          frame.replaceChildren(box);
        });
    }

  } else if (isAbcFile(entry)) {
    body.classList.replace('items-center', 'items-start');
    let abcText = decodeAbc(entry);

    // Reassignable, because a derived score can be rebuilt under the open
    // viewer — see PreviewModalOpts.reloadEntry.
    let tunes = splitAbcTunes(abcText);
    let versionCount = tunes.length;
    let currentIndex = Math.max(0, Math.min(versionCount - 1, opts?.initialIndex ?? 0));
    let favoriteIndex = opts?.favoriteIndex;
    // Where this score lands, from the user's preference — the stave unless
    // they said otherwise. Read once, at opening: the tabs below reassign it
    // freely and never write it back.
    let currentMode: 'sheet' | 'text' = abcOpenMode(appState.value);
    // Set when a text-mode edit is saved while notation is hidden — abcjs's
    // resize handling can make the SVG visibly reflow back in even inside a
    // display:none container (see setAbcMode's comment below), so the
    // re-render is deferred until the Sheet tab is actually reopened instead
    // of running immediately into the hidden view.
    let sheetNeedsRerender = false;
    // Both come from the user's preferences now; the score itself has no say,
    // and no per-score override — one place to set it, one place to look.
    let selectedProgram: number | undefined = appState.value.abcInstrument;
    // Read ONCE, when the score opens, and never again. The setting is "how
    // fast a score starts", so changing it must leave the score already open
    // exactly as it is — including a speed the user has since dialled in on the
    // transport. The instrument, by contrast, is re-read on every re-prime:
    // hearing the change at once is the point of choosing one.
    const openingTempoPercent = abcTempoPercent();

    // ── How this score READS and SOUNDS, for as long as it is open ──
    // Paper, density and swing are the user's stored preferences and are
    // written back the moment they are changed here: unlike the opening speed,
    // these describe how the reader wants to see and hear a score, and a
    // reader who turns the page dark wants the next one dark too.
    let paper: AbcPaper = abcPaper(appState.value);
    let barsPerLine = abcBarsPerLine(appState.value);
    let swing = abcSwing(appState.value);
    // Transposition is the exception: it belongs to the READING, not to the
    // reader — a whistle player in D does not want every score they open
    // shifted for the one tune they were reading in B flat. It starts at zero
    // on every opening and is never stored.
    let transpose = 0;

    const container = document.createElement('div');
    container.className = 'w-full space-y-3';

    // ── Top row: Sheet/ABC tabs + version nav + the tools that act on the score ──
    // `flex-wrap`, because this row now carries the reading controls too and a
    // phone cannot hold all of them on one line. Wrapping puts the tool group
    // under the tabs rather than squeezing every target below the size a thumb
    // can hit — which is the complaint these controls exist to answer.
    const topRow = document.createElement('div');
    topRow.className = 'flex items-center justify-between gap-2 flex-wrap';

    const tabBar = document.createElement('div');
    tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg w-fit';
    const mkAbcTab = (label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      // `min-h-[2.25rem]`: 36 layout px, which the app's own zoom turns into 45
      // on a desktop and 32,4 on a phone — the floor `.tap-btn` sets everywhere
      // else. These were 24 px tall until 2026-09-21.
      b.className = 'px-3 min-h-[2.25rem] text-xs font-medium rounded transition-colors cursor-pointer';
      return b;
    };
    const sheetTabBtn = mkAbcTab(t('fileViewer.abc.sheetTab'));
    const textTabBtn  = mkAbcTab(t('fileViewer.abc.textTab'));
    sheetTabBtn.onclick = () => setAbcMode('sheet');
    textTabBtn.onclick  = () => setAbcMode('text');
    tabBar.append(sheetTabBtn, textTabBtn);

    const versionNav = document.createElement('div');
    versionNav.className = `flex items-center gap-1 p-1 bg-bg rounded-lg w-fit ${versionCount <= 1 ? 'hidden' : ''}`;
    const mkNavBtn = (glyph: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = glyph;
      b.className = 'abc-tool-btn text-xs font-medium text-muted hover:text-primary hover:bg-elevated disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted';
      return b;
    };
    const prevBtn = mkNavBtn('←');
    const versionLabel = document.createElement('span');
    versionLabel.className = 'px-1 text-xs font-medium text-muted tabular-nums';
    const nextBtn = mkNavBtn('→');
    prevBtn.onclick = () => goToVersion(currentIndex - 1);
    nextBtn.onclick = () => goToVersion(currentIndex + 1);
    versionNav.append(prevBtn, versionLabel, nextBtn);

    // ★ "set as default version" — independent of onSave, works read-only too
    // (picking a favorite version isn't editing the card's content). Declared
    // before goToVersion() below so it can refresh the star on every navigation.
    let updateStarBtn: (() => void) | null = null;
    const onSetPreferredIndex = opts?.onSetPreferredIndex;
    if (onSetPreferredIndex) {
      const starBtn = document.createElement('button');
      updateStarBtn = () => {
        // Strictly the stored preference. A score with several versions and
        // none chosen shows NO star at all: it still opens on the first,
        // because that is how every reader defaults an absent value, but
        // "where this opens by default" is not "the one you picked", and
        // lighting the first would invent a choice nobody made.
        const isFavorite = currentIndex === favoriteIndex;
        starBtn.innerHTML = '';
        starBtn.appendChild(starIconElement(isFavorite, 12));
        starBtn.className = `abc-tool-btn ${isFavorite ? 'text-warn' : 'text-muted hover:text-warn'}`;
        starBtn.title = t(isFavorite ? 'fileViewer.abc.isDefault' : 'fileViewer.abc.setDefault');
      };
      starBtn.onclick = () => {
        // A second click on the starred version CLEARS the choice rather than
        // rewriting it — which is what made it look dead before 2026-09-06.
        // Back to no favourite, not to another one.
        const clearing = currentIndex === favoriteIndex;
        favoriteIndex = clearing ? undefined : currentIndex;
        onSetPreferredIndex(favoriteIndex);
        updateStarBtn!();
      };
      updateStarBtn();
      versionNav.insertBefore(starBtn, nextBtn);
    }

    const abcToolsLink = document.createElement('a');
    abcToolsLink.target = '_blank';
    abcToolsLink.rel = 'noopener noreferrer';
    abcToolsLink.title = t('fileViewer.abc.openInAbcTools');
    abcToolsLink.className = 'abc-tool-btn text-muted hover:text-accent';
    abcToolsLink.appendChild(iconElement(ExternalLinkIcon, 14));

    // ── What is left in the row ──────────────────────────────────────────────
    // The paper and the bars per line lived here until the user moved them
    // (2026-09-21): they are set once and then left alone for months, which is
    // what the gear is for, and two more buttons beside the tabs was two more
    // things to read past on every score. They are in the preferences now
    // (showAbcPrefsModal), and this row keeps only what you reach for WHILE
    // reading: the way out to abcTools, and the full page.
    const toolGroup = document.createElement('div');
    toolGroup.className = 'flex items-center gap-1';

    /** One of the row's icon buttons, in the app's own language rather than
     *  the score's: these sit on the dialog, not on the paper. */
    const mkToolBtn = (icon: Element, title: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.appendChild(icon);
      b.title = title;
      b.className = 'abc-tool-btn text-muted hover:text-primary hover:bg-bg';
      b.addEventListener('click', () => b.blur());
      return b;
    };

    const fullscreenBtn = mkToolBtn(iconElement(ExpandIcon, 14), t('fileViewer.abc.fullscreen'));

    toolGroup.append(abcToolsLink, fullscreenBtn);
    topRow.append(tabBar, versionNav, toolGroup);
    container.appendChild(topRow);

    // ── What abcjs made of the ABC ───────────────────────────────────────────
    // Shown on BOTH faces, and on purpose. The stave is where a wrong bar is
    // noticed and the source is where it is fixed, and a warning that only
    // appeared next to the text would be invisible to the person who can see
    // the music is wrong but does not read ABC.
    const warnRow = document.createElement('div');
    warnRow.className = 'hidden flex-col gap-1 px-3 py-2 rounded-lg text-xs border border-warn/30 bg-warn/10 text-primary';
    container.appendChild(warnRow);

    /** Fills the strip, or hides it. abcjs's warnings carry their own position
     *  ("Music Line:7 Char:12") and are shown as it writes them: they are a
     *  parser's words about a file the user wrote, and rewording them would
     *  cost the one thing that makes them useful. */
    const showWarnings = (list: string[]) => {
      warnRow.replaceChildren();
      if (list.length === 0) { warnRow.classList.add('hidden'); warnRow.classList.remove('flex'); return; }
      const head = document.createElement('div');
      head.className = 'flex items-center gap-2 text-warn font-medium';
      head.appendChild(iconElement(WarningTriangleIcon, 13));
      const headText = document.createElement('span');
      headText.textContent = t('fileViewer.abc.warnings', { n: String(list.length) });
      head.appendChild(headText);
      warnRow.appendChild(head);
      // Capped, because a file that is wrong everywhere is wrong in one way
      // and the list would push the music off the screen to say so.
      for (const w of list.slice(0, 4)) {
        const line = document.createElement('div');
        line.className = 'abc-warning text-muted leading-relaxed break-words';
        // abcjs marks the offending character with markup of its own, around a
        // quote of the user's own ABC — so the string is neither plain text nor
        // safe HTML. `textContent` printed the tags; `innerHTML` would run the
        // attachment. Sanitised down to `<em>` and nothing else, and the
        // emphasis is painted from CSS (see `.abc-warning em`).
        line.textContent = w;
        void sanitizeEmphasisOnly(w).then(html => { line.innerHTML = html; }).catch(() => { /* keep the text */ });
        warnRow.appendChild(line);
      }
      if (list.length > 4) {
        const more = document.createElement('div');
        more.className = 'text-dim';
        more.textContent = t('fileViewer.abc.warningsMore', { n: String(list.length - 4) });
        warnRow.appendChild(more);
      }
      warnRow.classList.remove('hidden');
      warnRow.classList.add('flex');
    };

    const uid = Date.now();

    // ── One transport row ────────────────────────────────────────────────────
    // abcjs's own widget and our practice controls on the SAME line, since
    // 2026-09-21. Dropping the progress bar — it said what the cursor on the
    // staff already says — left the widget three buttons and a clock wide,
    // which is exactly the room the transposition, the speed and the metronome
    // needed. Two stacked bars for four controls was the earlier shape and it
    // spent a centimetre of a phone screen on nothing.
    const transportBar = document.createElement('div');
    transportBar.className = TRANSPORT_CLASS;
    // Appended AFTER the score, further down — see the note there. Built here
    // because `controls` inside it has to exist before abcjs is handed its id.

    // abcjs writes its widget into this, and into nothing else: it is handed
    // to `SynthController.load` by id and everything inside belongs to the
    // library. Ours goes beside it, never in it.
    const controls = document.createElement('div');
    controls.id = `abc-controls-${uid}`;
    controls.className = 'shrink-0';
    transportBar.appendChild(controls);

    // The rest of the row: the key, the speed, the click and the swing, in the
    // app's own language. All of it has been one option away in abcjs since
    // the beginning and none of it was ever asked for.
    const practiceRow = document.createElement('div');
    practiceRow.className = 'flex items-center gap-1.5 flex-wrap';
    transportBar.appendChild(practiceRow);

    /** abcjs's own glyphs swapped for the app's, after its widget is built.
     *
     *  The images are module-level `require`s in create-synth-control.js, not
     *  options, so there is no way to hand it ours — the DOM is edited after
     *  the fact instead. What must survive is the CLASSES: abcjs shows and
     *  hides play/pause/loading purely through `.abcjs-play-svg` and friends
     *  (abcjs-audio.css), so each replacement carries the class of the glyph it
     *  replaces and the toggling keeps working untouched. The loading spinner
     *  is left exactly as it is — it has an animation of its own and the app
     *  has nothing to put in its place. */
    const dressTransport = () => {
      const root = controls.querySelector('.abcjs-inline-audio');
      if (!root) return;
      const classed = (svg: string, cls: string) => svg.replace('<svg ', `<svg class="${cls}" `);
      const start = root.querySelector('.abcjs-midi-start');
      if (start) {
        // Kept, not rebuilt: it is the one glyph here that is not ours.
        const loading = start.querySelector('.abcjs-loading-svg')?.outerHTML ?? '';
        start.innerHTML = classed(playIcon(15), 'abcjs-play-svg')
          + classed(pauseIcon(15), 'abcjs-pause-svg')
          + loading;
      }
      const reset = root.querySelector('.abcjs-midi-reset');
      if (reset) {
        reset.innerHTML = stopIcon(15);
        // abcjs calls this "restart" and it means rewind: pressed mid-tune it
        // jumps to the beginning and CARRIES ON PLAYING. The app's stop button
        // means stop, everywhere else it appears, so this one is made to mean
        // the same — pause first, then let abcjs rewind.
        //
        // Capturing, so the pause lands before abcjs's own handler runs, and
        // the order is pause-then-rewind rather than the other way about.
        reset.addEventListener('click', () => pauseIfPlaying(), true);
      }
      const loop = root.querySelector('.abcjs-midi-loop');
      if (loop) loop.innerHTML = repeatIcon(15);
      // Play, stop, repeat — the order the audio player has them in, and the
      // order they were asked for. abcjs builds loop / restart / play, so all
      // three move: play to the front, then stop, then the loop after it.
      if (start) root.prepend(start);
      if (start && reset) start.after(reset);
      if (reset && loop) reset.after(loop);
    };

    /** Late-bound, because the things these act on live inside the abcjs
     *  import: the tempo needs the synth, the rest need a re-draw. */
    let applyWarp: (percent: number) => void = () => {};
    /** Stops the sound if any is coming out, leaving the position alone — the
     *  first half of what the stop button does, the rewind being abcjs's own.
     *  Late-bound for the same reason: the controller lives inside the import. */
    let pauseIfPlaying: () => void = () => {};

    /** A group of three: down, the value, up. The value itself is a button and
     *  resets — a stepper you can only walk back one press at a time is the
     *  reason nobody ever returns to the written key. */
    const mkStepper = (titles: { down: string; up: string; reset: string }, onStep: (d: -1 | 1) => void, onReset: () => void) => {
      const group = document.createElement('div');
      group.className = 'flex items-center rounded-lg border border-border bg-bg';
      const down = document.createElement('button');
      down.className = 'abc-tool-btn text-muted hover:text-primary';
      down.title = titles.down;
      down.setAttribute('aria-label', titles.down);
      down.textContent = '−';
      const value = document.createElement('button');
      value.className = 'px-2 min-h-[2.25rem] text-xs font-medium tabular-nums text-primary cursor-pointer transition-colors hover:text-accent';
      value.title = titles.reset;
      const up = document.createElement('button');
      up.className = 'abc-tool-btn text-muted hover:text-primary';
      up.title = titles.up;
      up.setAttribute('aria-label', titles.up);
      up.textContent = '+';
      down.onclick = () => { down.blur(); onStep(-1); };
      up.onclick = () => { up.blur(); onStep(1); };
      value.onclick = () => { value.blur(); onReset(); };
      group.append(down, value, up);
      return { group, value };
    };

    /** An on/off chip. Its state is in its colour and in `aria-pressed`, not in
     *  a tick: these are three switches in a row and a row of ticks reads as a
     *  list of things rather than as three independent answers. */
    const mkToggleChip = (icon: Element | null, label: string | null, title: string, initial: boolean, onChange: (on: boolean) => void) => {
      const b = document.createElement('button');
      let on = initial;
      b.title = title;
      // Named for a screen reader even when the chip is an icon on its own —
      // and `aria-pressed` rather than a tick, because the row is three
      // independent switches and not a list of things.
      b.setAttribute('aria-label', title);
      const paint = () => {
        b.className = `abc-chip ${on ? 'abc-chip-on' : ''}`;
        b.setAttribute('aria-pressed', String(on));
      };
      if (icon) b.appendChild(icon);
      if (label) {
        const span = document.createElement('span');
        span.textContent = label;
        b.appendChild(span);
      }
      paint();
      b.onclick = () => { b.blur(); on = !on; paint(); onChange(on); };
      return b;
    };

    // ── Transposition ──
    // Not stored, unlike everything beside it: it belongs to the reading, not
    // to the reader. A whistle player who shifts one tune to B flat does not
    // want every score they open afterwards shifted with it.
    // One round button that opens a dialog, exactly like the analyser's own
    // pitch control (PitchShiftControl) — the user's call, and for the same
    // reason it was built that way there: a "− value +" stepper inline is about
    // three times the width of a button in a bar that is already full, and the
    // room a dialog buys is what lets the question be asked in words.
    //
    // Icon at rest, its own value once set. A colour change alone would say
    // "something is on" without saying what, which is the whole failure this
    // shape exists to avoid.
    const TRANSPOSE_LIMIT = 12;
    const transposeBtn = document.createElement('button');
    transposeBtn.className = 'abc-chip';
    const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
    function updateTranspose(): void {
      transposeBtn.replaceChildren();
      if (transpose === 0) {
        transposeBtn.appendChild(iconElement(TuningForkIcon, 14));
      } else {
        transposeBtn.appendChild(iconElement(TuningForkIcon, 14));
        const v = document.createElement('span');
        v.className = 'font-mono tabular-nums';
        v.textContent = signed(transpose);
        transposeBtn.appendChild(v);
      }
      transposeBtn.classList.toggle('abc-chip-on', transpose !== 0);
      transposeBtn.title = t('fileViewer.abc.transpose');
      transposeBtn.setAttribute('aria-label', t('fileViewer.abc.transpose'));
    }
    updateTranspose();
    transposeBtn.onclick = () => {
      transposeBtn.blur();
      showTransposeModal(transpose, TRANSPOSE_LIMIT, (next) => {
        if (next === transpose) return;
        transpose = next;
        updateTranspose();
        redrawScore();
      });
    };

    // ── Speed ──
    // A percentage of the tune's written tempo. abcjs's own percent field is
    // hidden (see `displayWarp` below) so there is one speed on screen, not two.
    let tempoPercent = openingTempoPercent;
    const tempoStepper = mkStepper(
      { down: t('fileViewer.abc.slower'), up: t('fileViewer.abc.faster'), reset: t('fileViewer.abc.prefs.speed') },
      (d) => {
        // A percentage OF THE WRITTEN TEMPO, five points a press. It was a BPM
        // stepper for a few hours and the user asked for the percentage back:
        // "half speed" and "three-quarter speed" are how this music is
        // practised, and they are the same instruction whatever the tune is
        // written at — 95 BPM means nothing without knowing the tune.
        const next = Math.max(MIN_TEMPO_PERCENT, Math.min(MAX_TEMPO_PERCENT, tempoPercent + d * TEMPO_STEP_PERCENT));
        if (next === tempoPercent) return;
        tempoPercent = next;
        updateTempo();
        applyWarp(tempoPercent);
      },
      () => {
        if (tempoPercent === DEFAULT_TEMPO_PERCENT) return;
        tempoPercent = DEFAULT_TEMPO_PERCENT;
        updateTempo();
        applyWarp(tempoPercent);
      },
    );
    function updateTempo(): void {
      tempoStepper.value.textContent = `${tempoPercent} %`;
      tempoStepper.value.classList.toggle('text-accent', tempoPercent !== DEFAULT_TEMPO_PERCENT);
      tempoStepper.value.classList.toggle('text-primary', tempoPercent === DEFAULT_TEMPO_PERCENT);
    }
    updateTempo();

    // ── The click, and the swing ──
    // The swing is stored; the metronome is NOT, and starts off on every score
    // (the user's call). A click is something you put on for a passage you are
    // working out, not a way you like scores to sound — and one that came back
    // by itself on the next tune would be a small annoyance every time.
    let metronome = false;
    const metronomeChip = mkToggleChip(iconElement(MetronomeIcon, 14), null, t('fileViewer.abc.metronome'), metronome, (on) => {
      metronome = on;
      // The drum is baked into the audio buffer, so it takes a re-prime — which
      // is what a re-draw does.
      redrawScore();
    });

    // Four feels, cycled by one button, and drawn as the pair of notes each one
    // produces rather than named: the label ("swing ternaire") was wider than
    // the transport beside it, and the shape is what a player reads off a page
    // anyway. The NAME is still there, in the tooltip and for a screen reader.
    //
    // Right-click walks BACK through them, so a cycle of four is never three
    // presses away from the one you wanted. `contextmenu` rather than a long
    // press: this is a pointer affordance, and on a touch screen a fifth press
    // simply comes round again.
    //
    // abcjs does the work (its `addSwing`); all this chooses is the number.
    const swingBtn = document.createElement('button');
    swingBtn.className = 'abc-chip';
    const swingLabels: Record<number, string> = {
      50: t('fileViewer.abc.swing.straight'),
      60: t('fileViewer.abc.swing.light'),
      66: t('fileViewer.abc.swing.triplet'),
      75: t('fileViewer.abc.swing.dotted'),
    };
    // The light 3:2 wears the straight pair's glyph: it is written as two even
    // quavers, and what says it is swung is the chip being lit — which is how
    // the page says it too.
    const swingGlyphs: Record<number, typeof SwingStraightIcon> = {
      50: SwingStraightIcon,
      60: SwingStraightIcon,
      66: SwingTripletIcon,
      75: SwingDottedIcon,
    };
    /** Whether this tune's metre swings at all — see meterCanSwing. */
    const swingApplies = () => meterCanSwing(parseAbcBlock(tunes[currentIndex] ?? '').meter);
    const updateSwing = () => {
      // GONE, not greyed out, where the metre cannot swing: abcjs simply has
      // no way to swing a jig (see meterCanSwing), so the control has nothing
      // to offer and a disabled chip is a question the reader has to answer
      // before moving on. It comes back by itself on a version in 4/4.
      swingBtn.style.display = swingApplies() ? '' : 'none';
      swingBtn.replaceChildren(iconElement(swingGlyphs[swing] ?? SwingStraightIcon, 16));
      swingBtn.classList.toggle('abc-chip-on', swing !== NO_SWING);
      const name = swingLabels[swing] ?? swingLabels[NO_SWING]!;
      swingBtn.title = `${t('fileViewer.abc.swing')} · ${name}`;
      swingBtn.setAttribute('aria-label', `${t('fileViewer.abc.swing')} · ${name}`);
    };
    const stepSwing = (d: 1 | -1) => {
      const i = SWING_CHOICES.findIndex(c => c.value === swing);
      const n = SWING_CHOICES.length;
      swing = SWING_CHOICES[((i < 0 ? 0 : i) + d + n) % n]!.value;
      updateSwing();
      void mutate(st => { if (swing === NO_SWING) delete st.abcSwing; else st.abcSwing = swing; });
      // Swing is applied when the note map is built, so it needs the buffer
      // rebuilt — same as the metronome.
      redrawScore();
    };
    updateSwing();
    swingBtn.onclick = () => { swingBtn.blur(); stepSwing(1); };
    swingBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      swingBtn.blur();
      stepSwing(-1);
    });

    // Order: what you change while playing first (speed), then the feel, then
    // the key — which is set once for a tune and then left alone.
    practiceRow.append(tempoStepper.group, metronomeChip, swingBtn, transposeBtn);

    // A frame AROUND the score, holding both it and the controls that float
    // over it. The controls cannot sit inside the score itself: that box
    // scrolls, and an absolutely positioned child of a scrolling box scrolls
    // away with the music. The frame does not scroll, so they stay put.
    const scoreFrame = document.createElement('div');
    scoreFrame.className = 'relative w-full';
    container.appendChild(scoreFrame);
    // The transport goes UNDER the score, which is why it is appended here and
    // not where it was built (see TRANSPORT_CLASS).
    container.appendChild(transportBar);

    // The score's own scrolling viewport, capped well below the modal's
    // height: the score is the only thing that should move while the cursor
    // advances. When the modal body was the scroller, centring a staff dragged
    // the tabs and the transport controls out of view along with it.
    //
    // A box of its own, and NOT the element abcjs draws into: a responsive
    // render makes its target `display:inline-block; overflow:hidden` with a
    // percentage `padding-bottom` for the aspect ratio (svg.js's
    // setResponsiveWidth), which overwrites whatever scrolling it was given and
    // puts its whole height in padding, where `max-height` cannot reach it.
    // Carrying both jobs on one element meant neither cap nor scrollbar ever
    // took, and the modal body quietly went on being the scroller.
    const scoreScroll = document.createElement('div');
    scoreScroll.className = 'abc-score-paper w-full rounded p-2 overflow-y-auto';
    scoreFrame.appendChild(scoreScroll);

    /** Paper and ink onto the box, and the cursor colour onto the CSS variable
     *  the stylesheet reads. The ink is set on the element too, not only handed
     *  to abcjs: the "format non décodable" text and anything else that lands
     *  in this box has to be readable on the paper it lands on. */
    const applyPaper = () => {
      const { paper: bg, ink, cursor } = ABC_PAPERS[paper];
      // On the FRAME, so the controls that float over the score inherit them
      // too — they sit on the paper, not on the dialog.
      scoreFrame.style.setProperty('--abc-paper', bg);
      scoreFrame.style.setProperty('--abc-ink', ink);
      scoreFrame.style.setProperty('--abc-cursor', cursor);
      scoreScroll.style.background = bg;
      scoreScroll.style.color = ink;
    };
    applyPaper();

    /** Most of the screen normally; what the dialog's own "Full page" leaves
     *  once the header, the tabs and the transport have had theirs. The cap has
     *  to follow that toggle: the score is the only thing in this modal that
     *  grows, so an expansion it ignored would just open a field of grey under
     *  a score exactly as small as before.
     *
     *  0.62 and not the 0.5 it was until 2026-09-21: half a viewport put 49 %
     *  of a jig on screen at desktop size (measured), so reading one meant
     *  scrolling a score that had a whole empty dialog around it. */
    let modalExpanded = false;
    // Declared here rather than beside the full-page code below: the cap has to
    // know to keep its hands off while the score owns the page.
    let fullscreen: HTMLElement | null = null;
    const capScore = () => {
      if (fullscreen) return; // full page sizes itself from its own flex column
      scoreScroll.style.maxHeight = modalExpanded
        ? `calc(${modalMaxH(1)} - 12rem)`
        : modalMaxH(0.62);
    };
    capScore();
    onModalExpanded = (expanded) => { modalExpanded = expanded; capScore(); };

    /** Re-engraves for the box the score is in NOW, keeping the reader's place
     *  and whatever is playing. Assigned once abcjs has loaded; a resize that
     *  lands before then is a score that is not on screen yet. */
    let remeasure: () => void = () => {};
    /** Same, for a change to the drawing itself rather than to its size. */
    let redrawScore: () => void = () => {};
    /** Re-reads the editor's text and refreshes the warning strip. */
    let checkWarnings: () => void = () => {};
    /** The width the score on screen was engraved for, so a resize that changes
     *  nothing worth redrawing can be ignored. */
    let lastEngravedWidth = 0;


    const notation = document.createElement('div');
    notation.className = 'w-full';
    notation.id = `abc-notation-${uid}`;
    scoreScroll.appendChild(notation);

    // ── The reading page ─────────────────────────────────────────────────────
    // The whole dialog can already be expanded (modal.tsx's own toggle), which
    // is a different thing: that one gives the tabs, the transport and the
    // version nav the room too. This gives the page to the music — a stand you
    // can read from across the room.
    //
    // The frame is MOVED into an overlay on document.body rather than being
    // pinned where it stands: the dialog around it is `overflow-hidden`, and
    // the modal's backdrop-filter makes it a containing block for fixed
    // children, so a score fixed in place would be positioned and then clipped
    // by the very window it is escaping.
    //
    // The TRANSPORT COMES WITH IT, since 2026-09-21. Before that only the score
    // travelled and the controls stayed behind in the dialog, under the
    // overlay: on a desktop the space bar still played, and on a phone the one
    // mode built for reading from a stand could not start, stop or slow the
    // tune down. Measured, not deduced — the only button inside the overlay was
    // the one that left it.

    // Where the frame and the transport go back to. Placeholders in the flow,
    // rather than remembered siblings: the rows around them come and go as the
    // file is edited.
    const scoreAnchor = document.createComment('abc-score');
    const transportAnchor = document.createComment('abc-transport');
    let unregisterFullscreen = () => {};

    /** Keeps the screen on while the score owns the page — the one place in
     *  the app where somebody is looking at the screen without touching it.
     *
     *  Every step is optional: the API is absent on some browsers, the request
     *  is refused when the page is not visible, and the lock is dropped by the
     *  system whenever the tab goes to the background — which is why it is
     *  re-taken on `visibilitychange` rather than assumed to hold. */
    let wakeLock: { release: () => Promise<void> } | null = null;
    const takeWakeLock = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nav = navigator as any;
      if (!nav.wakeLock?.request || document.visibilityState !== 'visible') return;
      nav.wakeLock.request('screen')
        // A lock that arrives after full page was left is released at once,
        // rather than held for a reader who is no longer reading.
        .then((lock: { release: () => Promise<void> }) => {
          if (fullscreen) wakeLock = lock; else void lock.release().catch(() => {});
        })
        .catch(() => { /* refused: the score is readable all the same */ });
    };
    const onVisibility = () => { if (fullscreen && !document.hidden) takeWakeLock(); };
    const dropWakeLock = () => {
      const held = wakeLock;
      wakeLock = null;
      void held?.release().catch(() => {});
    };

    // No page-turn bands here on purpose. The full-page reader had a band down
    // each side that scrolled by a screenful; it was dropped on 2026-09-22
    // because a reader scrolls the score, and two tap targets over the music
    // were read as settings rather than as a page turn.

    /** The page-turn bands and the exit button: built on the way in, and taken
     *  out again on the way out. They live on the FRAME, which goes back into
     *  the dialog — so leaving them behind would hang two tap bands over a
     *  score that has a toolbar of its own, and add a second pair on the next
     *  time through. */
    let fullscreenExtras: HTMLElement[] = [];

    const exitFullscreen = () => {
      if (!fullscreen) return;
      unregisterFullscreen();
      unregisterFullscreen = () => {};
      document.removeEventListener('visibilitychange', onVisibility);
      dropWakeLock();
      for (const el of fullscreenExtras) el.remove();
      fullscreenExtras = [];
      scoreFrame.classList.remove('flex', 'flex-col', 'flex-1', 'min-h-0');
      scoreScroll.classList.remove('flex-1', 'min-h-0');
      scoreScroll.classList.add('rounded');
      scoreAnchor.replaceWith(scoreFrame);
      transportBar.className = TRANSPORT_CLASS;
      transportAnchor.replaceWith(transportBar);
      fullscreen.remove();
      fullscreen = null;
      capScore();
      fullscreenBtn.replaceChildren(iconElement(ExpandIcon, 14));
      fullscreenBtn.title = t('fileViewer.abc.fullscreen');
      // The box changed width twice over on the way out; the score has to be
      // engraved for the one it ends up in.
      remeasure();
    };

    const enterFullscreen = () => {
      if (fullscreen) return;
      const overlay = document.createElement('div');
      // The score's own paper, so the page reads as one sheet rather than a
      // picture of one.
      overlay.className = 'fixed inset-0 z-[100] flex flex-col';
      overlay.style.background = ABC_PAPERS[paper].paper;

      scoreFrame.replaceWith(scoreAnchor);
      scoreFrame.classList.add('flex', 'flex-col', 'flex-1', 'min-h-0');
      scoreScroll.classList.remove('rounded');
      scoreScroll.classList.add('flex-1', 'min-h-0');
      // Height comes from the flex column now; the modal-relative cap it was
      // wearing would hold the score to half a dialog that is no longer there.
      scoreScroll.style.maxHeight = '';

      const exitBar = document.createElement('div');
      exitBar.className = 'abc-score-tools absolute top-2 right-2 z-20 flex items-center rounded-lg backdrop-blur-sm px-1 py-0.5 shadow-sm';
      const exitBtn = document.createElement('button');
      exitBtn.className = 'abc-score-tool rounded transition-colors cursor-pointer flex items-center justify-center';
      exitBtn.title = t('fileViewer.abc.fullscreenExit');
      exitBtn.setAttribute('aria-label', t('fileViewer.abc.fullscreenExit'));
      exitBtn.appendChild(iconElement(CollapseIcon, 15));
      exitBtn.onclick = () => { exitBtn.blur(); exitFullscreen(); };
      exitBar.appendChild(exitBtn);
      scoreFrame.appendChild(exitBar);
      fullscreenExtras = [exitBar];

      // The transport, at the bottom where a thumb is. It keeps its element
      // and its abcjs bindings — only where it sits and what it sits on change.
      transportBar.replaceWith(transportAnchor);
      transportBar.className = 'abc-transport shrink-0 flex items-center justify-center gap-2 flex-wrap px-2 py-2 bg-elevated border-t border-border';

      overlay.append(scoreFrame, transportBar);
      document.body.appendChild(overlay);
      fullscreen = overlay;
      fullscreenBtn.replaceChildren(iconElement(CollapseIcon, 14));
      fullscreenBtn.title = t('fileViewer.abc.fullscreenExit');
      document.addEventListener('visibilitychange', onVisibility);
      takeWakeLock();
      // Registered as the topmost overlay, which is what makes Escape and the
      // Android back gesture leave full page rather than close the viewer
      // underneath it.
      unregisterFullscreen = registerOverlay(exitFullscreen);
      // The score is engraved to the width of its box, so a box this much
      // wider is a different engraving — not merely the same one scaled. That
      // was true the other way round too before 2026-09-21, and it is why the
      // old comment here said no re-render was needed.
      remeasure();
    };

    fullscreenBtn.onclick = () => { if (fullscreen) exitFullscreen(); else enterFullscreen(); };
    // The viewer can go while the score is still filling the page — the stack
    // is popped from elsewhere by closeAllModals — and a frame left inside an
    // overlay nothing points at any more would stay on screen for good.
    releaseFullscreen = exitFullscreen;

    // ── Raw ABC text of the SELECTED tune only — editable and saved back to
    // the attachment when the caller passed a save callback (card view);
    // read-only otherwise (study).
    const textarea = document.createElement('textarea');
    textarea.className = 'hidden w-full h-72 font-mono text-xs p-3 border border-border rounded-lg bg-bg text-primary resize-y outline-none focus:border-accent';
    textarea.spellcheck = false;
    textarea.readOnly = !onSave;
    textarea.value = tunes[0] ?? '';
    container.appendChild(textarea);

    // ── The source face's preview ────────────────────────────────────────────
    // The half of the ABC editor that was missing: the box above says what the
    // tune IS and this says what it sounds like on paper, redrawn as it is
    // typed. Without it, editing ABC meant writing blind and pressing a tab to
    // find out — and a wrong bar was only visible to someone who could already
    // read the source well enough not to need the drawing.
    //
    // A render target of its own rather than the main one: the score above is
    // the SAVED version, and the two must not be confused while an edit is
    // pending. It is also how the warnings can name a mistake the moment it is
    // made instead of at the next save.
    // A LIVE PREVIEW of the score lived here for a day and was taken out at the
    // user's request: someone on the source face is there to read or write ABC,
    // and a picture of it took half the screen from the text. What is kept is
    // the half that was actually worth having — the warnings, which are checked
    // as you type by PARSING the text and drawing nothing at all (see
    // `checkWarnings`). A mistake is still named the moment it is made.

    const saveRow = document.createElement('div');
    saveRow.className = 'hidden flex items-center justify-between gap-2 flex-wrap';

    // ── Adding / deleting a version ───────────────────────────────────────────
    // On the save row rather than beside the version nav: these two write to the
    // file, like Save and unlike the nav, and this row is already exactly where
    // "editable, and looking at the source" is decided — it only ever shows in
    // text mode, and only when the caller passed a save callback.
    const versionEdit = document.createElement('div');
    versionEdit.className = 'flex items-center gap-1 p-1 bg-bg rounded-lg w-fit';
    const mkEditBtn = (icon: Element, title: string, danger: boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.appendChild(icon);
      b.title = title;
      b.className = `px-2 py-1 rounded transition-colors cursor-pointer text-muted hover:bg-elevated ${danger ? 'hover:text-danger' : 'hover:text-primary'}`;
      return b;
    };
    const addVersionBtn = mkEditBtn(iconElement(PlusIcon, 13), t('fileViewer.abc.addVersion'), false);
    const deleteVersionBtn = mkEditBtn(iconElement(TrashIcon, 13), t('fileViewer.abc.deleteVersion'), true);
    versionEdit.append(addVersionBtn, deleteVersionBtn);

    const saveGroup = document.createElement('div');
    // Takes what the version buttons leave and keeps the primary action against
    // the right edge; `min-w-0` lets the status text wrap inside it rather than
    // pushing Save off the row.
    saveGroup.className = 'flex items-center gap-2 flex-1 min-w-0 justify-end';
    const saveStatus = document.createElement('span');
    saveStatus.className = 'text-xs text-dim';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary text-xs';
    saveBtn.textContent = t('fileViewer.abc.save');
    saveBtn.disabled = true;
    saveGroup.append(saveStatus, saveBtn);
    saveRow.append(versionEdit, saveGroup);
    container.appendChild(saveRow);

    body.appendChild(container);

    let doRenderTune: ((index: number) => void) | null = null;

    // The "X:n" header line is the tune's identity within the file (what
    // splitAbcTunes keys the version split on) — never shown/editable, so the
    // user can't desync it from its position and corrupt the file structure.
    //
    // Matched on `X:` alone, without requiring the number splitAbcTunes wants:
    // a hand-made file whose block opens on a bare `X:` has an identity line all
    // the same, and leaving it in the editable body would put it back in reach.
    function splitXLine(tune: string): { xLine: string; body: string } {
      const nl = tune.indexOf('\n');
      const firstLine = nl === -1 ? tune : tune.slice(0, nl);
      if (/^X:/.test(firstLine)) return { xLine: firstLine, body: nl === -1 ? '' : tune.slice(nl + 1) };
      return { xLine: '', body: tune };
    }
    const currentBody = (): string => splitXLine(tunes[currentIndex] ?? '').body;

    /** The edited body put back under the `X:` line its version already had —
     *  and stripped of any OTHER `X:` line it may have gained.
     *
     *  An `X:` line anywhere in a block opens a new tune: that is what
     *  splitAbcTunes cuts on, and what abcjs cuts on too. Pasting a whole tune
     *  into the box (TheSession and abcTools both hand out blocks starting with
     *  `X: 1`) would otherwise split this version in two behind the user's back:
     *  every later version shifts by one, and every position stored into this
     *  file — the ★ `preferredIndex`, the block a set fuses, the setting a
     *  detection opens on — would then designate its neighbour. The block itself
     *  would be broken too, parseAbcBlock reading everything after the FIRST
     *  `K:` as music.
     *
     *  Dropped rather than refused: the line carries nothing the pasted music
     *  needs — it is a position in a file, and this block already has one. The
     *  cut is visible the moment it is made, the box being refilled from what
     *  was written.
     *
     *  `^X:` is deliberately wider than the splitter's own `^X:\s*\d+`: an `X:`
     *  with no number splits for abcjs alone, which is worse still — two tunes
     *  drawn inside one "version", of which only the first is playable, and
     *  nothing in the nav to say so. */
    const withXLine = (index: number, body: string): string => {
      const { xLine } = splitXLine(tunes[index] ?? '');
      const clean = body.split('\n').filter(l => !/^X:/.test(l)).join('\n');
      return xLine ? `${xLine}\n${clean}` : clean;
    };

    /** Text mode only: what the box holds, when it differs from what was loaded
     *  into it. In sheet mode the textarea still shows whatever version was
     *  last opened in text mode (goToVersion only refills it in text mode), so
     *  its content is not a pending edit of the current version. */
    const pendingBody = (): string | null =>
      currentMode === 'text' && textarea.value !== currentBody() ? textarea.value : null;

    function goToVersion(index: number): void {
      currentIndex = Math.max(0, Math.min(versionCount - 1, index));
      prevBtn.disabled = currentIndex === 0;
      nextBtn.disabled = currentIndex === versionCount - 1;
      versionLabel.textContent = `${currentIndex + 1}/${versionCount}`;
      // Recomputed on every move rather than once at build time: adding or
      // deleting a version changes the count under an open viewer. Deleting is
      // hidden on a single-version file rather than offered and refused — the
      // last version cannot go without the file going with it.
      versionNav.classList.toggle('hidden', versionCount <= 1);
      deleteVersionBtn.classList.toggle('hidden', versionCount <= 1);
      updateStarBtn?.();
      abcToolsLink.href = abcToolsShareUrl(tunes[currentIndex] ?? '');
      if (currentMode === 'sheet') {
        doRenderTune?.(currentIndex);
      } else {
        textarea.value = currentBody();
        saveBtn.disabled = true;
        saveStatus.textContent = '';
      }
    }

    function setAbcMode(mode: 'sheet' | 'text'): void {
      currentMode = mode;
      const active = 'bg-accent text-white';
      const inactive = 'text-muted hover:text-primary hover:bg-elevated';
      const tabBase = 'px-3 min-h-[2.25rem] text-xs font-medium rounded transition-colors cursor-pointer';
      sheetTabBtn.className = `${tabBase} ${mode === 'sheet' ? active : inactive}`;
      textTabBtn.className  = `${tabBase} ${mode === 'text'  ? active : inactive}`;
      // Sheet + synth toolbar fully hidden in text mode, not just visually behind
      // it — inline style.display, not just the 'hidden' class: abcjs's own
      // resize handling can otherwise leave the notation SVG visibly reflowing.
      transportBar.style.display = mode === 'sheet' ? 'flex' : 'none';
      // The frame, not the score inside it: the reading tools act on the
      // picture and would otherwise stay hanging over the ABC source.
      scoreFrame.style.display = mode === 'sheet' ? '' : 'none';
      // Full page acts on a drawing nobody is looking at while the source is on
      // screen. The link to abcTools is not one of them: it hands the TUNE
      // over, whichever face you were reading.
      fullscreenBtn.style.display = mode === 'sheet' ? '' : 'none';
      textarea.style.display = mode === 'text' ? 'block' : 'none';

      if (onSave) saveRow.style.display = mode === 'text' ? 'flex' : 'none';
      if (mode === 'sheet' && sheetNeedsRerender) {
        sheetNeedsRerender = false;
        doRenderTune?.(currentIndex);
      }
      if (mode === 'text') {
        textarea.value = currentBody();
        saveBtn.disabled = true;
        saveStatus.textContent = '';
        // No focus, and no preview drawn: switching to the source face is
        // often just a look, and stealing the caret put a keyboard over half a
        // phone screen for someone who had not asked to type. Both are one tap
        // away — the box, and the fold above it.
        checkWarnings();
      }
    }

    if (onSave) {
      /** Writes a new version list to the attachment, then re-reads everything
       *  the viewer holds about the file from it. One place for the three
       *  actions that rewrite it (saving the text, adding a version, deleting
       *  one), because they all have the same two subtleties: the save may be
       *  REFUSED — a TheSession score is written to a copy, and the user may
       *  cancel that — in which case nothing here may move; and `versionCount`
       *  has to follow `tunes`, which is exactly what used not to happen when
       *  an `X:` line slipped into an edit. */
      async function persist(nextTunes: string[], nextIndex: number): Promise<boolean> {
        // Tunes already carry their trailing separator from splitAbcTunes —
        // plain '\n' join reconstructs the file without doubling blank lines.
        const nextText = nextTunes.join('\n');
        // Awaited, and only then applied: a save may ask first (a TheSession
        // score is saved as a copy) and the answer may be no.
        const result = await onSave!(arrayBufferToBase64(new TextEncoder().encode(nextText).buffer));
        if (result === false) return false;
        tunes = nextTunes;
        abcText = nextText;
        versionCount = tunes.length;
        if (typeof result === 'string') {
          shownName = result;
          updateTopModal({ title: result });
        }
        // Re-render lazily once Sheet is reopened — see setAbcMode. goToVersion
        // draws it straight away when the stave is what is on screen.
        if (currentMode === 'text') sheetNeedsRerender = true;
        // Refreshes the nav, the label, the ★, the share link and the box.
        goToVersion(nextIndex);
        return true;
      }

      /** A fresh, empty version: the current one's header, no music.
       *
       *  Carrying `T:/R:/M:/L:/Q:/K:` over rather than starting from a bare
       *  `X:` is what makes the new block usable straight away — another
       *  setting of the same tune is in the same key and the same metre far
       *  more often than not, and either is one line to change. What is NOT
       *  carried is everything identifying: a `S:` line above all, which is how
       *  settingIndexInScore recognises a TheSession setting and which would
       *  then match two blocks at once.
       *
       *  The `X:` number is the file's highest plus one, so it collides with
       *  nothing even after deletions have left gaps in the numbering. */
      function newVersionBlock(blocks: string[]): string {
        // Read from the list being written, not from `tunes` — a header the
        // user has just changed in the box and not yet saved is the one to copy.
        const src = parseAbcBlock(blocks[currentIndex] ?? '');
        let maxX = 0;
        for (const b of blocks) {
          const m = /^X:\s*(\d+)/m.exec(b);
          if (m) maxX = Math.max(maxX, parseInt(m[1]!, 10));
        }
        return [
          `X: ${maxX + 1}`,
          ...(src.title ? [`T: ${src.title}`] : []),
          ...(src.rhythm ? [`R: ${src.rhythm}`] : []),
          ...(src.meter ? [`M: ${src.meter}`] : []),
          `L: ${src.unitLength || '1/8'}`,
          ...(src.tempo ? [`Q: ${src.tempo}`] : []),
          // K: closes the ABC header — everything after it is music, so it goes
          // last, and the empty line after it IS the (empty) body.
          `K: ${src.key || 'D'}`,
          '',
        ].join('\n');
      }

      /** The version list with the box's unsaved edit folded in. Adding a
       *  version rewrites the whole file and then moves away from this one, so
       *  an edit left behind would vanish without a trace — it goes in. */
      function tunesWithPendingEdit(): string[] {
        const pending = pendingBody();
        const next = [...tunes];
        if (pending !== null) next[currentIndex] = withXLine(currentIndex, pending);
        return next;
      }

      textarea.addEventListener('input', () => {
        saveBtn.disabled = textarea.value === currentBody();
        saveStatus.textContent = '';
      });

      saveBtn.onclick = async () => {
        const nextTunes = [...tunes];
        nextTunes[currentIndex] = withXLine(currentIndex, textarea.value);
        saveBtn.disabled = true;
        if (!await persist(nextTunes, currentIndex)) {
          saveBtn.disabled = textarea.value === currentBody();
          return;
        }
        saveStatus.textContent = t('fileViewer.abc.saved');
      };

      addVersionBtn.onclick = async () => {
        const nextTunes = tunesWithPendingEdit();
        nextTunes.push(newVersionBlock(nextTunes));
        // Straight onto the new one: it is empty, and there is nothing else to
        // do with it than write in it.
        if (await persist(nextTunes, nextTunes.length - 1)) setAbcMode('text');
      };

      deleteVersionBtn.onclick = () => {
        if (versionCount <= 1) return;
        confirmModal(
          t('fileViewer.abc.deleteVersion.title'),
          t('fileViewer.abc.deleteVersion.message', { n: String(currentIndex + 1), total: String(versionCount) }),
          t('fileViewer.abc.deleteVersion.confirm'),
          () => { void deleteCurrentVersion(); },
        );
      };

      async function deleteCurrentVersion(): Promise<void> {
        const removed = currentIndex;
        const nextTunes = [...tunes];
        nextTunes.splice(removed, 1);
        // The version that FOLLOWED the deleted one now sits at its index, so
        // staying put is landing on it; deleting the last one falls back to the
        // new last, which goToVersion's own clamp does without a special case.
        if (!await persist(nextTunes, removed)) return;
        // Only once the write went through — a cancelled copy must not move the
        // ★. Deleting the favourite CLEARS the preference rather than handing
        // it to whichever version slid into that slot: nobody picked that one,
        // and "no favourite" is a state this viewer already knows how to show.
        if (favoriteIndex !== undefined && favoriteIndex >= removed) {
          favoriteIndex = favoriteIndex === removed ? undefined : favoriteIndex - 1;
          onSetPreferredIndex?.(favoriteIndex);
          updateStarBtn?.();
        }
      }
    }

    goToVersion(currentIndex); // initializes prev/next disabled state + label (respects opts.initialIndex)
    setAbcMode(currentMode);

    import('abcjs').then((abcjs) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let synthControl: any = null;

      // Cursor + note highlighting during playback — abcjs drives this via
      // TimingCallbacks internally once a cursorControl is passed to
      // SynthController.load(). Re-queries the SVG/cursor by ID each call
      // rather than caching elements, since renderAbc replaces the SVG
      // wholesale on every version switch.
      // Keeps the played staff in the middle of what is visible of the score —
      // a fused set runs to several systems, and reading it meant scrolling by
      // hand while playing.
      //
      // Driven off `ev.top`, the staff line's own y, so this fires ONCE per
      // system rather than on every note: scrolling eight times a second would
      // be unusable, and would fight anyone touching the scrollbar.
      let lastCursorTop: number | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const followCursor = (ev: any) => {
        if (ev.top == null || ev.top === lastCursorTop) return;
        lastCursorTop = ev.top;
        const scroller = nearestScroller(notation);
        if (!scroller) return;
        // The cursor line, whose y1/y2 were just set to this system's extent,
        // measures the staff exactly — better than a note, which sits wherever
        // its pitch puts it and would drag the centring up or down with the
        // melody.
        const marker = (notation.querySelector('.abcjs-cursor') as SVGGraphicsElement | null)
          ?? ((ev.elements?.[0]?.[0] ?? null) as SVGGraphicsElement | null);
        if (!marker) return;
        // Both rects come from the same (zoomed) coordinate space, but
        // scrollBy works in unzoomed layout pixels — see zoomService's note on
        // CSS zoom and getBoundingClientRect.
        const z = getZoom() / 100;
        const m = marker.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        // Centre the current staff in what is visible of the score. Near the
        // start or the end there is not enough score to centre against; the
        // browser clamps the scroll to its bounds, which IS the best available
        // position, so no special case is needed for either edge.
        const delta = (m.top + m.height / 2 - s.top) / z - scroller.clientHeight / 2;
        if (Math.abs(delta) < 1) return;
        scroller.scrollBy({
          top: delta,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      };

      /** The cursor line, made if the score has not got one yet.
       *
       *  Called from `onStart` AND from `onEvent`, because an event can arrive
       *  without playback ever having started: clicking a note seeks, and a
       *  seek reports the event it landed on (abc_timing_callbacks' setProgress
       *  fires the callback itself). Created only in `onStart`, the very first
       *  click on a fresh score highlighted the note and drew no line at all. */
      const ensureCursor = (): Element | null => {
        const svg = notation.querySelector('svg');
        if (!svg) return null;
        const existing = svg.querySelector('.abcjs-cursor');
        if (existing) return existing;
        const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        cursor.setAttribute('class', 'abcjs-cursor');
        cursor.setAttribute('x1', '0'); cursor.setAttribute('y1', '0');
        cursor.setAttribute('x2', '0'); cursor.setAttribute('y2', '0');
        svg.appendChild(cursor);
        return cursor;
      };

      const cursorControl = {
        beatSubdivisions: 2,
        onStart: () => {
          lastCursorTop = null;
          ensureCursor();
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onEvent: (ev: any) => {
          if (ev.measureStart && ev.left === null) return; // 2nd half of a tie across a measure line
          notation.querySelectorAll('.abcjs-highlight').forEach(el => el.classList.remove('abcjs-highlight'));
          for (const note of ev.elements ?? []) {
            for (const el of note) el.classList.add('abcjs-highlight');
          }
          const cursor = ensureCursor();
          if (cursor && ev.left != null) {
            cursor.setAttribute('x1', String(ev.left - 2));
            cursor.setAttribute('x2', String(ev.left - 2));
            cursor.setAttribute('y1', String(ev.top));
            cursor.setAttribute('y2', String(ev.top + ev.height));
          }
          followCursor(ev);
        },
        onFinished: () => {
          lastCursorTop = null;
          notation.querySelectorAll('.abcjs-highlight').forEach(el => el.classList.remove('abcjs-highlight'));
          const cursor = notation.querySelector('.abcjs-cursor');
          cursor?.setAttribute('x1', '0'); cursor?.setAttribute('x2', '0');
          cursor?.setAttribute('y1', '0'); cursor?.setAttribute('y2', '0');
        },
      };

      // Resolves once the audio buffer for the current render is built. Held so
      // a caller can act after the tune is actually playable, rather than after
      // the notation has merely been drawn.
      let primed: Promise<unknown> = Promise.resolve();

      /** Opens the audio output before the first note needs it.
       *
       *  abcjs starts the sound and the cursor in the right order — the buffer
       *  first, the timer after (synth-controller.js:163) — so the cursor
       *  running ahead of the music on the FIRST play is the output itself
       *  arriving late: a browser opens the device's stream lazily, and the
       *  first sound of a page pays for it while the timer, counting in
       *  software, does not. Every play after that is already open, which is
       *  exactly the shape of what was reported.
       *
       *  One inaudible sample, once, as soon as a tune is primed. Silent, so it
       *  cannot be heard; a single frame, so it cannot be felt; and guarded on
       *  `running`, because a context still suspended has had no user gesture
       *  and would refuse anyway.
       *
       *  NOT MEASURED. Headless Chromium has no audio device at all — it
       *  reports `outputLatency: 0` — so the very thing this addresses is
       *  absent from the only environment I can test in. It is the known cause
       *  of the known symptom, not a verified fix. */
      let warmed = false;
      const warmAudioOutput = () => {
        if (warmed) return;
        try {
          const ac = abcjs.synth.activeAudioContext();
          if (!ac || ac.state !== 'running') return;
          const source = ac.createBufferSource();
          source.buffer = ac.createBuffer(1, 1, ac.sampleRate);
          source.connect(ac.destination);
          source.start(0);
          warmed = true;
        } catch { /* no context yet, or a browser that will not hand it over */ }
      };

      /** The width abcjs is asked to engrave to: the box's own, less its
       *  padding. `clientWidth` and not `getBoundingClientRect` — this is
       *  layout pixels, which is the space abcjs lays out in, and it is
       *  therefore the one measurement the app's CSS zoom must NOT be divided
       *  out of (see zoomService's note on the two pixel spaces). */
      const engraveWidth = (): number => {
        const style = getComputedStyle(scoreScroll);
        const inner = scoreScroll.clientWidth
          - parseFloat(style.paddingLeft || '0')
          - parseFloat(style.paddingRight || '0');
        return Math.max(MIN_ENGRAVE_WIDTH, Math.round(inner));
      };

      const renderTune = (index: number) => {
        const ink = ABC_PAPERS[paper].ink;
        const source = injectDefaultTempo(stripForRender(tunes[index] ?? ''));
        lastEngravedWidth = engraveWidth();
        const visualObj = abcjs.renderAbc(notation.id, source, {
          ...engraveOptions({ width: lastEngravedWidth, barsPerLine, ink, transpose }),
          // Clicking a note makes abcjs paint it as "selected", and it only
          // repaints on the NEXT click — so the clicked note stayed coloured
          // alongside whatever the playback cursor was colouring, showing two
          // marked notes at once. Selection is still what carries the click; it
          // just has nothing to say visually here, the cursor jumping to the
          // note being the answer. Painting it the paper's own ink is how abcjs
          // is asked to keep quiet — and it has to follow the paper, or the
          // clicked note turns black on a dark page.
          selectionColor: ink,
          // Click a note, play from there. `dragging` is left off, so this
          // only ever selects — abcjs's note-dragging (which would edit
          // pitches) needs that flag and never gets it.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          clickListener: (abcElem: any, _tuneNumber: number, _classes: string, _analysis: unknown, _drag: unknown, ev?: MouseEvent) => {
            // Only a click that actually landed ON a note may move the cursor.
            // Without a direct hit abcjs falls back to "nearest selectable",
            // which happily returns something on the other side of the page —
            // and a click meant for empty space would jump the playhead.
            //
            // A click on drawn ink targets that glyph; a click on blank staff
            // targets the <svg> itself, since a <g> has no geometry to hit. So
            // the root being the target IS the miss. abcjs's own full-synth
            // example does not guard this at all — it is the answer to a
            // problem the example never has, its score being one short line.
            const target = ev?.target as Element | undefined;
            if (!target || target.nodeName.toLowerCase() === 'svg') return;
            // "Is this a sounding note", written the way the library's own
            // example writes it: no MIDI pitches, nothing to play from — which
            // also rules out clefs, barlines, tempo marks and rests.
            if (!abcElem?.midiPitches) return;
            // The MIDI flattener stamps every element it schedules with its own
            // position, so the score already knows when each note is played —
            // no mapping to build.
            //
            // An element inside a `:|` repeat carries an ARRAY, one entry per
            // pass, and taking `[0]` sent every click on a repeated bar back to
            // the first time round — which is why the cursor "did not always
            // land where you clicked" (reported 2026-09-21). Repeated music is
            // most of this repertoire, so most of the score behaved that way.
            //
            // The pass nearest where the tune is NOW is the one meant: clicking
            // a bar during the second time through means that bar, this time
            // round. Stopped at the start, that resolves to the first pass, so
            // the old behaviour is still what an untouched score does.
            const ms = abcElem?.currentTrackMilliseconds;
            let at: unknown = ms;
            if (Array.isArray(ms) && ms.length > 0) {
              const durationMs = (synthControl?.midiBuffer?.duration ?? 0) * 1000;
              const nowMs = (synthControl?.percent ?? 0) * durationMs;
              at = ms.reduce((best: number, cur: number) =>
                (Math.abs(cur - nowMs) < Math.abs(best - nowMs) ? cur : best), ms[0] as number);
            }
            if (typeof at !== 'number' || !synthControl) return;
            // Land just BEFORE the note, never exactly on it. abcjs picks the
            // current event with a strict `milliseconds < currentTime`, and the
            // note's stamp and the timing table are computed down two different
            // float paths — when rounding leaves the table a hair lower, an
            // exact seek steps past the note and selects the next one. A few
            // milliseconds of margin is far below the shortest note in this
            // music (a sixteenth in a fast reel is about 80ms) and puts the
            // comparison out of reach of the noise.
            try { synthControl.seek(Math.max(0, at - SEEK_BACKOFF_MS) / 1000, 'seconds'); }
            catch { /* not primed yet */ }
          },
        });

        // What abcjs thought of the ABC it was just handed. It has always
        // answered this and nobody ever read it: a bar with the wrong number of
        // beats, a header it could not parse, a repeat that never opens — all
        // of it drawn as best abcjs could and reported to no one. Verified in
        // the browser on 2026-09-21 with a deliberately broken bar: the score
        // redrew itself wrong, in silence.
        //
        // Optional at every step: `warnings` is declared optional in abcjs's
        // own typings, and this file has been caught before by a typing that
        // promised more than the code delivers.
        showWarnings(Array.isArray(visualObj?.[0]?.warnings) ? visualObj[0]!.warnings! : []);

        // After the drawing, before anything reads its height: pulls the music
        // up to where its own ink starts. See cropToInk.
        cropToInk(notation);
        // The metre can change from one version of a file to the next, and it
        // is the metre that decides whether the swing does anything at all.
        updateSwing();

        if (visualObj && visualObj.length > 0) {
          if (!synthControl) {
            synthControl = new abcjs.synth.SynthController();
            stopAudio = () => { try { synthControl.pause(); } catch { /* ignore */ } };
            synthControl.load(`#${controls.id}`, cursorControl, {
              displayLoop: true,
              displayRestart: true,
              displayPlay: true,
              // OFF since 2026-09-21: the progress bar said the same thing as
              // the cursor running along the staff, and said it worse. The
              // position is read off the music, and a click on a note is how
              // you move it. `setProgress` guards for the missing elements
              // (create-synth-control.js:87), and the clock is built from a
              // flag of its own, so it stays.
              displayProgress: false,
              // ON, although the field is hidden in CSS (`.abc-transport
              // .abcjs-tempo-wrapper`). It has to exist: `setWarp` on abcjs's
              // control does `el.value = …` on the result of a querySelector
              // with NO null check (create-synth-control.js:47 — its
              // neighbour `setTempo` two lines down does guard, which is how
              // easy it is to miss), so turning the widget off made every
              // speed change throw "Cannot set properties of null". The speed
              // the user sees is the BPM stepper in this row; this is the
              // element abcjs needs to write its percentage into.
              displayWarp: true,
            });
            dressTransport();
          } else {
            // Switching tunes on an already-used controller: if playback ever
            // started, abcjs can keep the previous tune's primed audio bound
            // and silently ignore setTune() — stop it first so the rebind
            // below actually takes.
            try { synthControl.pause(); } catch { /* ignore */ }
          }
          // The tune's own written tempo, for the BPM read-out — read from the
          // object abcjs just built rather than from the `Q:` line, so an
          // injected default and a hand-written one give the same answer.
          pauseIfPlaying = () => {
            try {
              if (!synthControl?.isStarted) return;
              synthControl.pause();
              // `pause()` stops the timer and the buffer but leaves `isStarted`
              // TRUE — abcjs only ever flips that flag inside `_play`, which
              // toggles it. So a stop from outside left the controller thinking
              // it was still playing, and the next press of play toggled it to
              // false and paused again: the tune only restarted on the SECOND
              // press. Reported, and it is this line that fixes it.
              synthControl.isStarted = false;
            } catch { /* not primed */ }
          };

          // userAction: true on every call (not just the first) — abcjs needs
          // this to actually re-prime the AudioContext-backed buffer for the
          // new tune instead of silently keeping the old one queued.
          const audioParams: Record<string, unknown> = {};
          // No `qpm` here: the tempo travels in the notation, as a `Q:`, which
          // is the only thing the note stamps are built from — see
          // injectDefaultTempo for what happened when it did not.
          if (selectedProgram !== undefined) audioParams.program = selectedProgram;
          if (transpose !== 0) {
            // `visualTranspose` alone moves the DOTS and leaves the sound where
            // it was: abc_midi_sequencer subtracts it back out again on the way
            // to MIDI ("if (abctune.visualTranspose) transpose -= ...", read in
            // the source before relying on it). That is right for a transposing
            // instrument and wrong here — someone shifting a tune to play it in
            // another key wants to hear the key they are reading. Passing the
            // same number as `midiTranspose` cancels the subtraction, so what
            // is written and what is heard agree.
            audioParams.midiTranspose = transpose;
          }
          if (metronome) {
            const meter = parseAbcBlock(tunes[index] ?? '').meter;
            audioParams.drum = drumPattern(beatsPerBar(meter));
            audioParams.drumBars = 1;
          }
          // Flat, like everything above it — and this took two goes to get
          // right, so the chain is written down. SynthController.setTune keeps
          // audioParams as `self.options` and hands CreateSynth
          // `{ visualObj, options: self.options, … }` (synth-controller.js:78);
          // CreateSynth then does `self.options = options.options`
          // (create-synth.js:37), which unwraps it back to this same object.
          // So `swing` belongs beside `drum`, at the top level. Nesting it
          // under an `options` key of our own buried it one level too deep and
          // abcjs ignored it in silence.
          if (swing !== NO_SWING && swingApplies()) audioParams.swing = swing;
          primed = synthControl.setTune(visualObj[0]!, true, audioParams).then(() => {
            // After setTune, never before: warping rebuilds the audio buffer,
            // so it needs a tune to rebuild from. Skipped at 100% — it would
            // throw away and re-render the buffer to arrive where it already is.
            if (tempoPercent !== DEFAULT_TEMPO_PERCENT) {
              try { synthControl.setWarp(tempoPercent); } catch { /* ignore */ }
            }
            // Looping on by default — a score is opened to be practised
            // against, and reaching for the button on every pass is friction.
            // `setTune` resets isLooping to false, so this belongs here, after
            // every re-prime, and the check keeps it idempotent.
            if (!synthControl.isLooping) {
              try { synthControl.toggleLoop(); } catch { /* ignore */ }
            }
            warmAudioOutput();
          }).catch(() => {});
        }
      };

      doRenderTune = renderTune;

      // Space toggles playback, the way it does in every player.
      //
      // Ignored while a field or a button has focus: a button already answers
      // the space bar by activating itself — including the play button, which
      // gives the same result by its own route — and swallowing the key inside
      // the ABC text editor would make it impossible to type.
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || active?.isContentEditable) return;
        e.preventDefault(); // or the page scrolls under the modal
        void synthControl?.play();
      };
      document.addEventListener('keydown', onKeyDown);
      releaseKeys = () => document.removeEventListener('keydown', onKeyDown);

      /** Re-draws the score without losing your place in it. Nothing the
       *  viewer can change about a score is changeable in place: abcjs
       *  pre-renders the whole performance into one buffer from the chosen
       *  soundfont, and the notation's layout belongs to the render options, so
       *  a new instrument or a new size both mean a new drawing and a new
       *  buffer. What CAN be preserved is the position and whether it was
       *  playing — exactly the dance abcjs itself does in setWarp.
       *
       *  `setTune` resets `isStarted` to false and the position to zero, so
       *  both are read BEFORE the re-draw and put back after. Expect a short
       *  silence while the buffer is rebuilt; there is no way around that one. */
      const redrawPreservingPlayback = (draw: () => void) => {
        const wasPlaying = !!synthControl?.isStarted;
        const at = synthControl?.percent ?? 0;
        draw();
        // Stopped at the very beginning is "nothing to put back", and saying so
        // matters: seeking runs the cursor callback, which paints the note it
        // lands on. Restoring a position nobody had left would mark the first
        // note of a score that has never been played.
        if (!wasPlaying && at === 0) return;
        void primed.then(() => {
          if (!synthControl) return;
          try {
            if (wasPlaying) void synthControl.play().then(() => synthControl.seek(at));
            else synthControl.seek(at);
          } catch { /* nothing primed to resume */ }
        });
      };

      // ── The score follows its box ────────────────────────────────────────
      // Engraving to the box's width means the engraving is only right for the
      // width it was made at: the sidebar opening, a phone rotating, the dialog
      // expanding and full page being entered or left all change it. A window
      // listener would miss the first two, so the box itself is watched.
      //
      // Two precautions, the same ones the incipit learnt from "ResizeObserver
      // loop completed with undelivered notifications": the work is deferred to
      // the next frame rather than done inside the callback, and a change too
      // small to matter is ignored — re-engraving changes the score's HEIGHT,
      // which can make a scrollbar appear, which changes the width again.
      redrawScore = () => redrawPreservingPlayback(() => renderTune(currentIndex));
      // abcjs's own setWarp already does the keep-your-place dance internally
      // (it is where redrawPreservingPlayback above was copied from), so this
      // is the one change that does not need wrapping.
      applyWarp = (percent) => { try { synthControl?.setWarp(percent); } catch { /* not primed */ } };

      // What abcjs makes of the text as it is typed — the warnings, and nothing
      // drawn. `parseOnly` does the reading without the engraving, which is the
      // whole cost of this: no SVG, no layout, no second score on screen.
      checkWarnings = () => {
        if (currentMode !== 'text') return;
        // The `X:` line back on, because that is the block abcjs will be given
        // when this is saved — and a body without it parses differently.
        const source = injectDefaultTempo(stripForRender(withXLine(currentIndex, textarea.value)));
        try {
          const parsed = abcjs.parseOnly(source);
          showWarnings(Array.isArray(parsed?.[0]?.warnings) ? parsed[0]!.warnings! : []);
        } catch {
          // Text so broken that abcjs throws rather than warning about it.
          showWarnings([t('fileViewer.abcError')]);
        }
      };

      // Debounced: parsing is cheap, but doing it inside every keystroke's
      // input event makes the caret stutter on a long set.
      let warnTimer = 0;
      textarea.addEventListener('input', () => {
        window.clearTimeout(warnTimer);
        warnTimer = window.setTimeout(checkWarnings, 250);
      });
      const stopWarnTimer = releaseKeys;
      releaseKeys = () => { stopWarnTimer(); window.clearTimeout(warnTimer); };
      remeasure = () => {
        if (currentMode !== 'sheet' || !notation.querySelector('svg')) return;
        if (Math.abs(engraveWidth() - lastEngravedWidth) < ENGRAVE_HYSTERESIS) return;
        redrawScore();
      };
      let resizeRaf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(remeasure);
      });
      ro.observe(scoreScroll);
      const releaseResize = () => { cancelAnimationFrame(resizeRaf); ro.disconnect(); };
      // Hung on the same hook as the keyboard shortcut: both outlive the modal
      // otherwise, and an observer watching a detached box is a leak that keeps
      // a whole score alive with it.
      const stopKeys = releaseKeys;
      releaseKeys = () => { stopKeys(); releaseResize(); };

      // Changing instrument without losing your place.
      reapplyAbcPrefs = () => redrawPreservingPlayback(() => {
        selectedProgram = appState.value.abcInstrument;
        // The paper and the bars per line are set in that dialog too, and both
        // belong to the ENGRAVING: re-read here so one apply hook covers
        // everything the preferences can change about a score.
        paper = abcPaper(appState.value);
        barsPerLine = abcBarsPerLine(appState.value);
        applyPaper();
        if (fullscreen) fullscreen.style.background = ABC_PAPERS[paper].paper;
        // A derived score may have just been rebuilt differently under us.
        const fresh = opts?.reloadEntry?.();
        const freshText = fresh ? decodeAbc(fresh) : null;
        if (freshText !== null && freshText !== abcText) {
          abcText = freshText;
          tunes = splitAbcTunes(abcText);
          versionCount = tunes.length;
          // goToVersion clamps the index, refreshes the nav label and the share
          // link, and re-renders — everything that has to follow a rebuild.
          goToVersion(currentIndex);
        } else {
          renderTune(currentIndex);
        }
      });
      // Only if the stave is the face we opened on. Drawing into a
      // display:none container is exactly what `sheetNeedsRerender` exists to
      // avoid (abcjs's resize handling makes the SVG reflow visibly when it
      // reappears), and someone who opens on the source may never look at the
      // notation at all.
      if (currentMode === 'sheet') renderTune(currentIndex);
      else sheetNeedsRerender = true;
    }).catch(() => {
      const err = document.createElement('p');
      err.className = 'text-sm text-dim italic';
      err.textContent = t('fileViewer.abcError');
      body.appendChild(err);
    });

  } else if (isText(entry)) {
    body.classList.replace('items-center', 'items-start');
    // Reassigned by a save, which is what the box is compared against to know
    // whether there is anything left to write.
    let text = decodeAbc(entry);
    const markdown = isMarkdown(entry);

    const container = document.createElement('div');
    container.className = 'w-full space-y-3';
    body.appendChild(container);

    const rendered = document.createElement('div');
    rendered.className = 'markdown text-sm leading-relaxed w-full';
    const paint = () => {
      renderMarkdown(text).then(html => {
        rendered.innerHTML = html;
        rendered.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
      }).catch(() => { rendered.textContent = text; });
    };

    if (!onSave) {
      // Read-only — study, a shared session's preview: exactly what this was
      // before editing existed. A page to read, or the text as it is written.
      if (markdown) {
        paint();
        container.appendChild(rendered);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'text-xs font-mono text-primary/90 whitespace-pre-wrap break-all w-full';
        pre.textContent = text;
        container.appendChild(pre);
      }
    } else {
      // ── Editable ──
      // A text attachment can now be WRITTEN here — pasted in empty and filled
      // in, or corrected — which the ABC branch above has always been able to
      // do and these two could not: a typo cost a delete and a re-paste.
      //
      // Markdown alone gets the two faces, for the same reason a score does:
      // the rendered page is what the note is FOR, the source is where it is
      // written. A .txt is its own source, so tabs would offer a choice
      // between a thing and itself.
      const textarea = document.createElement('textarea');
      textarea.className = 'w-full h-72 font-mono text-xs p-3 border border-border rounded-lg bg-bg text-primary resize-y outline-none focus:border-accent';
      textarea.spellcheck = false;
      textarea.value = text;

      const saveRow = document.createElement('div');
      saveRow.className = 'flex items-center justify-end gap-2';
      const saveStatus = document.createElement('span');
      saveStatus.className = 'text-xs text-dim';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn-primary text-xs';
      saveBtn.textContent = t('common.save');
      saveBtn.disabled = true;
      saveRow.append(saveStatus, saveBtn);

      textarea.addEventListener('input', () => {
        saveBtn.disabled = textarea.value === text;
        saveStatus.textContent = '';
      });

      saveBtn.onclick = async () => {
        const next = textarea.value;
        saveBtn.disabled = true;
        // Awaited, then applied: a save may ask something first and be
        // refused — see the ABC branch's theSessionScoreSaver.
        const result = await onSave(arrayBufferToBase64(new TextEncoder().encode(next).buffer));
        if (result === false) {
          saveBtn.disabled = textarea.value === text;
          return;
        }
        text = next;
        if (typeof result === 'string') {
          shownName = result;
          updateTopModal({ title: result });
        }
        saveStatus.textContent = t('fileViewer.text.saved');
        // The rendered face is showing what was saved a moment ago, so it is
        // repainted even while hidden: unlike a score's SVG, markdown costs
        // nothing to redraw and has no layout to reflow visibly.
        if (markdown) paint();
      };

      if (!markdown) {
        container.append(textarea, saveRow);
      } else {
        const tabBar = document.createElement('div');
        tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg w-fit';
        const mkTab = (label: string): HTMLButtonElement => {
          const b = document.createElement('button');
          b.textContent = label;
          b.className = 'px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer';
          return b;
        };
        const renderedTab = mkTab(t('fileViewer.text.renderedTab'));
        const sourceTab = mkTab(t('fileViewer.text.sourceTab'));
        tabBar.append(renderedTab, sourceTab);

        const setTextMode = (mode: 'rendered' | 'source') => {
          const active = 'bg-accent text-white';
          const inactive = 'text-muted hover:text-primary hover:bg-elevated';
          renderedTab.className = `px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${mode === 'rendered' ? active : inactive}`;
          sourceTab.className = `px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${mode === 'source' ? active : inactive}`;
          rendered.style.display = mode === 'rendered' ? '' : 'none';
          textarea.style.display = mode === 'source' ? 'block' : 'none';
          saveRow.style.display = mode === 'source' ? 'flex' : 'none';
          if (mode === 'source') focusIfDesktop(textarea);
        };
        renderedTab.onclick = () => setTextMode('rendered');
        sourceTab.onclick = () => setTextMode('source');

        container.append(tabBar, rendered, textarea, saveRow);
        paint();
        // Opens on the page, not on its source: reading is what one opens a
        // note for, and the tab is right there for the other half. An EMPTY
        // note is the exception — a blank page added to be written in, whose
        // rendered face is nothing at all.
        setTextMode(text.trim() === '' ? 'source' : 'rendered');
      }
    }
  }

  // Scores only: neither the preferences nor the room to spread out applies to
  // an image, a PDF or a recording. A score is the one thing here that a wider
  // frame genuinely re-renders — abcjs lays out to the container, so the extra
  // width buys fewer line breaks rather than a bigger picture.
  const isScore = isAbcFile(entry);
  const onRename = opts?.onRename;
  showModal(entry.name, body, [], {
    maxWidth: modalWidth(entry),
    onDismiss,
    expandable: isScore,
    onExpandedChange: (expanded) => onModalExpanded?.(expanded),
    titleEdit: onRename
      ? {
          suffix: splitFileName(entry.name).ext,
          onCommit: (value) => {
            const next = renamedFileName(shownName, value);
            if (!next) return;
            onRename(next);
            shownName = next;
            updateTopModal({ title: next });
          },
        }
      : undefined,
    headerActions: isScore
      ? [{
          icon: iconElement(GearIcon, 15),
          title: t('fileViewer.abc.prefs.title'),
          onClick: () => showAbcPrefsModal(() => reapplyAbcPrefs?.()),
        }]
      : [],
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderNotes(notes: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'markdown text-sm leading-relaxed';
  // Empty notes render as nothing at all: the card page hides the body when
  // there is none, and study never calls this with an empty string.
  if (!notes.trim()) return wrap;
  renderMarkdown(notes).then(html => {
    wrap.innerHTML = html;
    wrap.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }).catch(() => { wrap.textContent = notes; });
  return wrap;
}
