import LZString from 'lz-string';
import type { AbcOpenMode, AbcPaper, FileEntry } from '../types';
import { entryToObjectUrl, entryToBytes, arrayBufferToBase64, focusIfDesktop, downloadBlob, isAppleTouchDevice } from '../utils';
import { isNative } from '../native/platform';
import { renderMarkdown, sanitizeEmphasisOnly } from './markdown';
import { mkCustomSelect } from './customSelectVanilla';
import { qualityColour, faded } from './followColour';
import { starIconElement, iconElement, ExternalLinkIcon, GearIcon, TrashIcon, PlusIcon, ExpandIcon, CollapseIcon,
  MetronomeIcon, TuningForkIcon, SwingStraightIcon, SwingLightIcon, SwingMediumIcon, SwingStrongIcon,
  WarningTriangleIcon, ChevronDownIcon, ScoreFollowIcon, CloudIcon, ArrowLeftIcon, ArrowRightIcon } from './icons';
import { t } from '../services/i18nService';
import { unlockAbcjsAudio, claimAudioFocus, releaseAudioFocus } from '../services/audioSession';
import { abcjsVolumeMultiplier } from '../services/playbackVolume';
import { injectDefaultTempo, stripForRender, isAbcFile, decodeAbc, splitAbcTunes, parseAbcBlock, abcOpenMode,
  showAbcSyntaxCheck, blankForRender, locateAbcWarning, abcWarningRange,
  abcPaper, abcPaperSetting, ABC_PAPER_AUTO, abcSwingAtOpen, meterCanSwing,
  ABC_PAPERS, SWING_CHOICES, NO_SWING, stepSwingChoice } from '../services/abcService';
import { engraveScore, type ScoreMeasure } from '../services/abcLineBreaks';
import { ENGRAVE_HYSTERESIS, engraveOptions, engraveWidthOf, cropToInk } from './scoreEngraving';
import { swingAudioParams } from '../services/jigSwing';
import { modalMaxH, modalMaxW, getZoom } from '../services/zoomService';
import {
  playableSource, sourceIndex, playPlan, noteRanges, resumeInside, passOf, eventAt,
  notesOf, startNoteAt, boxRange, bodyIndex, isNote, touches, type ParsedNote, type PlayableSource, type TimingEvent,
} from '../services/abcTextPlayback';
import { tapTracks, tappedNote, secondsPerWhole, playTap, stopTap, tapPlaysNote, type MidiPitch } from '../services/abcTapNote';
import { shiftPosition, boundNote, notesAcross, regionOf, setBound, type Bounds } from '../services/abcBounds';
import { showModal, updateTopModal, confirmModal, askUnsavedChanges } from './modal';
import { splitFileName, renamedFileName, safeFileName } from '../services/attachmentNames';
import type { AudioPresetsBinding } from '../services/audioPresets';
import { playIcon, pauseIcon, stopIcon, rewindIcon, repeatIcon, boundIcon } from './playbackIcons';
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
 *  Opaque background and a stacking order, or the notation shows through.
 *
 *  All of that is on the ROW the transport sits in since 2026-10-15
 *  (BOTTOM_ROW_CLASS): the source face's version and save buttons share its
 *  line, and a sticky element only sticks within its parent — on the
 *  transport, inside a row its own height, it would no longer stick at all. */
const TRANSPORT_CLASS = 'abc-transport flex items-center justify-center gap-2 flex-wrap';
/** The bottom row: the transport in the middle, the source face's version
 *  buttons on its left and Save on its right — on one line while they fit,
 *  the transport on a line of its own above them when they do not (the user,
 *  2026-10-15; laid out by `.abc-bottom-row` in styles.css, decided by
 *  `layoutBottomRow`). */
const BOTTOM_ROW_CLASS = 'abc-bottom-row sticky -bottom-4 z-10 bg-elevated py-2';

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
//
// WHERE the lines break is no longer abcjs's `wrap` either, since 2026-10-24:
// the score follows the lines of the ABC, as TheSession draws it, and only cuts
// one that does not fit — see abcLineBreaks.ts and its `engraveScore`. The
// "bars per line" setting went with it. And a line is never spread wider than
// a readable width per quaver, however wide the box (2026-10-28): see
// MAX_QUAVER_WIDTH.
//
// The options and the crop to the ink are in scoreEngraving.ts, shared with
// the score that follows a recording (syncedScore.tsx).

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


/** How far before a clicked note to seek — see the click handler for why an
 *  exact seek lands on the wrong note. */
const SEEK_BACKOFF_MS = 10;

/** How far from a note a tap may land and still mean it, in window pixels —
 *  across, to the nearest note of the system, and above or below the system.
 *  About half a fingertip: notes in a phone-width bar sit a dozen pixels
 *  apart, so the nearest one wins long before this is reached, and a tap
 *  further off than this is a tap on empty paper. */
const TAP_REACH_PX = 20;

/** How far a press may travel and still be a tap rather than a drag. */
const TAP_SLOP_PX = 10;

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

/** One glyph per entry of SWING_CHOICES, in its order: the gauge's level is
 *  the index. */
const SWING_GLYPHS = [SwingStraightIcon, SwingLightIcon, SwingMediumIcon, SwingStrongIcon];

/** The swing button: four settings cycled by one press each, drawn as a rhythm
 *  and a gauge rather than named — the name ("swing moyen") was wider than the
 *  transport beside it. The NAME is still there, in the tooltip and for a
 *  screen reader.
 *
 *  Right-click walks BACK through them, so a cycle of four is never three
 *  presses away from the one you wanted. `contextmenu` rather than a long
 *  press: this is a pointer affordance, and on a touch screen a fifth press
 *  simply comes round again.
 *
 *  The same button in the viewer's transport and in the playback preferences
 *  (the user's call, 2026-10-22: the setting is chosen the way it is seen,
 *  not from a list). `onChange` fires on every press with the new value. */
function mkSwingButton(initial: number, onChange: (value: number) => void): HTMLButtonElement {
  let value = initial;
  const btn = document.createElement('button');
  btn.className = 'abc-chip';
  const show = () => {
    const i = Math.max(0, SWING_CHOICES.findIndex(c => c.value === value));
    btn.replaceChildren(iconElement(SWING_GLYPHS[i] ?? SwingStraightIcon, 16));
    btn.classList.toggle('abc-chip-on', value !== NO_SWING);
    const label = `${t('fileViewer.abc.swing')} · ${t(SWING_CHOICES[i]!.labelKey)}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };
  const step = (d: 1 | -1) => {
    value = stepSwingChoice(value, d);
    show();
    onChange(value);
  };
  show();
  btn.onclick = () => { btn.blur(); step(1); };
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    btn.blur();
    step(-1);
  });
  return btn;
}

/** Playback preferences, reachable from any score's header and stored on the
 *  user, so they travel with everything else through Drive. They describe the
 *  listener rather than the tune: which instrument to hear it on, and how fast
 *  a score should open when you are still learning it.
 *
 *  `onApply` re-primes the score that is open, so a change is heard at once
 *  instead of at the next opening. `onSyntaxCheck` re-reads its text when the
 *  syntax check is turned on or off. */
export function showAbcPrefsModal(onApply: () => void, onSyntaxCheck?: () => void): void {
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

  // ── Swing at opening ──
  // Saved only, like the speed and for the same reason: it is how the NEXT
  // score starts. The one on screen has its own button, two centimetres away.
  // Straight is the absence, like the speed's 100 %.
  const swingBtn = mkSwingButton(abcSwingAtOpen(appState.value), (v) => {
    void mutate(st => { if (v === NO_SWING) delete st.abcSwingAtOpen; else st.abcSwingAtOpen = v; });
  });

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

  // ── A tapped note, heard ──
  // Saved only: it is read at each tap, so the score on screen follows it
  // without being re-primed.
  const tapBox = document.createElement('input');
  tapBox.type = 'checkbox';
  tapBox.className = 'card-checkbox';
  tapBox.checked = tapPlaysNote(appState.value);
  tapBox.addEventListener('change', () => {
    const on = tapBox.checked;
    void mutate(st => { if (on) delete st.abcTapPlaysNote; else st.abcTapPlaysNote = false; });
  });

  // ── The ABC face's syntax check ──
  // Applied at once to the score open behind, which only has to re-read its
  // text: nothing is engraved for it.
  const syntaxBox = document.createElement('input');
  syntaxBox.type = 'checkbox';
  syntaxBox.className = 'card-checkbox';
  syntaxBox.checked = showAbcSyntaxCheck(appState.value);
  syntaxBox.addEventListener('change', () => {
    const on = syntaxBox.checked;
    void mutate(st => { if (on) st.abcShowSyntaxCheck = true; else delete st.abcShowSyntaxCheck; })
      .then(() => onSyntaxCheck?.());
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

  // "Bars per line" lived here until 2026-10-24: the score follows the lines
  // of the ABC now (see engraveScore), and cuts them only where they do not fit.
  body.append(
    row('fileViewer.abc.prefs.speed', speedControl),
    row('fileViewer.abc.prefs.swing', swingBtn),
    row('fileViewer.abc.instrument', instrSelect),
    row('fileViewer.abc.paper', paperSelect),
    row('fileViewer.abc.prefs.includeRepeats', repeatsBox),
    row('fileViewer.abc.prefs.tapPlaysNote', tapBox),
    row('fileViewer.abc.prefs.syntaxCheck', syntaxBox),
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
  // + pressed several times, and the first press makes the dialog taller: the
  // reset appears, and the sentence can take a second line.
  showModal(t('fileViewer.abc.transpose'), body, [], { maxWidth: '20rem', pinTop: true });
}

// ── Preview modal ─────────────────────────────────────────────────────────────

/** Keeps the screen on while a page is read from without being touched — a
 *  score or a PDF given the whole page, on a music stand.
 *
 *  Every step is optional: the API is absent on some browsers, the request
 *  is refused when the page is not visible, and the lock is dropped by the
 *  system whenever the tab goes to the background — which is why it is
 *  re-taken on `visibilitychange` rather than assumed to hold. */
function screenWakeLock(): { hold: () => void; release: () => void } {
  let wanted = false;
  let lock: { release: () => Promise<void> } | null = null;
  const take = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = navigator as any;
    if (!nav.wakeLock?.request || document.visibilityState !== 'visible') return;
    nav.wakeLock.request('screen')
      // A lock that arrives after the page was left is released at once,
      // rather than held for a reader who is no longer reading.
      .then((l: { release: () => Promise<void> }) => {
        if (wanted) lock = l; else void l.release().catch(() => {});
      })
      .catch(() => { /* refused: the page is readable all the same */ });
  };
  const onVisibility = () => { if (wanted && !document.hidden) take(); };
  return {
    hold: () => {
      if (wanted) return;
      wanted = true;
      document.addEventListener('visibilitychange', onVisibility);
      take();
    },
    release: () => {
      wanted = false;
      document.removeEventListener('visibilitychange', onVisibility);
      const held = lock;
      lock = null;
      void held?.release().catch(() => {});
    },
  };
}

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
  /** An audio file's presets (audioPresets.ts). Absent: the player has no
   *  preset bar — there is nowhere to keep them. */
  audioPresets?: AudioPresetsBinding;
  /** A score with a recording of it: the viewer offers "Play along", which
   *  puts that recording's player in the score's place, the score following
   *  it (2026-10-28, the user). Today a detection's score, its recording the
   *  analysis's (session/ui/ScoreFollowView.tsx). */
  playAlong?: PlayAlongBinding;
}

/** What the viewer is handed to play a score along its recording. */
export interface PlayAlongBinding {
  /** The recording is only on Drive: the toggle wears the play button's cloud. */
  fromDrive: boolean;
  /** Whether this version — its ABC, as the viewer shows it — can be played
   *  along: the toggle is offered on those only. */
  plays: (version: string) => boolean;
  /** Puts the play-along of `version` in `host`, on the viewer's face (stave
   *  or text) and at its size. `onState` hears how its alignment goes. */
  mount: (
    host: HTMLElement, version: string, face: 'sheet' | 'text', expanded: boolean,
    onState: (s: PlayAlongState) => void, forced: boolean,
  ) => PlayAlongView;
}

/** Where a play-along's alignment stands — what its toggle shows (2026-10-29,
 *  the user): filling up like a progress bar while it is made, then coloured
 *  by how well it fits, on followColour.ts's red-to-green scale — red when
 *  there is none to follow, too poor to be trusted or impossible. `percent`:
 *  the share of notes on the score, when there was an alignment. `title` says
 *  it in full, for the tooltip. */
export type PlayAlongState =
  | { kind: 'aligning'; ratio: number; title: string }
  | { kind: 'aligned'; title: string; percent: number }
  | { kind: 'none'; title: string; percent?: number };

/** Room the toggle's label needs beyond its own width to come back once it
 *  was dropped (fitPlayAlong). */
const PLAY_ALONG_SLACK_PX = 8;

/** A press this long on the toggle is the hidden "follow anyway". */
const LONG_PRESS_MS = 550;

/** A play-along in place, as the viewer drives it: its versions, its tabs,
 *  its full page. */
export interface PlayAlongView {
  /** Another version on screen, one `plays` accepts: aligned anew, the
   *  player kept — the recording has not changed (2026-10-29, the user). */
  setVersion: (version: string) => void;
  /** Followed even when the alignment is judged too poor to be (the hidden
   *  gesture on the toggle). */
  setForced: (forced: boolean) => void;
  setFace: (face: 'sheet' | 'text') => void;
  setExpanded: (expanded: boolean) => void;
  unmount: () => void;
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
  // Set by the ABC branch while a play-along is on: its player goes with the
  // modal.
  let releasePlayAlong: () => void = () => {};
  const onDismiss = () => { closed = true; stopAudio(); releaseKeys(); releasePdf(); releaseFullscreen(); releasePlayAlong(); };

  const body = document.createElement('div');
  body.className = 'w-full flex items-center justify-center';

  // Filled in by the ABC branch; the header gear needs a way to re-prime the
  // score once preferences change, and only that branch knows how.
  let reapplyAbcPrefs: (() => void) | null = null;
  // Same shape, for the syntax check being turned on or off there.
  let recheckAbcSyntax: (() => void) | null = null;
  // Same shape, for the header's way out to abcTools: only the score branch
  // knows which version is on screen.
  let openInAbcTools: (() => void) | null = null;
  // Same shape, for the dialog's own "Full page": the score branch is the only
  // one that sizes anything against the room the dialog has.
  let onModalExpanded: ((expanded: boolean) => void) | null = null;
  // Same shape again: the branches that edit text decide whether closing has
  // to ask first (see ModalOptions.guardDismiss).
  let guardClose: ((dismiss: () => void) => boolean) | null = null;

  const m = entry.mimeType;
  // 0.85 (not 0.9) to match the shared modal shell's own dialog max-height
  // (modal.tsx) now that this modal is portaled through it — media sized
  // against a bigger budget than the dialog actually allows would overflow.
  const mediaMaxH = `calc(${modalMaxH(0.85)} - 80px)`;

  if (m.startsWith('audio/')) {
    body.classList.replace('items-center', 'items-start');
    import('./audioPlayer').then(({ renderAudioPlayer, unmountAudioPlayer, stopCurrentAudio }) => {
      // Modal may already have been dismissed while this dynamic import was
      // in flight — don't spin up an AudioContext nobody will ever close.
      if (closed) return;
      const player = renderAudioPlayer(entry, opts?.audioPresets);
      body.appendChild(player);
      // The sound first, then the screen: a Preact tree since 2026-10-10,
      // whose effects (its animation frame, its resize watch) end with it.
      stopAudio = () => { stopCurrentAudio(); unmountAudioPlayer(player); };
    });

  } else if (m.startsWith('video/')) {
    const video = document.createElement('video'); video.controls = true; video.className = 'max-w-full rounded';
    // In the dialog, not taken over to full screen the moment it plays (iPhone).
    video.playsInline = true;
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
    //
    // Not on an iPhone or an iPad, which say they have a viewer and, in a
    // frame, show the first page alone with no way to scroll to the next. They
    // get pdf.js — when they can run it: pdf.js 6 needs Promise.withResolvers
    // (Safari 17.4) and does not polyfill it; older ones keep the first page.
    const pdfJsRuns = typeof (Promise as { withResolvers?: unknown }).withResolvers === 'function';
    const useEmbed = navigator.pdfViewerEnabled !== false && !(isAppleTouchDevice() && pdfJsRuns);

    // ── The reading page (2026-10-15, group feedback: "PDFs in full screen,
    // like the scores") ──
    // Two ways to more room. The dialog's own "Full page" (modal.tsx), which
    // keeps its header; and this, the score's reading page: the PDF alone on
    // the page, its way out the very button that led in, the screen kept on.
    // Neither viewer offers one to call: the browser's, in an <embed>, takes
    // no orders from the page, and pdf.js is used without its viewer app —
    // its presentation mode lives in that app, not in the library.
    //
    // The PDF and its button travel together, MOVED into an overlay on
    // document.body for the reason the score's comment gives: the dialog
    // around them would clip anything merely pinned in place. Moving an
    // <embed> reloads it, which for a blob: URL costs nothing but the page
    // the reader was on.
    const pdfFrame = document.createElement('div');
    pdfFrame.className = 'relative w-full';
    body.appendChild(pdfFrame);
    const pdfAnchor = document.createComment('pdf');
    let pdfFullscreen: HTMLElement | null = null;
    let pdfModalExpanded = false;
    let unregisterPdfFullscreen = () => {};
    const pdfWakeLock = screenWakeLock();

    /** The viewer: the browser's <embed>, or the box pdf.js draws pages into. */
    let viewer: HTMLElement;
    /** Its height: the dialog's room, more of it once the dialog itself has
     *  the page (its header and padding still take theirs), and none set on
     *  the reading page, whose column sizes it. */
    const sizePdf = () => {
      const height = pdfFullscreen ? ''
        : pdfModalExpanded ? `calc(${modalMaxH(1)} - 6rem - var(--safe-top) - var(--safe-bottom))`
        : mediaMaxH;
      if (useEmbed) viewer.style.height = height; else viewer.style.maxHeight = height;
    };

    if (useEmbed) {
      // An <embed> loading a blob: URL is governed by the page's object-src —
      // which must keep allowing blob: (webpack.config.js's CSP). With 'none'
      // this rendered an empty frame and said nothing (2026-09-06 to 14).
      //
      // `#navpanes=0`: the page thumbnails closed at opening (2026-10-15, the
      // user) — they took a third of a dialog's width from the page itself.
      // Adobe's open parameter, which Chrome's viewer reads too (its
      // open_pdf_params_parser.ts: navpanes alone hides the side panel and
      // keeps the toolbar); the panel's own button still opens it. Firefox
      // opens with it closed anyway; a viewer that knows nothing of it
      // ignores a fragment.
      const embed = document.createElement('embed'); embed.src = `${entryToObjectUrl(entry)}#navpanes=0`;
      embed.type = 'application/pdf'; embed.className = 'block w-full rounded';
      viewer = embed;
      pdfFrame.appendChild(embed);
    } else {
      // No inline PDF viewer here — Chrome on Android, first of all — so an
      // <embed> would stay an empty frame. The pages are drawn with pdf.js
      // instead, loaded only now (see pdfCanvas.ts). Handing the file to the
      // device was tried first and turned down: on the phone it downloaded.
      const frame = document.createElement('div');
      frame.className = 'w-full overflow-y-auto';
      viewer = frame;
      const loading = document.createElement('p');
      loading.className = 'text-sm text-muted text-center py-6';
      loading.textContent = t('fileViewer.pdf.loading');
      frame.appendChild(loading);
      pdfFrame.appendChild(frame);

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
          open.download = safeFileName(entry.name);
          // The Android app's WebView ignores `download` on a blob: link.
          if (isNative()) open.addEventListener('click', e => {
            e.preventDefault();
            downloadBlob(new Blob([entryToBytes(entry)], { type: entry.mimeType }), entry.name);
          });
          open.className = 'btn-primary';
          open.textContent = t('fileViewer.pdf.open');
          box.append(msg, open);
          frame.replaceChildren(box);
        });
    }
    sizePdf();
    onModalExpanded = (expanded) => { pdfModalExpanded = expanded; sizePdf(); };

    // The score's own button (2026-10-15, the user: "the same as for the ABC
    // scores"), top right of where the pages are. Its class reads its colours
    // from the paper it sits on (--abc-ink); a PDF has no paper of ours, so it
    // gets a white patch of one — black ink on it reads over a white page, the
    // dialog of either theme, and the browser viewer's grey alike.
    //
    // Over pdf.js, the frame's corner is the first page's. Over the browser's
    // viewer, the top of the frame is the viewer's own toolbar (download,
    // print, its menu, at the right): the button goes under it, and left of
    // its scrollbar. 56 px is Chrome's toolbar; Firefox's is lower and
    // Safari's floats at the bottom, where both leave the button in the
    // grey around the page.
    const pdfFullscreenBtn = document.createElement('button');
    pdfFullscreenBtn.className = 'abc-score-tool-small absolute z-20 rounded transition-colors cursor-pointer flex items-center justify-center';
    pdfFullscreenBtn.style.setProperty('--abc-ink', '#000000');
    pdfFullscreenBtn.style.background = 'rgba(255, 255, 255, 0.85)';
    Object.assign(pdfFullscreenBtn.style, useEmbed
      ? { top: '3.75rem', right: '1.25rem' }
      : { top: '0.25rem', right: '0.25rem' });
    const labelPdfButton = () => {
      const key = pdfFullscreen ? 'fileViewer.pdf.fullscreenExit' : 'fileViewer.pdf.fullscreen';
      pdfFullscreenBtn.replaceChildren(iconElement(pdfFullscreen ? CollapseIcon : ExpandIcon, 13));
      pdfFullscreenBtn.title = t(key);
      pdfFullscreenBtn.setAttribute('aria-label', t(key));
    };
    labelPdfButton();
    pdfFrame.appendChild(pdfFullscreenBtn);

    const exitPdfFullscreen = () => {
      if (!pdfFullscreen) return;
      unregisterPdfFullscreen();
      unregisterPdfFullscreen = () => {};
      pdfWakeLock.release();
      pdfFrame.classList.remove('flex', 'flex-col', 'flex-1', 'min-h-0');
      viewer.classList.remove('flex-1', 'min-h-0');
      viewer.classList.add('rounded');
      pdfAnchor.replaceWith(pdfFrame);
      pdfFullscreen.remove();
      pdfFullscreen = null;
      sizePdf();
      labelPdfButton();
    };
    const enterPdfFullscreen = () => {
      if (pdfFullscreen) return;
      const overlay = document.createElement('div');
      // The score's overlay, to the class: the dialog colour shows only in
      // the bands under the system bars.
      overlay.className = 'fixed inset-0 z-[100] flex flex-col safe-area-pad';
      overlay.style.background = 'var(--color-elevated)';
      pdfFrame.replaceWith(pdfAnchor);
      pdfFrame.classList.add('flex', 'flex-col', 'flex-1', 'min-h-0');
      viewer.classList.remove('rounded');
      viewer.classList.add('flex-1', 'min-h-0');
      overlay.appendChild(pdfFrame);
      document.body.appendChild(overlay);
      pdfFullscreen = overlay;
      sizePdf();
      labelPdfButton();
      pdfWakeLock.hold();
      // Topmost overlay: Escape and the Android back gesture leave the
      // reading page, not the viewer underneath it.
      unregisterPdfFullscreen = registerOverlay(exitPdfFullscreen);
    };
    pdfFullscreenBtn.addEventListener('click', () => {
      pdfFullscreenBtn.blur();
      if (pdfFullscreen) exitPdfFullscreen(); else enterPdfFullscreen();
    });
    // The viewer can be taken down from elsewhere while the PDF has the page
    // (closeAllModals): the overlay must not outlive it.
    releaseFullscreen = exitPdfFullscreen;

  } else if (isAbcFile(entry)) {
    body.classList.replace('items-center', 'items-start');
    let abcText = decodeAbc(entry);

    // Reassignable, because a derived score can be rebuilt under the open
    // viewer — see PreviewModalOpts.reloadEntry.
    let tunes = splitAbcTunes(abcText);
    let versionCount = tunes.length;
    let currentIndex = Math.max(0, Math.min(versionCount - 1, opts?.initialIndex ?? 0));
    let favoriteIndex = opts?.favoriteIndex;
    // The edit typed in the source box and not saved yet, for the version it
    // was typed in. It outlives the box: the stave draws it (the score on
    // screen is the one being written, saved or not), and leaving the version
    // or the dialog asks what to do with it instead of dropping it — which is
    // what both did, silently, until 2026-10-13.
    let draft: { index: number; body: string } | null = null;
    /** What a version reads as right now — its edit when it has one. Every
     *  reader of the TUNE goes through this (the stave, its sound, the swing
     *  chip, abcTools); only what WRITES the file reads `tunes` itself. */
    function shownBlock(index: number): string {
      return draft && draft.index === index ? withXLine(index, draft.body) : (tunes[index] ?? '');
    }
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
    // The paper is the user's stored preference and is written back the moment
    // it is changed here: unlike the opening speed, it describes how the
    // reader wants to see a score, and a reader who turns the page dark wants
    // the next one dark too.
    let paper: AbcPaper = abcPaper(appState.value);
    // The swing is the opening speed's kind, not the paper's (2026-10-22, a
    // tester's request): a reel swung for one tune went on swinging every
    // score opened after it. It starts from the preferences' setting, and the
    // button changes this score only.
    let swing = abcSwingAtOpen(appState.value);
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
    sheetTabBtn.onclick = () => chooseMode('sheet');
    textTabBtn.onclick  = () => chooseMode('text');
    tabBar.append(sheetTabBtn, textTabBtn);
    tabBar.dataset.tour = 'abc-tabs';

    const versionNav = document.createElement('div');
    versionNav.className = `flex items-center gap-1 p-1 bg-bg rounded-lg w-fit ${versionCount <= 1 ? 'hidden' : ''}`;
    const mkNavBtn = (icon: typeof ArrowLeftIcon, label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.append(iconElement(icon, 16));
      b.setAttribute('aria-label', label);
      b.title = label;
      b.className = 'abc-tool-btn text-xs font-medium text-muted hover:text-primary hover:bg-elevated disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted';
      return b;
    };
    const prevBtn = mkNavBtn(ArrowLeftIcon, t('fileViewer.abc.prevVersion'));
    const versionLabel = document.createElement('span');
    versionLabel.className = 'px-1 text-xs font-medium text-muted tabular-nums';
    const nextBtn = mkNavBtn(ArrowRightIcon, t('fileViewer.abc.nextVersion'));
    // Leaving a version with an edit pending asks first — see `draft`.
    prevBtn.onclick = () => settleDraft(() => goToVersion(currentIndex - 1));
    nextBtn.onclick = () => settleDraft(() => goToVersion(currentIndex + 1));
    versionNav.append(prevBtn, versionLabel, nextBtn);
    versionNav.dataset.tour = 'abc-versions';

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

    // The way out to abcTools is the dialog header's, beside the gear, since
    // 2026-10-10 (the user): it acts on the whole tune, like the preferences,
    // not on the page being read. It opens the version on screen.
    openInAbcTools = () => { window.open(abcToolsShareUrl(shownBlock(currentIndex)), '_blank', 'noopener,noreferrer'); };

    // ── What is left in the row ──────────────────────────────────────────────
    // The paper and the bars per line lived here until the user moved them
    // (2026-09-21): they are set once and then left alone for months, which is
    // what the gear is for. The way out to abcTools went to the header and the
    // full page onto the score itself (2026-10-10), so the row is the tabs and
    // the versions.
    topRow.append(tabBar, versionNav);
    container.appendChild(topRow);

    // ── Play along (2026-10-28, the user) ────────────────────────────────────
    // A toggle at the end of the row, for a score that comes with a recording
    // of it: on, the recording's player takes the score's place — waveform,
    // tempo, transposition, region — the score drawn above it following what
    // is heard; off, the viewer is as it was left. The tabs stay and drive it
    // (the text face lights the note heard, read-only), and so do the versions:
    // another version is aligned anew (2026-10-29, the user — one may want to
    // play along a version other than the one heard). Only a version the
    // binding can follow offers it (`plays`). The viewer's own sound, its full
    // page and its space bar stand down meanwhile.
    const playAlong = opts?.playAlong;
    let playAlongView: PlayAlongView | null = null;
    let playAlongHost: HTMLElement | null = null;
    /** What the play-along hid, with how each was shown, to put back. */
    let hiddenByPlayAlong: Array<[HTMLElement, string]> = [];
    const playAlongBtn = playAlong ? document.createElement('button') : null;
    /** How the alignment of the version on screen stands: the toggle shows it
     *  (PlayAlongState) instead of anything over the score. Kept when the
     *  toggle is turned off once it is known — the alignment is still the
     *  same — and dropped with the version. */
    let playAlongState: PlayAlongState | null = null;
    const paintPlayAlong = (): void => {
      if (!playAlongBtn || !playAlong) return;
      const on = !!playAlongView;
      const s = playAlongState;
      // Once the alignment is in: the quality's colour, continuous — the
      // waveform's tint uses the same scale.
      const colour = !s || s.kind === 'aligning' ? null
        : s.percent !== undefined ? qualityColour(s.percent / 100) : 'var(--color-danger)';
      const look = colour ? 'hover:brightness-110'
        : on ? 'border-accent/60 text-accent' : 'border-border text-muted hover:text-primary hover:border-accent/50';
      playAlongBtn.className = `ml-auto inline-flex items-center gap-1.5 ${playAlongCompact ? 'px-2.5' : 'px-3'} min-h-[2.25rem] text-xs font-medium rounded-full border transition-colors cursor-pointer ${look}`;
      playAlongBtn.style.color = colour ?? '';
      playAlongBtn.style.borderColor = colour ? faded(colour, on ? 0.6 : 0.4) : '';
      playAlongBtn.style.backgroundColor = colour && on ? faded(colour, 0.14) : '';
      // The toggle as a progress bar while the alignment is made: filled from
      // the left as far as it has gone.
      if (s?.kind === 'aligning') {
        const p = Math.round(s.ratio * 100);
        playAlongBtn.style.backgroundImage = `linear-gradient(to right, color-mix(in srgb, var(--color-accent) 22%, transparent) ${p}%, transparent ${p}%)`;
      } else {
        playAlongBtn.style.backgroundImage = '';
      }
      playAlongBtn.setAttribute('aria-pressed', String(on));
      // How well, in figures, on the toggle itself (2026-10-29, the user).
      const percent = s && s.kind !== 'aligning' ? s.percent : undefined;
      const label = percent === undefined
        ? t('fileViewer.abc.playAlong')
        : t('fileViewer.abc.playAlong.percent', { percent });
      playAlongLabel.textContent = label;
      playAlongBtn.setAttribute('aria-label', label);
      const title = s?.title ?? t(playAlong.fromDrive ? 'fileViewer.abc.playAlong.hintDrive' : 'fileViewer.abc.playAlong.hint');
      // Its name in the tooltip once the label is gone.
      playAlongBtn.title = playAlongCompact ? `${label} · ${title}` : title;
      // The label may have grown (its figure): does it still fit?
      fitPlayAlong();
    };
    const playAlongLabel = document.createElement('span');
    /** The icon alone when the label does not fit at the end of the row (the
     *  user, 2026-10-29) rather than the toggle wrapping onto a line of its
     *  own: its colour still says how well, its tooltip the rest. */
    let playAlongCompact = false;
    const fitPlayAlong = (): void => {
      if (!playAlongBtn || playAlongBtn.style.display === 'none' || !playAlongBtn.isConnected) return;
      // Its width in its FULL shape, label shown and full padding — measured
      // so whichever shape it is in, in the same task, so nothing is painted
      // in between. Measured in the icon's narrower padding, the label seemed
      // to fit by a few pixels, came back, overflowed, went: the toggle
      // flickered between the two for as long as the width stood at the edge
      // (2026-10-29, the user).
      playAlongLabel.style.display = '';
      playAlongBtn.classList.replace('px-2.5', 'px-3');
      const full = playAlongBtn.offsetWidth;
      playAlongBtn.classList.replace('px-3', playAlongCompact ? 'px-2.5' : 'px-3');
      const gap = parseFloat(getComputedStyle(topRow).columnGap) || 0;
      const others = Array.from(topRow.children).reduce((sum, el) => (
        el === playAlongBtn || el === rowRuler || !(el as HTMLElement).offsetParent ? sum : sum + (el as HTMLElement).offsetWidth + gap
      ), 0);
      const room = topRow.clientWidth - others;
      // And a few pixels to spare before the label comes back: at the edge,
      // a rounding either way must not toggle it.
      const compact = playAlongCompact ? full + PLAY_ALONG_SLACK_PX > room : full > room;
      playAlongLabel.style.display = compact ? 'none' : '';
      if (compact !== playAlongCompact) { playAlongCompact = compact; paintPlayAlong(); }
    };
    // At once, in the observer — which runs after layout and before paint: at
    // the next frame, the toggle was seen wrapping onto a line of its own for
    // one frame before it shrank (2026-10-29, the user). What is observed is
    // a ruler as wide as the row and of no height, which the change cannot
    // resize: observing the row itself, whose height the change does move,
    // is the loop the browser reports (see syncedScore.tsx).
    const rowRuler = document.createElement('div');
    rowRuler.setAttribute('aria-hidden', 'true');
    rowRuler.style.cssText = 'position:absolute;left:0;right:0;top:0;height:0;pointer-events:none';
    const rowWatch = new ResizeObserver(() => fitPlayAlong());
    const showPlayAlongBtn = (): void => {
      if (!playAlongBtn || !playAlong) return;
      playAlongBtn.style.display = playAlong.plays(shownBlock(currentIndex)) ? '' : 'none';
      fitPlayAlong();
    };
    /** Puts the play-along of the version on screen in its place. */
    const mountPlayAlong = (): void => {
      playAlongState = null;
      playAlongView = playAlong!.mount(playAlongHost!, shownBlock(currentIndex), currentMode, modalExpanded, (s) => {
        // Not once it is turned off: an alignment stopped half-way says nothing.
        if (!playAlongView) return;
        playAlongState = s;
        paintPlayAlong();
      }, playAlongForced);
    };
    /** The hidden way round the verdict (2026-10-29, the user): a right click
     *  — a long press on a touch screen — follows the alignment even when it
     *  is judged too poor to be, turning the toggle on if it was off; the same
     *  gesture again gives the verdict back. The toggle stays red: the
     *  alignment is no better for being shown. Not advertised. */
    let playAlongForced = false;
    let lastForceAt = 0;
    const forcePlayAlong = (): void => {
      // Android sends both a long press and a contextmenu for one gesture.
      const now = Date.now();
      if (now - lastForceAt < 800) return;
      lastForceAt = now;
      if (!playAlongView) {
        playAlongForced = true;
        setPlayAlong(true);
        return;
      }
      playAlongForced = !playAlongForced;
      playAlongView.setForced(playAlongForced);
    };
    const setPlayAlong = (on: boolean): void => {
      if (!playAlong || on === !!playAlongView) return;
      if (on) {
        // The score's own sound stops, for good. `pauseIfPlaying` and not just
        // `stopAudio`: abcjs's pause leaves `isStarted` set, and hiding the
        // stave — or leaving its full page — redraws it, a redraw that resumes
        // whatever `isStarted` says was playing (pendingRestore): the tune
        // started again under the play-along (2026-10-29, the user).
        pauseIfPlaying();
        stopAudio();
        stopTextPlay();
        if (fullscreen) exitFullscreen();
        hiddenByPlayAlong = Array.from(container.children)
          .filter((el): el is HTMLElement => el instanceof HTMLElement && el !== topRow)
          .map(el => [el, el.style.display]);
        for (const [el] of hiddenByPlayAlong) el.style.display = 'none';
        playAlongHost = document.createElement('div');
        container.appendChild(playAlongHost);
        mountPlayAlong();
      } else {
        playAlongView!.unmount();
        playAlongView = null;
        // Turned off, it starts afresh: forced only by the gesture again.
        playAlongForced = false;
        // An alignment stopped half-way is no alignment: the bar goes.
        if (playAlongState?.kind === 'aligning') playAlongState = null;
        playAlongHost?.remove();
        playAlongHost = null;
        for (const [el, display] of hiddenByPlayAlong) el.style.display = display;
        hiddenByPlayAlong = [];
        // Everything the face decides, decided again — the stave redrawn, as
        // a version changed meanwhile was drawn into a hidden box.
        sheetNeedsRerender = true;
        setAbcMode(currentMode);
      }
      paintPlayAlong();
    };
    /** Another version on screen: its play-along, aligned anew under the same
     *  player — or none, for a version the binding cannot follow. */
    const versionChangedForPlayAlong = (): void => {
      if (!playAlong) return;
      playAlongState = null;
      showPlayAlongBtn();
      if (playAlongView) {
        if (playAlong.plays(shownBlock(currentIndex))) {
          playAlongView.setVersion(shownBlock(currentIndex));
        } else {
          setPlayAlong(false);
        }
      }
      paintPlayAlong();
    };
    if (playAlongBtn && playAlong) {
      playAlongBtn.type = 'button';
      playAlongBtn.append(iconElement(ScoreFollowIcon, 13), playAlongLabel);
      if (playAlong.fromDrive) playAlongBtn.appendChild(iconElement(CloudIcon, 11));
      // A long press is not also a click once it has done its work.
      let pressTimer = 0, pressed = false;
      playAlongBtn.onclick = () => {
        if (pressed) { pressed = false; return; }
        setPlayAlong(!playAlongView);
      };
      playAlongBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); forcePlayAlong(); });
      // iOS has no contextmenu on a long press: timed by hand, touch only —
      // and its own callout and text selection kept off the button.
      playAlongBtn.style.setProperty('-webkit-touch-callout', 'none');
      playAlongBtn.style.userSelect = 'none';
      playAlongBtn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        pressed = false;
        window.clearTimeout(pressTimer);
        pressTimer = window.setTimeout(() => { pressed = true; forcePlayAlong(); }, LONG_PRESS_MS);
      });
      for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
        playAlongBtn.addEventListener(end, () => window.clearTimeout(pressTimer));
      }
      paintPlayAlong();
      showPlayAlongBtn();
      topRow.appendChild(playAlongBtn);
      topRow.classList.add('relative');
      topRow.appendChild(rowRuler);
      rowWatch.observe(rowRuler);
      releasePlayAlong = () => {
        rowWatch.disconnect();
        playAlongView?.unmount();
        playAlongView = null;
      };
    }
    /** A tab pressed: the viewer's face, or the play-along's. */
    const chooseMode = (mode: 'sheet' | 'text'): void => {
      if (!playAlongView) { setAbcMode(mode); return; }
      currentMode = mode;
      paintTabs(mode);
      playAlongView.setFace(mode);
    };

    // ── What abcjs made of the ABC ───────────────────────────────────────────
    // On the ABC face only, and only for whoever turned the check on (the
    // user, 2026-10-19). It was on both faces, always, from 2026-09-21: the
    // stave is where a wrong bar is noticed, the reasoning went. In practice
    // it was a strip of parser jargon over half the scores from TheSession,
    // read as "this tune is broken" by people who only wanted to play it.
    // The mistake itself is now marked IN the text, under the word abcjs
    // objects to (see `textWarnMarks`), and this strip is folded to its count
    // until it is opened.
    const warnRow = document.createElement('div');
    warnRow.className = 'hidden flex-col gap-1 px-3 py-2 rounded-lg text-xs border border-warn/30 bg-warn/10 text-primary';
    container.appendChild(warnRow);
    /** Folded or not: kept for the life of the viewer, since the strip is
     *  rebuilt at every pause in the typing. */
    let warningsOpen = false;
    /** Takes the caret to a place in the text. Set once the box exists. */
    let goToWarning: (at: number) => void = () => {};

    /** Fills the strip, or hides it. abcjs's warnings carry their own position
     *  ("Music Line:7 Char:12") and are shown as it writes them: they are a
     *  parser's words about a file the user wrote, and rewording them would
     *  cost the one thing that makes them useful. `at` is where each one was
     *  placed in the text, if it could be: a placed warning is a link to it. */
    const showWarnings = (list: string[], at: (number | null)[] = []) => {
      warnRow.replaceChildren();
      if (list.length === 0 || currentMode !== 'text' || !showAbcSyntaxCheck(appState.value)) {
        warnRow.classList.add('hidden'); warnRow.classList.remove('flex'); return;
      }
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'flex items-center gap-2 text-warn font-medium text-left cursor-pointer';
      head.appendChild(iconElement(WarningTriangleIcon, 13));
      const headText = document.createElement('span');
      headText.textContent = t('fileViewer.abc.warnings', { n: String(list.length) });
      const chevron = document.createElement('span');
      chevron.className = 'ml-auto transition-transform';
      chevron.appendChild(iconElement(ChevronDownIcon, 10));
      head.append(headText, chevron);
      const details = document.createElement('div');
      details.className = 'flex-col gap-1';
      const fold = () => {
        details.classList.toggle('hidden', !warningsOpen);
        details.classList.toggle('flex', warningsOpen);
        chevron.style.transform = warningsOpen ? 'rotate(180deg)' : '';
        head.setAttribute('aria-expanded', String(warningsOpen));
      };
      head.onclick = () => { warningsOpen = !warningsOpen; fold(); };
      fold();
      warnRow.append(head, details);
      // Capped, because a file that is wrong everywhere is wrong in one way
      // and the list would push the music off the screen to say so.
      list.slice(0, 4).forEach((w, i) => {
        const place = at[i] ?? null;
        // A button when it leads somewhere: the caret to the word, which is
        // where it gets fixed (the user, 2026-10-19).
        const line = document.createElement(place === null ? 'div' : 'button');
        line.className = 'abc-warning text-muted leading-relaxed break-words text-left';
        if (line instanceof HTMLButtonElement) {
          line.type = 'button';
          line.className += ' cursor-pointer hover:text-primary';
          line.onclick = () => goToWarning(place!);
        }
        // abcjs marks the offending character with markup of its own, around a
        // quote of the user's own ABC — so the string is neither plain text nor
        // safe HTML. `textContent` printed the tags; `innerHTML` would run the
        // attachment. Sanitised down to `<em>` and nothing else, and the
        // emphasis is painted from CSS (see `.abc-warning em`).
        line.textContent = w;
        void sanitizeEmphasisOnly(w).then(html => { line.innerHTML = html; }).catch(() => { /* keep the text */ });
        details.appendChild(line);
      });
      if (list.length > 4) {
        const more = document.createElement('div');
        more.className = 'text-dim';
        more.textContent = t('fileViewer.abc.warningsMore', { n: String(list.length - 4) });
        details.appendChild(more);
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
    // Capture phase: before abcjs's own handlers, still inside the tap — the
    // only moment Safari lets its audio start (audioSession.ts).
    controls.addEventListener('click', unlockAbcjsAudio, true);
    controls.dataset.tour = 'abc-play';
    transportBar.appendChild(controls);

    // ── The source face's transport (2026-10-15) ──
    // On the ABC face, the stave's own four buttons, copied: abcjs's widget
    // only exists once a stave has been drawn — never, for a score opened on
    // its source — and drives the stave's synth alone. Same classes, so the
    // same look (styles.css, `.abc-transport .abcjs-inline-audio`), and the
    // same row: the practice controls beside them are SHARED by both faces
    // (the user, 2026-10-15), and so is the loop. What they play here is the
    // text in the box — see `textTransport` where it is assigned.
    const textControls = document.createElement('div');
    textControls.className = 'abcjs-inline-audio shrink-0';
    textControls.style.display = 'none';
    const withClass = (svg: string, cls: string) => svg.replace('<svg ', `<svg class="${cls}" `);
    // abcjs's own spinner (synth/images/loading.svg.js), which its CSS turns.
    const LOADING_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="abcjs-loading-svg"><circle cx="50" cy="50" fill="none" stroke-width="20" r="35" stroke-dasharray="160 55"></circle></svg>';
    const mkTextBtn = (cls: string, html: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `abcjs-btn ${cls}`;
      b.innerHTML = html;
      b.title = title;
      b.setAttribute('aria-label', title);
      // Inside the tap, for Safari: see unlockAbcjsAudio.
      b.onclick = () => { b.blur(); unlockAbcjsAudio(); onClick(); };
      return b;
    };
    const textPlayBtn = mkTextBtn('abcjs-midi-start',
      withClass(playIcon(15), 'abcjs-play-svg') + withClass(pauseIcon(15), 'abcjs-pause-svg') + LOADING_SVG,
      t('fileViewer.abc.listen.title'), () => textTransport.playPause());
    const textRewindBtn = mkTextBtn('abc-midi-rewind', rewindIcon(15), t('fileViewer.abc.rewindStart'), () => textTransport.rewind());
    const textStopBtn = mkTextBtn('abcjs-midi-reset', stopIcon(15), t('fileViewer.abc.listen.stop'), () => textTransport.stop());
    const textLoopBtn = mkTextBtn('abcjs-midi-loop', repeatIcon(15), t('fileViewer.abc.listen.loop'), () => setLooping(!looping));
    textControls.append(textPlayBtn, textRewindBtn, textStopBtn, textLoopBtn);
    transportBar.appendChild(textControls);
    type TextPlayState = 'idle' | 'loading' | 'playing' | 'paused';
    /** How the text face's play button looks — abcjs's classes, abcjs's CSS. */
    const paintTextPlay = (state: TextPlayState): void => {
      textPlayBtn.classList.toggle('abcjs-pushed', state === 'playing');
      textPlayBtn.classList.toggle('abcjs-loading', state === 'loading');
    };
    /** The loop, one for both faces. On by default, as the stave's always was:
     *  a score is opened to be practised against. */
    let looping = true;
    const setLooping = (on: boolean): void => {
      looping = on;
      textLoopBtn.classList.toggle('abcjs-pushed', on);
    };
    setLooping(true);
    /** The text face's player — assigned once abcjs has loaded. */
    let textTransport = {
      playPause: () => {}, rewind: () => {}, stop: () => {},
      /** A setting changed: picks up at the same note, rebuilt. */
      retime: () => {},
    };
    /** Typing, another face, another version and the dialog going stop it. */
    const stopTextPlay = (): void => textTransport.stop();
    /** Re-marks where play would start — assigned once abcjs has loaded. */
    let previewText: () => void = () => {};

    // ── The passage (2026-10-15) ──
    // A start and an end, each set at the cursor with a button of its own, as
    // the audio player's region is, and SHARED by the two faces: a flag on
    // the stave, a mark in the text. Clicking only ever moves the cursor; the
    // passage changes through these buttons alone (the user). See
    // services/abcBounds.ts for what a bound is.
    /** Positions in the box's text of the version on screen, null = the
     *  tune's own start or end. Never saved: where you practise today, not
     *  something the score is. */
    let bounds: Bounds = { in: null, out: null };
    /** The text and the version the bounds were placed against — see
     *  syncBounds, which follows an edit made since. */
    let boundsBody = '';
    let boundsIndex = -1;
    /** The note the cursor is on, as a position in the box's text, on either
     *  face: what a bound is set at, and what the other face picks up. Null
     *  is the start. */
    let cursorAt: number | null = null;
    /** Late-bound, once abcjs has loaded: what is "here" needs the notes. */
    let setBoundHere: (side: 'in' | 'out') => void = () => {};
    /** Flags and marks drawn again — late-bound for the same reason. */
    let redrawBounds: () => void = () => {};
    /** The cursor carried onto the face being opened — late-bound too. */
    let shareCursor: (mode: 'sheet' | 'text') => void = () => {};

    const boundsGroup = document.createElement('div');
    boundsGroup.className = 'flex items-center rounded-lg border border-border bg-bg shrink-0';
    const mkBoundBtn = (html: string, cls: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `abc-tool-btn text-xs font-mono font-semibold ${cls}`;
      b.innerHTML = html;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onclick = () => { b.blur(); onClick(); };
      return b;
    };
    const boundInBtn = mkBoundBtn(boundIcon('in'), 'abc-bound-btn-in', t('fileViewer.abc.bounds.setIn'), () => setBoundHere('in'));
    const boundOutBtn = mkBoundBtn(boundIcon('out'), 'abc-bound-btn-out', t('fileViewer.abc.bounds.setOut'), () => setBoundHere('out'));
    const boundClearBtn = mkBoundBtn('✕', 'text-muted hover:text-primary disabled:opacity-30 disabled:cursor-default disabled:hover:text-muted',
      t('fileViewer.abc.bounds.clear'), () => { bounds = { in: null, out: null }; boundsChanged(); });
    // Nothing to clear yet. Not through paintBoundControls, which reads the
    // stave's back button, declared further down.
    boundClearBtn.disabled = true;
    boundsGroup.append(boundInBtn, boundOutBtn, boundClearBtn);
    boundsGroup.dataset.tour = 'abc-bounds';
    transportBar.appendChild(boundsGroup);
    /** Just before the stave starts: from the start of the passage when the
     *  cursor is outside it — late-bound, it needs the timer. */
    let beforeScorePlay: () => void = () => {};

    /** What the controls say: whether there is anything to clear, and where
     *  "back" goes. */
    const paintBoundControls = (): void => {
      boundClearBtn.disabled = bounds.in === null && bounds.out === null;
      const title = t(bounds.in !== null ? 'fileViewer.abc.rewindIn' : 'fileViewer.abc.rewindStart');
      for (const b of [rewindBtn, textRewindBtn]) {
        if (!b) continue;
        b.title = title;
        b.setAttribute('aria-label', title);
      }
    };

    /** After the bounds were set: they now refer to the text on screen. */
    const boundsChanged = (): void => {
      boundsBody = shownBody();
      boundsIndex = currentIndex;
      paintBoundControls();
      redrawBounds();
    };

    // The rest of the row: the key, the speed, the click and the swing, in the
    // app's own language. All of it has been one option away in abcjs since
    // the beginning and none of it was ever asked for.
    const practiceRow = document.createElement('div');
    practiceRow.className = 'flex items-center gap-1.5 flex-wrap';
    practiceRow.dataset.tour = 'abc-practice';
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
      // Capturing: before abcjs's own handler starts the timer from where the
      // cursor stands.
      start?.addEventListener('click', () => beforeScorePlay(), true);
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
      // Back without stopping — which is what abcjs's "restart" used to do
      // before it was made a real stop (above), and what was asked for back
      // (2026-09-25): the tune is left looping and practised against, and
      // reaching for stop then play every time breaks the flow. Ours, in
      // their row: abcjs only ever looks its buttons up by their own classes,
      // so one more `.abcjs-btn` beside them is invisible to it.
      const rewind = document.createElement('button');
      rewind.type = 'button';
      rewind.className = 'abcjs-btn abc-midi-rewind';
      rewind.innerHTML = rewindIcon(15);
      rewind.addEventListener('click', () => rewindScore());
      rewindBtn = rewind;
      paintBoundControls();
      // Play, back, stop, repeat — the audio player's order, with the one
      // control it has no counterpart for next to play. abcjs builds loop /
      // restart / play, so everything moves.
      root.prepend(rewind);
      if (start) root.prepend(start);
      if (reset) rewind.after(reset);
      if (reset && loop) reset.after(loop);
    };

    /** Late-bound, because the things these act on live inside the abcjs
     *  import: the tempo needs the synth, the rest need a re-draw. */
    let applyWarp: (percent: number) => void = () => {};
    /** Stops the sound if any is coming out, leaving the position alone — the
     *  first half of what the stop button does, the rewind being abcjs's own.
     *  Late-bound for the same reason: the controller lives inside the import. */
    let pauseIfPlaying: () => void = () => {};
    /** Another app took the sound (Android app). One function for the whole
     *  dialog, so a release finds the claim it made. */
    const pauseScoreForFocus = (): void => pauseIfPlaying();
    /** Back to the start of the passage — see `rewindScore` where it is
     *  assigned. Late-bound like the two above. */
    let rewindScore: () => void = () => {};
    let rewindBtn: HTMLButtonElement | null = null;

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
    // Opens a dialog of its own, which a walkthrough's veil would cover.
    transposeBtn.dataset.tour = 'abc-transpose';
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
    // Neither is stored from here. The metronome starts off on every score
    // (the user's call): a click is something you put on for a passage you are
    // working out, not a way you like scores to sound — and one that came back
    // by itself on the next tune would be a small annoyance every time. The
    // swing starts where the preferences put it, for the same reason.
    let metronome = false;
    const metronomeChip = mkToggleChip(iconElement(MetronomeIcon, 14), null, t('fileViewer.abc.metronome'), metronome, (on) => {
      metronome = on;
      // The drum is baked into the audio buffer, so it takes a re-prime — which
      // is what a re-draw does.
      redrawScore();
    });

    // abcjs does the work (its `addSwing`); all this chooses is the number.
    const swingBtn = mkSwingButton(swing, (v) => {
      swing = v;
      // Swing is applied when the note map is built, so it needs the buffer
      // rebuilt — same as the metronome.
      redrawScore();
    });
    /** Whether this tune's metre swings at all — see meterCanSwing. */
    const swingApplies = () => meterCanSwing(parseAbcBlock(shownBlock(currentIndex)).meter);
    const updateSwing = () => {
      // GONE, not greyed out, where the metre cannot swing (5/8, 3/2… — see
      // meterCanSwing): the control has nothing to offer there, and a
      // disabled chip is a question the reader has to answer before moving
      // on. It comes back by itself on a version that can.
      swingBtn.style.display = swingApplies() ? '' : 'none';
    };
    updateSwing();

    // Order: what you change while playing first (speed), then the feel, then
    // the key — which is set once for a tune and then left alone.
    practiceRow.append(tempoStepper.group, metronomeChip, swingBtn, transposeBtn);

    // A frame AROUND the score, holding both it and the controls that float
    // over it. The controls cannot sit inside the score itself: that box
    // scrolls, and an absolutely positioned child of a scrolling box scrolls
    // away with the music. The frame does not scroll, so they stay put.
    const scoreFrame = document.createElement('div');
    scoreFrame.className = 'relative w-full';
    scoreFrame.dataset.tour = 'abc-score';
    container.appendChild(scoreFrame);
    // The transport goes UNDER the score, which is why it is not appended where
    // it was built (see TRANSPORT_CLASS) — nor here: under the ABC source as
    // well, so after the box (2026-10-15). One of the two is always hidden.

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
    // `pt-8`: the room the full-page button sits in (scoreTools, `top-1`, a
    // 2rem target whose glyph ends ~27 px down). It used to fall, by accident,
    // in empty bands above the first staff — the hidden tempo mark's, and the
    // drawing shrunk inside a box too tall for it — and landed on the last
    // notes of the first line once both were gone (2026-10-24).
    scoreScroll.className = 'abc-score-paper w-full rounded p-2 pt-8 overflow-y-auto';
    scoreFrame.appendChild(scoreScroll);

    // Full page, in the score's top right corner, over the paper (2026-10-10,
    // the user) — where the way back already was once in full page. One button
    // for both: it belongs to the frame, so it travels into the full-page
    // overlay with the score and turns into the way out there.
    const scoreTools = document.createElement('div');
    scoreTools.className = 'absolute top-1 right-1 z-20 flex items-center';
    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.className = 'abc-score-tool-small rounded transition-colors cursor-pointer flex items-center justify-center';
    fullscreenBtn.title = t('fileViewer.abc.fullscreen');
    fullscreenBtn.setAttribute('aria-label', t('fileViewer.abc.fullscreen'));
    fullscreenBtn.dataset.tour = 'abc-fullscreen';
    fullscreenBtn.appendChild(iconElement(ExpandIcon, 13));
    fullscreenBtn.addEventListener('click', () => fullscreenBtn.blur());
    scoreTools.appendChild(fullscreenBtn);
    scoreFrame.appendChild(scoreTools);

    /** Paper and ink onto the box, and the cursor colour onto the CSS variable
     *  the stylesheet reads. The ink is set on the element too, not only handed
     *  to abcjs: the "format non décodable" text and anything else that lands
     *  in this box has to be readable on the paper it lands on. */
    const applyPaper = () => {
      const { paper: bg, ink, cursor, boundIn, boundOut } = ABC_PAPERS[paper];
      // On the FRAME, so the controls that float over the score inherit them
      // too — they sit on the paper, not on the dialog.
      scoreFrame.style.setProperty('--abc-paper', bg);
      scoreFrame.style.setProperty('--abc-ink', ink);
      scoreFrame.style.setProperty('--abc-cursor', cursor);
      scoreFrame.style.setProperty('--abc-in', boundIn);
      scoreFrame.style.setProperty('--abc-out', boundOut);
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
    onModalExpanded = (expanded) => { modalExpanded = expanded; capScore(); playAlongView?.setExpanded(expanded); };

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

    const wakeLock = screenWakeLock();

    // No page-turn bands here on purpose. The full-page reader had a band down
    // each side that scrolled by a screenful; it was dropped on 2026-09-22
    // because a reader scrolls the score, and two tap targets over the music
    // were read as settings rather than as a page turn.

    // Nothing is built for the full page any more: its way out is the very
    // button that led in (scoreTools), which travels with the frame.

    const exitFullscreen = () => {
      if (!fullscreen) return;
      unregisterFullscreen();
      unregisterFullscreen = () => {};
      wakeLock.release();
      scoreFrame.classList.remove('flex', 'flex-col', 'flex-1', 'min-h-0');
      scoreScroll.classList.remove('flex-1', 'min-h-0');
      scoreScroll.classList.add('rounded');
      scoreAnchor.replaceWith(scoreFrame);
      transportBar.className = TRANSPORT_CLASS;
      transportAnchor.replaceWith(transportBar);
      fullscreen.remove();
      fullscreen = null;
      capScore();
      fullscreenBtn.replaceChildren(iconElement(ExpandIcon, 13));
      fullscreenBtn.title = t('fileViewer.abc.fullscreen');
      fullscreenBtn.setAttribute('aria-label', t('fileViewer.abc.fullscreen'));
      // The box changed width twice over on the way out; the score has to be
      // engraved for the one it ends up in.
      remeasure();
    };

    const enterFullscreen = () => {
      if (fullscreen) return;
      const overlay = document.createElement('div');
      // The paper is the score box's own background, and that box fills the
      // column, so the page still reads as one sheet. What shows of the
      // overlay itself is only the bands under the system bars: the dialog
      // colour there, not the paper — the bars' icons are picked for the theme
      // (native/systemBars.ts), and white ones vanish on a cream sheet.
      overlay.className = 'fixed inset-0 z-[100] flex flex-col safe-area-pad';
      overlay.style.background = 'var(--color-elevated)';

      scoreFrame.replaceWith(scoreAnchor);
      scoreFrame.classList.add('flex', 'flex-col', 'flex-1', 'min-h-0');
      scoreScroll.classList.remove('rounded');
      scoreScroll.classList.add('flex-1', 'min-h-0');
      // Height comes from the flex column now; the modal-relative cap it was
      // wearing would hold the score to half a dialog that is no longer there.
      scoreScroll.style.maxHeight = '';

      // The transport, at the bottom where a thumb is. It keeps its element
      // and its abcjs bindings — only where it sits and what it sits on change.
      transportBar.replaceWith(transportAnchor);
      transportBar.className = 'abc-transport shrink-0 flex items-center justify-center gap-2 flex-wrap px-2 py-2 bg-elevated border-t border-border';

      overlay.append(scoreFrame, transportBar);
      document.body.appendChild(overlay);
      fullscreen = overlay;
      fullscreenBtn.replaceChildren(iconElement(CollapseIcon, 13));
      fullscreenBtn.title = t('fileViewer.abc.fullscreenExit');
      fullscreenBtn.setAttribute('aria-label', t('fileViewer.abc.fullscreenExit'));
      wakeLock.hold();
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
    // ── The source face's player (2026-10-15, a TheSession user editing ABC
    // by ear): the transport under the box plays the text in it — from the
    // caret, or only the selection — and lights each note in the text as it
    // sounds. Nothing is drawn; see abcTextPlayback.ts. On every viewer, the
    // read-only one too: listening is not editing.

    // The box over a layer that marks its text, since a textarea cannot
    // colour part of its own (2026-10-15): where play will start — a bar in
    // the colour of the stave's cursor, which is the same answer to the same
    // question — the passage a selection plays, tinted, and the note sounding.
    // (A dashed line under the passage while looping was tried and dropped,
    // 2026-10-15: it seemed to crawl as the playing note went by.) The layer copies the box's
    // text in the same font, padding and wrapping, transparent; the box is
    // see-through over it, and the layer paints the background.
    const textBox = document.createElement('div');
    textBox.className = 'relative';
    textBox.style.display = 'none';
    const textBackdrop = document.createElement('div');
    textBackdrop.setAttribute('aria-hidden', 'true');
    textBackdrop.className = 'absolute left-0 top-0 font-mono text-xs p-3 border border-transparent rounded-lg bg-bg text-transparent overflow-hidden whitespace-pre-wrap break-words pointer-events-none';

    // ── Raw ABC text of the SELECTED tune only — editable and saved back to
    // the attachment when the caller passed a save callback (card view);
    // read-only otherwise (study).
    const textarea = document.createElement('textarea');
    textarea.className = 'relative block w-full h-72 font-mono text-xs p-3 border border-border rounded-lg bg-transparent text-primary resize-y outline-none focus:border-accent';
    textarea.spellcheck = false;
    textarea.readOnly = !onSave;
    textarea.value = tunes[0] ?? '';
    textBox.append(textBackdrop, textarea);
    container.appendChild(textBox);
    const bottomRow = document.createElement('div');
    bottomRow.className = BOTTOM_ROW_CLASS;
    bottomRow.appendChild(transportBar);
    container.appendChild(bottomRow);
    // The positions marked are positions in the text as it was: a keystroke
    // makes them wrong, so typing stops it.
    textarea.addEventListener('input', () => stopTextPlay());
    textarea.addEventListener('scroll', () => { textBackdrop.scrollTop = textarea.scrollTop; });

    /** The layer at the box's size, less its scrollbar: wrapped at another
     *  width, its lines would not be the box's. Followed as the box is
     *  resized by its handle. */
    const sizeBackdrop = (): void => {
      const cs = getComputedStyle(textarea);
      const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      textBackdrop.style.width = `${textarea.clientWidth + borders}px`;
      textBackdrop.style.height = `${textarea.offsetHeight}px`;
      textBackdrop.scrollTop = textarea.scrollTop;
    };
    const backdropRo = new ResizeObserver(sizeBackdrop);
    backdropRo.observe(textarea);
    const exitBeforeBackdrop = releaseFullscreen;
    releaseFullscreen = () => { exitBeforeBackdrop(); backdropRo.disconnect(); };

    /** What the layer marks, as ranges of the box's text: the cursor's note
     *  (from the caret before play, from the run during it), the notes
     *  sounding, and the passage's first and last notes. */
    let textHints: { start: [number, number] | null } = { start: null };
    let textCurrent: [number, number][] = [];
    let textBoundMarks: { in: [number, number] | null; out: [number, number] | null } = { in: null, out: null };
    /** What abcjs objects to, underlined with a wave — only while the syntax
     *  check is on. Positions in the text as it was last checked: a keystroke
     *  makes them wrong, so typing clears them until the next check. */
    let textWarnMarks: [number, number][] = [];

    /** abcjs ends a note after the spaces that follow it: marked, "A3 " looks
     *  like a note and a gap. */
    const trimNote = (text: string, r: [number, number] | null): [number, number] | null => {
      if (!r) return null;
      let [a, b] = r;
      while (b > a && /\s/.test(text[b - 1]!)) b--;
      return b > a ? [a, b] : null;
    };

    /** Redraws the layer. `follow` brings the note sounding into view when it
     *  has scrolled out of it — never the caret's marks: the reader is
     *  looking at the caret already. */
    const paintText = (follow = false): void => {
      const text = textarea.value;
      const current = textCurrent.map(r => trimNote(text, r)).filter((r): r is [number, number] => !!r);
      // The cursor's bar: on the notes sounding while there are any — it
      // follows the music, as the stave's cursor does (the user, 2026-10-15)
      // — else on the caret's note.
      const caretNote = trimNote(text, textHints.start);
      const cursors = current.length ? current : caretNote ? [caretNote] : [];
      // The passage's start against its first note's left edge, its end
      // against its last note's right edge: it reads as [ … ].
      const markIn = trimNote(text, textBoundMarks.in);
      const markOut = trimNote(text, textBoundMarks.out);
      const cuts = new Set<number>([0, text.length]);
      for (const r of [caretNote, markIn, markOut, ...current, ...textWarnMarks]) if (r) { cuts.add(Math.min(r[0], text.length)); cuts.add(Math.min(r[1], text.length)); }
      const points = [...cuts].sort((a, b) => a - b);
      const parts: Node[] = [];
      for (let i = 0; i + 1 < points.length; i++) {
        const p = points[i]!, q = points[i + 1]!;
        const piece = text.slice(p, q);
        const classes: string[] = [];
        if (cursors.some(r => p === r[0])) classes.push('abc-text-start');
        if (markIn && p === markIn[0]) classes.push('abc-text-in');
        if (markOut && q === markOut[1]) classes.push('abc-text-out');
        if (textWarnMarks.some(([a, b]) => p >= a && q <= b)) classes.push('abc-text-warn');
        const sounding = current.find(([a, b]) => p >= a && q <= b);
        if (sounding) {
          const mark = document.createElement('mark');
          mark.className = ['abc-text-playing', ...classes].join(' ');
          // Where the note is in the text, for whoever needs to know (tests).
          if (p === sounding[0]) mark.dataset['at'] = String(p);
          if (textWarnMarks.some(([a]) => a === p)) mark.dataset['warnAt'] = String(p);
          mark.textContent = piece;
          parts.push(mark);
        } else if (classes.length) {
          const span = document.createElement('span');
          span.className = classes.join(' ');
          // Where a warning's word starts, for the strip to scroll to.
          if (textWarnMarks.some(([a]) => a === p)) span.dataset['warnAt'] = String(p);
          span.textContent = piece;
          parts.push(span);
        } else {
          parts.push(document.createTextNode(piece));
        }
      }
      // A trailing newline collapses in a div and not in a textarea: one more
      // character keeps the last line's height the same in both.
      parts.push(document.createTextNode(' '));
      textBackdrop.replaceChildren(...parts);
      sizeBackdrop();
      const mark = follow ? textBackdrop.querySelector('mark') : null;
      if (mark) {
        const top = mark.offsetTop;
        if (top < textarea.scrollTop || top + mark.offsetHeight > textarea.scrollTop + textarea.clientHeight) {
          textarea.scrollTop = top - textarea.clientHeight / 2;
        }
      }
      textBackdrop.scrollTop = textarea.scrollTop;
    };

    // A warning in the strip, tapped: the caret goes to the start of the word
    // it names, and the box scrolls to show it — read off the layer, which
    // wraps the lines exactly as the box does. A caret, not a selection: a
    // selection is also the passage play is limited to.
    goToWarning = (at: number) => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(at, at);
      const word = textBackdrop.querySelector<HTMLElement>(`[data-warn-at="${at}"]`);
      if (word) {
        const top = word.offsetTop;
        if (top < textarea.scrollTop || top + word.offsetHeight > textarea.scrollTop + textarea.clientHeight) {
          textarea.scrollTop = top - textarea.clientHeight / 2;
        }
        textBackdrop.scrollTop = textarea.scrollTop;
      }
    };

    /** The notes sounding, or none. */
    const lightText = (ranges: [number, number][]): void => {
      textCurrent = ranges;
      paintText(ranges.length > 0);
    };
    /** Where play starts. */
    const setTextHints = (hints: typeof textHints): void => {
      textHints = hints;
      paintText();
    };

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

    // ── Adding / deleting a version ───────────────────────────────────────────
    // On the bottom row rather than beside the version nav: these two write to
    // the file, like Save and unlike the nav. Shown on the source face only,
    // and only when the caller passed a save callback.
    const versionEdit = document.createElement('div');
    versionEdit.className = 'abc-bottom-start flex items-center gap-1 p-1 bg-bg rounded-lg w-fit';
    versionEdit.style.display = 'none';
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
    // Against the right edge; `min-w-0` lets the status text wrap inside it
    // rather than pushing Save off the row.
    saveGroup.className = 'abc-bottom-end flex items-center gap-2 min-w-0 justify-end';
    saveGroup.style.display = 'none';
    const saveStatus = document.createElement('span');
    saveStatus.className = 'text-xs text-dim';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary text-xs';
    saveBtn.textContent = t('fileViewer.abc.save');
    saveBtn.disabled = true;
    saveGroup.append(saveStatus, saveBtn);
    bottomRow.prepend(versionEdit);
    bottomRow.appendChild(saveGroup);

    /** One line or two: the transport keeps its natural width in the middle
     *  and each side gets the room of the wider one, so it stays centred —
     *  the whole has to fit, or the transport goes up a line of its own. Read
     *  off the pieces' natural widths, never off the layout they are in, so
     *  switching does not change the answer and cannot flicker. */
    const layoutBottomRow = (): void => {
      const gap = parseFloat(getComputedStyle(bottomRow).columnGap) || 0;
      const sideW = (el: HTMLElement) => (el.style.display === 'none' ? 0 : el.scrollWidth);
      const side = Math.max(sideW(versionEdit), sideW(saveGroup));
      const prev = transportBar.style.width;
      transportBar.style.width = 'max-content';
      const middle = transportBar.offsetWidth;
      transportBar.style.width = prev;
      const need = middle + (side > 0 ? 2 * (side + gap) : 0);
      bottomRow.classList.toggle('abc-bottom-stacked', need > bottomRow.clientWidth);
    };
    let bottomRaf = 0;
    const bottomRo = new ResizeObserver(() => {
      cancelAnimationFrame(bottomRaf);
      bottomRaf = requestAnimationFrame(layoutBottomRow);
    });
    // The row's width, and what decides the pieces' own: a chip showing up, a
    // value growing, a "Saved." beside Save.
    for (const el of [bottomRow, versionEdit, saveGroup, practiceRow]) bottomRo.observe(el);
    // Taken down with the dialog — on the hook assigned once, above, rather
    // than releaseKeys, which the abcjs branch reassigns.
    const exitFullscreenFirst = releaseFullscreen;
    releaseFullscreen = () => { exitFullscreenFirst(); cancelAnimationFrame(bottomRaf); bottomRo.disconnect(); };

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

    /** The current version's unsaved edit, on either face — see `draft`. */
    const pendingBody = (): string | null =>
      draft && draft.index === currentIndex ? draft.body : null;

    /** The text of the version on screen, on either face: its edit, if any. */
    const shownBody = (): string => pendingBody() ?? currentBody();

    /** The bounds and the cursor brought up to the text on screen: moved
     *  along by an edit made since they were placed, dropped with the note
     *  they named, and gone with the version they were placed in. Called
     *  before every reading of them, so no path that changes the text —
     *  typing, a draft thrown away, a save — has to remember to. */
    const syncBounds = (): void => {
      const body = shownBody();
      if (boundsIndex === currentIndex && boundsBody === body) return;
      const before = { ...bounds };
      if (boundsIndex !== currentIndex) {
        bounds = { in: null, out: null };
        cursorAt = null;
      } else {
        const shift = (x: number | null) => (x === null ? null : shiftPosition(x, boundsBody, body));
        bounds = { in: shift(bounds.in), out: shift(bounds.out) };
        cursorAt = shift(cursorAt);
      }
      boundsBody = body;
      boundsIndex = currentIndex;
      if (before.in !== bounds.in || before.out !== bounds.out) paintBoundControls();
    };

    /** The ● on the ABC tab: the stave may be showing an edit, and nothing
     *  else on that face would say so. */
    const markDraft = (): void => {
      textTabBtn.replaceChildren(document.createTextNode(t('fileViewer.abc.textTab')));
      textTabBtn.title = '';
      if (!draft) return;
      const dot = document.createElement('span');
      dot.className = 'text-warn ml-1';
      dot.textContent = '●';
      textTabBtn.appendChild(dot);
      textTabBtn.title = t('unsaved.title');
    };

    // Assigned by the editable branch below; a viewer without onSave has
    // nothing to save and so never a draft to ask about.
    let saveDraft: () => Promise<boolean> = async () => false;

    /** Runs `proceed` once no edit is pending: straight away when there is
     *  none, otherwise after asking whether to save it, drop it or stay. */
    function settleDraft(proceed: () => void): void {
      if (!draft) { proceed(); return; }
      askUnsavedChanges({
        message: t('unsaved.message.text'),
        save: () => saveDraft(),
        discard: () => {
          draft = null;
          markDraft();
          saveBtn.disabled = true;
          // The stave was drawing the edit: stale now. Whatever proceeds next
          // redraws it straight away when it is on screen, or the dialog is
          // going away.
          sheetNeedsRerender = true;
          if (currentMode === 'text') { textarea.value = currentBody(); checkWarnings(); }
        },
        proceed,
      });
    }
    // Read-only viewers never have a draft, so this holds nothing for them.
    guardClose = (dismiss) => {
      if (!draft) return false;
      settleDraft(dismiss);
      return true;
    };

    function goToVersion(index: number): void {
      stopTextPlay();
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
      versionChangedForPlayAlong();
      if (currentMode === 'sheet') {
        doRenderTune?.(currentIndex);
      } else {
        textarea.value = pendingBody() ?? currentBody();
        saveBtn.disabled = pendingBody() === null;
        saveStatus.textContent = '';
        checkWarnings();
      }
    }

    function paintTabs(mode: 'sheet' | 'text'): void {
      const active = 'bg-accent text-white';
      const inactive = 'text-muted hover:text-primary hover:bg-elevated';
      const tabBase = 'px-3 min-h-[2.25rem] text-xs font-medium rounded transition-colors cursor-pointer';
      sheetTabBtn.className = `${tabBase} ${mode === 'sheet' ? active : inactive}`;
      textTabBtn.className  = `${tabBase} ${mode === 'text'  ? active : inactive}`;
    }

    function setAbcMode(mode: 'sheet' | 'text'): void {
      currentMode = mode;
      paintTabs(mode);
      // Sheet + synth toolbar fully hidden in text mode, not just visually behind
      // it — inline style.display, not just the 'hidden' class: abcjs's own
      // resize handling can otherwise leave the notation SVG visibly reflowing.
      // Both faces have the transport now; each its own buttons, the practice
      // row shared.
      transportBar.style.display = 'flex';
      controls.style.display = mode === 'sheet' ? '' : 'none';
      textControls.style.display = mode === 'text' ? '' : 'none';
      // The frame, not the score inside it: the reading tools act on the
      // picture and would otherwise stay hanging over the ABC source.
      scoreFrame.style.display = mode === 'sheet' ? '' : 'none';
      // Full page acts on a drawing nobody is looking at while the source is on
      // screen. The link to abcTools is not one of them: it hands the TUNE
      // over, whichever face you were reading.
      fullscreenBtn.style.display = mode === 'sheet' ? '' : 'none';
      textBox.style.display = mode === 'text' ? '' : 'none';
      // The warnings are the source face's alone (2026-10-19).
      if (mode !== 'text') { stopTextPlay(); showWarnings([]); }
      else previewText();

      if (onSave) {
        versionEdit.style.display = mode === 'text' ? '' : 'none';
        saveGroup.style.display = mode === 'text' ? '' : 'none';
      }
      layoutBottomRow();
      // Before a redraw, which then places it once primed.
      if (mode === 'sheet') shareCursor('sheet');
      if (mode === 'sheet' && sheetNeedsRerender) {
        sheetNeedsRerender = false;
        doRenderTune?.(currentIndex);
      }
      if (mode === 'text') {
        textarea.value = pendingBody() ?? currentBody();
        saveBtn.disabled = pendingBody() === null;
        saveStatus.textContent = '';
        shareCursor('text');
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
        let result: PreviewSaveResult;
        try {
          result = await onSave!(arrayBufferToBase64(new TextEncoder().encode(nextText).buffer));
        } catch (e) {
          // Not written (a full device, typically): say so where the edit is,
          // keep the editor as it is, and do not pretend it was saved.
          console.warn('[viewer] save failed', e);
          saveStatus.textContent = t('fileViewer.saveFailed');
          return false;
        }
        if (result === false) return false;
        tunes = nextTunes;
        abcText = nextText;
        versionCount = tunes.length;
        // Every writer folds the edit in (or deletes its version), so once the
        // file is written there is nothing pending any more.
        draft = null;
        markDraft();
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
        const body = textarea.value;
        draft = body === currentBody() ? null : { index: currentIndex, body };
        markDraft();
        saveBtn.disabled = draft === null;
        saveStatus.textContent = '';
        // The stave is drawn from the draft, so it is stale from now on.
        sheetNeedsRerender = true;
      });

      saveDraft = async () => {
        if (!draft) return true;
        const nextTunes = [...tunes];
        nextTunes[draft.index] = withXLine(draft.index, draft.body);
        saveBtn.disabled = true;
        if (!await persist(nextTunes, currentIndex)) {
          saveBtn.disabled = pendingBody() === null;
          return false;
        }
        saveStatus.textContent = t('fileViewer.abc.saved');
        return true;
      };
      saveBtn.onclick = () => { void saveDraft(); };

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

      // ── The notes, for the passage and the cursor ─────────────────────────
      // The version on screen as abcjs reads it, parsed — never engraved —
      // once per text. Both faces read it: the stave's source and the box's
      // are the same text (abcTextPlayback's playableSource), so a position in
      // one is a position in the other.
      let readKey: string | null = null;
      let readCache: { ps: PlayableSource; notes: ParsedNote[] } | null = null;
      const readShown = (): { ps: PlayableSource; notes: ParsedNote[] } => {
        syncBounds();
        const xLine = splitXLine(tunes[currentIndex] ?? '').xLine;
        const body = shownBody();
        const key = `${xLine}\n${body}`;
        if (key !== readKey || !readCache) {
          readKey = key;
          const ps = playableSource(xLine, body);
          let notes: ParsedNote[] = [];
          try { notes = notesOf(abcjs.parseOnly(ps.source)[0]); } catch { /* text abcjs cannot read: no notes */ }
          readCache = { ps, notes };
        }
        return readCache;
      };
      /** The passage, as a range of the source — or null, without bounds. */
      const shownRegion = () => {
        const { ps, notes } = readShown();
        const at = (x: number | null) => (x === null ? null : sourceIndex(ps, x));
        return regionOf(notes, at(bounds.in), at(bounds.out));
      };
      /** Where a note of the source is in the box, for the shared cursor. */
      const boxPosition = (srcChar: number | undefined): number | null =>
        (typeof srcChar === 'number' ? bodyIndex(readShown().ps, srcChar) : null);

      /** Every time a note is played, as the controller's timer has it: one
       *  event per pass round the repeats, in time order. The timer is the
       *  time base a seek is measured in at the CURRENT speed, and knows where
       *  the note sits on the page. Empty until a tune is primed. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const passesOf = (startChar: number): any[] => {
        const timings = synthControl?.timer?.noteTimings;
        if (!Array.isArray(timings)) return [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return timings.filter((ev: any) => ev.type === 'event' && ev.left != null
          && Array.isArray(ev.startCharArray) && ev.startCharArray.includes(startChar));
      };

      // ── The passage on the stave ──────────────────────────────────────────
      /** The furthest character played inside the passage — see resumeInside,
       *  the same rule as the source face's. */
      let scorePlayedTo = -1;
      const scoreTimings = (): TimingEvent[] => {
        const timings = synthControl?.timer?.noteTimings;
        return Array.isArray(timings) ? timings as TimingEvent[] : [];
      };
      /** The first note of the passage in time, or null for an empty one. */
      const scoreRegionStart = (region: { from: number; to: number }): TimingEvent | null =>
        playPlan(scoreTimings(), region.from, region.to)?.start ?? null;
      /** To a note — a hair before it, an exact seek landing on the next. */
      const seekScoreTo = (ev: TimingEvent) => {
        try { synthControl.seek(Math.max(0, ev.milliseconds - SEEK_BACKOFF_MS) / 1000, 'seconds'); }
        catch { /* not primed yet */ }
      };

      /** Keeps a playing stave inside the passage. Called on every note, before
       *  it is shown: true when the note was outside and the music was sent
       *  elsewhere — on to the passage, back to its start, or to a stop there
       *  without the loop. The timer allows a seek from inside its callback
       *  (abc_timing_callbacks' doTiming re-reads its clock after one). */
      const keepInRegion = (ev: TimingEvent): boolean => {
        if (!synthControl?.isStarted || !isNote(ev)) return false;
        const region = shownRegion();
        if (!region) return false;
        if (touches(ev, region.from, region.to)) {
          scorePlayedTo = Math.max(scorePlayedTo, ...ev.startCharArray);
          return false;
        }
        const next = resumeInside(scoreTimings(), ev.milliseconds, scorePlayedTo, region.from, region.to);
        if (next) { seekScoreTo(next); return true; }
        const start = scoreRegionStart(region);
        scorePlayedTo = -1;
        if (!looping) pauseIfPlaying();
        if (start) seekScoreTo(start);
        return true;
      };

      /** One bound's flag: a dashed pole down the staff and a pennant at its
       *  top, kept INSIDE the staff's extent — the score's viewBox is cropped
       *  to its ink (cropToInk), and anything above the first staff would be
       *  cut. The start's stands before its note and points on into the
       *  passage, the end's after its note and points back: [ … ]. Only the
       *  pennant takes a click, which takes the bound away: the pole crosses
       *  the note it marks, and must not steal the tap on it. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const boundFlag = (ev: any, side: 'in' | 'out'): SVGGElement => {
        const NS = 'http://www.w3.org/2000/svg';
        const x = side === 'in' ? ev.left - 4 : ev.left + (ev.width ?? 8) + 3;
        const top = ev.top as number;
        const dir = side === 'in' ? 1 : -1;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', `abc-bound abc-bound-${side}`);
        const pole = document.createElementNS(NS, 'line');
        pole.setAttribute('x1', String(x)); pole.setAttribute('x2', String(x));
        pole.setAttribute('y1', String(top)); pole.setAttribute('y2', String(top + ev.height));
        g.appendChild(pole);
        const flag = document.createElementNS(NS, 'g');
        flag.setAttribute('class', 'abc-bound-flag');
        const pennant = document.createElementNS(NS, 'polygon');
        pennant.setAttribute('points', `${x},${top} ${x + 9 * dir},${top + 4} ${x},${top + 8}`);
        // Bigger than the pennant, so a finger can find it.
        const hit = document.createElementNS(NS, 'rect');
        hit.setAttribute('class', 'abc-bound-hit');
        hit.setAttribute('x', String(side === 'in' ? x - 4 : x - 12)); hit.setAttribute('y', String(top - 2));
        hit.setAttribute('width', '16'); hit.setAttribute('height', '14');
        const title = document.createElementNS(NS, 'title');
        title.textContent = t(side === 'in' ? 'fileViewer.abc.bounds.removeIn' : 'fileViewer.abc.bounds.removeOut');
        flag.append(pennant, hit, title);
        // abcjs reads its clicks off the whole <svg>, on mousedown and
        // touchstart, and snaps any press to the nearest note within 12 px.
        // Stopped here, below the <svg>, abcjs never hears of it.
        const swallow = (e: Event) => e.stopPropagation();
        flag.addEventListener('mousedown', swallow);
        flag.addEventListener('touchstart', swallow, { passive: true });
        flag.addEventListener('click', (e) => {
          e.stopPropagation();
          bounds = { ...bounds, [side]: null };
          boundsChanged();
        });
        g.appendChild(flag);
        return g;
      };

      /** The two flags put on the page, where there are bounds — none for a
       *  missing one, which is the tune's own start or end. On the first time
       *  round: the page draws a repeated bar once. */
      const drawBoundFlags = () => {
        const svg = notation.querySelector('svg');
        svg?.querySelectorAll('.abc-bound').forEach(el => el.remove());
        if (!svg) return;
        const region = shownRegion();
        if (!region) return;
        if (region.first) { const ev = passesOf(region.first.start)[0]; if (ev) svg.appendChild(boundFlag(ev, 'in')); }
        if (region.last) { const ev = passesOf(region.last.start)[0]; if (ev) svg.appendChild(boundFlag(ev, 'out')); }
      };

      /** Back to the start of the passage — the tune's, without one — playing
       *  or not, and without stopping. */
      rewindScore = () => {
        if (!synthControl?.timer) return; // nothing primed: already at the start
        const region = shownRegion();
        const start = region ? scoreRegionStart(region) : null;
        scorePlayedTo = -1;
        if (start) seekScoreTo(start);
        else try { synthControl.seek(0, 'seconds'); } catch { /* not primed yet */ }
      };

      /** The note the stave's cursor last stood on, null at the start. */
      let scoreAt: TimingEvent | null = null;
      // Played from where the cursor is when it is inside the passage, else
      // from its start — sought BEFORE the music starts: left to keepInRegion,
      // the first note outside it would sound for a moment first.
      beforeScorePlay = () => {
        if (!synthControl?.timer || synthControl.isStarted) return;
        const region = shownRegion();
        if (!region) return;
        if (scoreAt && isNote(scoreAt) && touches(scoreAt, region.from, region.to)) return;
        const start = scoreRegionStart(region);
        scorePlayedTo = -1;
        if (start) seekScoreTo(start);
      };

      /** The shared cursor put on the stave, coming from the source face — not
       *  while it plays, which has a place of its own. Waits for the tune to
       *  be primed when it is not yet. */
      let cursorPending = false;
      /** True for the length of a `setTune` call. abcjs starts it by rewinding
       *  the OLD timer (`restart()` → `timer.setProgress(0)`), which reports
       *  the first note to `onEvent` synchronously — and `onEvent` would take
       *  that for the reader's place, overwriting `cursorAt` just before
       *  `onReady` puts the cursor back from it. Reported 2026-10-23: type in
       *  the ABC, go back to the score, and the cursor was on the first note. */
      let rebinding = false;
      const placeScoreCursor = () => {
        cursorPending = false;
        if (cursorAt === null || synthControl?.isStarted) return;
        const { ps, notes } = readShown();
        const note = boundNote(notes, sourceIndex(ps, cursorAt), 'in');
        const ev = note ? passesOf(note.start)[0] : null;
        if (!ev) { cursorPending = !synthControl?.timer; return; }
        scorePlayedTo = -1;
        seekScoreTo(ev);
      };

      /** Move the cursor to this note.
       *
       *  When the note is played is read off the controller's timer: one event
       *  per time round, in the time base both the cursor and the audio are
       *  sought in. NOT the stamp the MIDI flattener leaves on the element
       *  (`currentTrackMilliseconds`), which this used to read: that stamp is
       *  always at the WRITTEN tempo — the speed stepper warps the timer and
       *  the audio, never the flattener — so away from 100 % a click landed
       *  that much too far (measured 2026-09-29: the fifth note of a reel at
       *  150 % is at 800 ms, its stamp says 1200).
       *
       *  A note inside a `:|` repeat has one event per pass, and taking the
       *  first sent every click on a repeated bar back to the first time round
       *  (reported 2026-09-21). The pass nearest where the tune is NOW is the
       *  one meant: clicking a bar during the second time through means that
       *  bar, this time round. Stopped at the start, that is the first pass.
       *
       *  The cursor only: the passage changes through its own buttons alone
       *  (the user, 2026-10-15) — this used to set a bookmark too. */
      const seekToNote = (startChar: number) => {
        if (!synthControl) return;
        const passes = passesOf(startChar);
        if (passes.length === 0) return; // not primed yet: nothing to seek in
        // `percent` and the timer's own length, both warped alike — the
        // position as a fraction is the one reading that does not care what
        // speed it was taken at.
        const nowMs = (synthControl.percent ?? 0) * (synthControl.timer?.lastMoment ?? 0);
        const pass = passes.reduce((best: number, cur: { milliseconds: number }, i: number) =>
          (Math.abs(cur.milliseconds - nowMs) < Math.abs(passes[best]!.milliseconds - nowMs) ? i : best), 0);
        scorePlayedTo = -1;
        // Land just BEFORE the note, never exactly on it. abcjs picks the
        // current event with a strict `milliseconds < currentTime`, and a seek
        // goes out in seconds and comes back in milliseconds — when the round
        // trip leaves it a hair higher, an exact seek steps past the note and
        // selects the next one. A few milliseconds is far below the shortest
        // note in this music (a sixteenth in a fast reel is about 80 ms).
        seekScoreTo(passes[pass]!);
      };

      /** The note a tap at this point means, as its `startChar` — or null for
       *  a tap on nothing.
       *
       *  Found here rather than by abcjs's `clickListener`, which is what this
       *  used to be, because on a phone that listener almost never fired
       *  (reported 2026-09-29). Three reasons, all in selection.js: it only
       *  accepted a press ON the ink, and a fingertip lands on blank staff or
       *  on a staff line far more often than on a six-pixel note head; its
       *  own fallback for a near miss reads `layerX`, which for a touch it
       *  sets to `pageX` — the page, not the score; and it scales by
       *  `clientWidth`, a layout size, against a pointer position in window
       *  pixels, which the app's zoom (80 % on a phone) sets 20 % apart.
       *
       *  Everything here is in ONE space: the tap's `clientX/Y` and each
       *  note's `getBoundingClientRect`, both window pixels, whatever the
       *  zoom. The system tapped is the one whose notes span the tap
       *  vertically (with a margin, for a tap above or below the staff); in
       *  it, the note nearest across wins, if it is close enough to mean it —
       *  a tap in empty space must not jump the playhead. */
      const noteAt = (x: number, y: number): number | null => {
        const timings = synthControl?.timer?.noteTimings;
        if (!Array.isArray(timings)) return null;
        // One box per note (the passes of a repeat share one), grouped by
        // the system it is drawn on.
        const seen = new Set<number>();
        const notes: { startChar: number; line: number; box: DOMRect }[] = [];
        for (const ev of timings) {
          // "A sounding note", as the library's own example has it: no MIDI
          // pitches, nothing to play from — rests, and ties' second halves.
          if (ev.type !== 'event' || ev.left == null || !ev.midiPitches?.length) continue;
          const startChar = ev.startCharArray?.[0];
          if (typeof startChar !== 'number' || seen.has(startChar)) continue;
          seen.add(startChar);
          const el = ev.elements?.[0]?.[0] as Element | undefined;
          if (!el?.getBoundingClientRect) continue;
          notes.push({ startChar, line: ev.line ?? 0, box: el.getBoundingClientRect() });
        }
        const bands = new Map<number, { top: number; bottom: number }>();
        for (const n of notes) {
          const b = bands.get(n.line);
          if (!b) bands.set(n.line, { top: n.box.top, bottom: n.box.bottom });
          else { b.top = Math.min(b.top, n.box.top); b.bottom = Math.max(b.bottom, n.box.bottom); }
        }
        let best: number | null = null;
        let bestDx = TAP_REACH_PX;
        for (const n of notes) {
          const band = bands.get(n.line)!;
          if (y < band.top - TAP_REACH_PX || y > band.bottom + TAP_REACH_PX) continue;
          const dx = x < n.box.left ? n.box.left - x : x > n.box.right ? x - n.box.right : 0;
          if (dx <= bestDx) { bestDx = dx; best = n.startChar; }
        }
        return best;
      };

      // A TAP, not a click: pressed and released without travelling. A finger
      // scrolling the score is a press too, and the browser says so with a
      // `pointercancel` when it takes the gesture over for the scroll.
      let pressAt: { x: number; y: number } | null = null;
      notation.addEventListener('pointerdown', (e) => {
        pressAt = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      });
      notation.addEventListener('pointercancel', () => { pressAt = null; });
      const onScoreTap = (e: PointerEvent) => {
        const from = pressAt;
        pressAt = null;
        if (!from || !e.isPrimary) return;
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > TAP_SLOP_PX) return;
        // A bound's flag has a click of its own: it removes the bound.
        if ((e.target as Element | null)?.closest?.('.abc-bound')) return;
        const startChar = noteAt(e.clientX, e.clientY);
        if (startChar === null) return;
        // Read before the seek, which does not start anything but is the
        // last word on where the tune stands.
        const playing = !!synthControl?.isStarted;
        seekToNote(startChar);
        // Heard only while the music is stopped: playing, the tap already
        // means "from here", and the tune goes on from that very note.
        if (!playing && tapPlaysNote(appState.value)) {
          const ev = passesOf(startChar)[0];
          const visual = synthControl?.visualObj;
          if (!ev?.midiPitches?.length || !visual) return;
          // One event holds every voice sounding at that moment; the note
          // tapped is the one written at this place.
          const pitches = (ev.midiPitches as (MidiPitch & { startChar?: number })[])
            .filter(p => p.startChar === undefined || p.startChar === startChar);
          unlockAbcjsAudio();
          playTap(abcjs, tapTracks(pitches, ev.midiGraceNotePitches, secondsPerWhole(visual, tempoPercent), selectedProgram));
        }
      };
      notation.addEventListener('pointerup', onScoreTap);

      const cursorControl = {
        beatSubdivisions: 2,
        // After every priming — a new tune, and each speed change, which
        // rebuilds the timer the flags are read from.
        onReady: () => {
          drawBoundFlags();
          if (cursorPending) placeScoreCursor();
        },
        onStart: () => {
          lastCursorTop = null;
          ensureCursor();
          claimAudioFocus(pauseScoreForFocus);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onEvent: (ev: any) => {
          // The old timer being rewound by setTune, not the music moving.
          if (rebinding) return;
          if (ev.measureStart && ev.left === null) return; // 2nd half of a tie across a measure line
          // Sent elsewhere: the note it was sent to comes through here too.
          if (keepInRegion(ev as TimingEvent)) return;
          scoreAt = ev as TimingEvent;
          const at = boxPosition(ev.startCharArray?.[0]);
          if (at !== null) cursorAt = at;
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
          // Back at the start, which is where the cursor now is.
          cursorAt = null;
          scoreAt = null;
          scorePlayedTo = -1;
          notation.querySelectorAll('.abcjs-highlight').forEach(el => el.classList.remove('abcjs-highlight'));
          const cursor = notation.querySelector('.abcjs-cursor');
          cursor?.setAttribute('x1', '0'); cursor?.setAttribute('x2', '0');
          cursor?.setAttribute('y1', '0'); cursor?.setAttribute('y2', '0');
        },
      };

      /** Every rebuild of the synth — a new tune, a new speed — one after the
       *  other. Each is a teardown and a rebuild of the same controller, and
       *  two interleaved leave it holding the pieces of both (see applyWarp).
       *  A failed step does not block the ones behind it. */
      let synthQueue: Promise<unknown> = Promise.resolve();
      const enqueueSynth = (step: () => Promise<unknown> | undefined): Promise<unknown> => {
        synthQueue = synthQueue.then(step).catch(() => {});
        return synthQueue;
      };

      /** Where the stave was, and whether it was playing, before a run of
       *  redraws that has not yet put it back — see redrawPreservingPlayback.
       *  A stop asked for in the meantime is a stop: it clears `wasPlaying`. */
      let pendingRestore: { wasPlaying: boolean; at: number } | null = null;

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

      const engraveWidth = (): number => engraveWidthOf(scoreScroll);

      const scoreMeasure: { measure: ScoreMeasure | null } = { measure: null };
      const renderTune = (index: number) => {
        const ink = ABC_PAPERS[paper].ink;
        const source = injectDefaultTempo(stripForRender(shownBlock(index)));
        lastEngravedWidth = engraveWidth();
        const visualObj = engraveScore(abcjs, notation.id, source, {
          ...engraveOptions({ width: lastEngravedWidth, ink, transpose }),
          // abcjs listens for clicks on every score it draws, whatever it is
          // given, and paints the note it thinks was clicked as "selected" —
          // which it only repaints on the NEXT click, so a clicked note stayed
          // coloured beside the cursor's. The click is handled by our own tap
          // (see onScoreTap); this is only how abcjs is asked to keep quiet,
          // in the paper's own ink so it does not turn black on a dark page.
          // `dragging` is left off: abcjs's note-dragging would edit pitches.
          selectionColor: ink,
        }, scoreMeasure);

        // abcjs's warnings about this drawing are not shown here any more: they
        // belong to the ABC face, under the text they name (2026-10-19) — see
        // `checkWarnings`.

        // After the drawing, before anything reads its height: pulls the music
        // up to where its own ink starts. See cropToInk.
        cropToInk(notation);
        // The metre can change from one version of a file to the next, and it
        // is the metre that decides whether the swing does anything at all.
        updateSwing();

        if (visualObj && visualObj.length > 0) {
          if (!synthControl) {
            synthControl = new abcjs.synth.SynthController();
            // `go()` prepares the sound, and the tune is handed over with
            // userAction=true, so it runs as soon as the score is drawn — out
            // of any tap, where Safari refuses to start audio. abcjs then left
            // `isLoading` set for good, and its play button waited on it
            // forever (runWhenReady sleeps while it is set). Cleared on
            // failure, the next press prepares it again, from inside the tap.
            // abcjs calls `self.go()`, so replacing the property is enough.
            const go = synthControl.go.bind(synthControl);
            synthControl.go = () => go().catch((err: unknown) => { synthControl.isLoading = false; throw err; });
            stopAudio = () => {
              if (pendingRestore) pendingRestore.wasPlaying = false;
              try { synthControl.pause(); } catch { /* ignore */ }
              releaseAudioFocus(pauseScoreForFocus);
            };
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
            // The stave's loop button sets the shared loop: abcjs has toggled
            // its own by the time this runs (its listener came first).
            controls.querySelector('.abcjs-midi-loop')?.addEventListener('click', () => setLooping(!!synthControl?.isLooping));
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
            if (pendingRestore) pendingRestore.wasPlaying = false;
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
          // The app's volume, read at every preparation (playbackVolume.ts).
          audioParams.soundFontVolumeMultiplier = abcjsVolumeMultiplier();
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
            const meter = parseAbcBlock(shownBlock(index)).meter;
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
          // abcjs's `swing` in a reel, our own note-map pass in a jig — see
          // swingAudioParams. Both read the metre and the pickup from abcjs's
          // own parse, the one the notes are timed from.
          if (swing !== NO_SWING && swingApplies()) {
            Object.assign(audioParams, swingAudioParams(swing, visualObj[0]!.getMeterFraction(), visualObj[0]!.getPickupLength()));
          }
          // The rewind that reports the first note runs inside the call itself,
          // before `go()` — so the flag only has to cover the call, not the
          // promise it returns. See `rebinding`.
          const rebind = (): Promise<unknown> => {
            rebinding = true;
            try { return synthControl.setTune(visualObj[0]!, true, audioParams); }
            finally { rebinding = false; }
          };
          void enqueueSynth(() => rebind().then(() => {
            // After setTune, never before: warping rebuilds the audio buffer,
            // so it needs a tune to rebuild from. Skipped when the controller
            // is already at that speed — it keeps its warp from one tune to
            // the next, and `setTune` builds at it — since it would throw away
            // and re-render the buffer to arrive where it already is.
            //
            // AWAITED, which it was not: the step ended while the rebuild was
            // still running, and the step behind it (a redraw putting the tune
            // back where it was) raced it.
            if (synthControl.warp !== tempoPercent) return synthControl.setWarp(tempoPercent);
            return undefined;
          }).catch(() => {
            // Preparing the sound was refused: Safari, outside a tap (see the
            // `go` wrapper above). It is prepared again at the first press,
            // at whatever speed `warp` says then, so the speed is set here by
            // hand, and the loop below still goes on.
            synthControl.warp = tempoPercent;
          }).then(() => {
            // Looping on by default — a score is opened to be practised
            // against, and reaching for the button on every pass is friction.
            // `setTune` resets isLooping to false, so this belongs here, after
            // every re-prime, and the check keeps it idempotent.
            if (synthControl.isLooping !== looping) {
              try { synthControl.toggleLoop(); } catch { /* ignore */ }
            }
            warmAudioOutput();
          }).catch(() => {}));
        }
      };

      doRenderTune = renderTune;

      // ── The source face's player ──────────────────────────────────────────
      // A synth and a timer of its own, built the way SynthController.go()
      // builds the stave's (synth-controller.js), with the shared settings —
      // speed, click, swing, key, instrument, volume — but from the box's text,
      // engraved off screen (renderAbc's "*" target: a hidden div, drawn and
      // removed), since the timing of each note is only known once abcjs has
      // laid the tune out. Built at each start: the text may have changed.
      interface TextRun {
        id: number;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        synth: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        timer: any;
        ps: PlayableSource;
        timings: TimingEvent[];
        /** The furthest character played inside the passage — see
         *  resumeInside. */
        playedTo: number;
        /** The note sounding, for picking up there after a rebuild. */
        last: TimingEvent | null;
        /** The cursor it was started from — see caretMoved. */
        caret: string;
      }
      let textRun: TextRun | null = null;
      /** Bumped by every start and every stop, so a preparation that comes
       *  back after either is dropped rather than started. */
      let textRunId = 0;
      let textState: TextPlayState = 'idle';
      /** Another app took the sound (Android app): as the pause button does. */
      const pauseTextForFocus = (): void => { if (textState === 'playing') textTransport.playPause(); };
      const setTextState = (state: TextPlayState) => {
        textState = state;
        paintTextPlay(state);
        if (state === 'playing') claimAudioFocus(pauseTextForFocus);
        else if (state === 'idle') releaseAudioFocus(pauseTextForFocus);
      };

      /** The run moved to a note — a hair before it: an exact seek lands on
       *  the one after (see SEEK_BACKOFF_MS). `rearm` restarts the timer's own
       *  loop, which has ended once the tune is played out. */
      const seekText = (run: TextRun, ev: TimingEvent, rearm = false) => {
        const at = Math.max(0, ev.milliseconds - SEEK_BACKOFF_MS) / 1000;
        if (textState === 'paused') {
          run.synth.seek(at, 'seconds');
          run.timer.setProgress(at, 'seconds');
          return;
        }
        // Stopped, sought, started: abcjs's own seek restarts the sound only
        // while it thinks it is running, which it may no longer think at the
        // end of the buffer.
        try { run.synth.stop(); } catch { /* not started */ }
        run.synth.seek(at, 'seconds');
        run.synth.start();
        if (rearm) { run.timer.reset(); run.timer.start(at, 'seconds'); } else run.timer.setProgress(at, 'seconds');
      };

      /** The passage, read again at each use — the bounds may move while it
       *  plays — or the whole tune without one. */
      const textRegion = (): { from: number; to: number } => shownRegion() ?? { from: 0, to: Infinity };
      /** The first note of the passage in time. */
      const textRegionStart = (run: TextRun): TimingEvent | null => {
        const region = textRegion();
        return playPlan(run.timings, region.from, region.to)?.start ?? null;
      };

      /** The end of the passage: round again with the loop, else stop. */
      const endTextRun = (run: TextRun, rearm: boolean) => {
        if (!looping) { stopTextPlay(); return; }
        run.playedTo = -1;
        const start = textRegionStart(run);
        if (start) seekText(run, start, rearm);
        else stopTextPlay();
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onTextEvent = (run: TextRun, ev: any): 'continue' | undefined => {
        if (run.id !== textRunId) return undefined;
        if (!ev) {
          // Played out. "continue" keeps the timer from stopping itself over
          // the restart (abc_timing_callbacks' shouldStop).
          endTextRun(run, true);
          return looping ? 'continue' : undefined;
        }
        const tev = ev as TimingEvent;
        const region = textRegion();
        if (isNote(tev) && !touches(tev, region.from, region.to)) {
          const next = resumeInside(run.timings, tev.milliseconds, run.playedTo, region.from, region.to);
          if (next) seekText(run, next);
          else endTextRun(run, false);
          return undefined;
        }
        const chars = tev.startCharArray ?? [];
        run.playedTo = Math.max(run.playedTo, ...chars);
        run.last = tev;
        const at = boxPosition(chars[0]);
        if (at !== null) cursorAt = at;
        lightText(noteRanges(run.ps, tev));
        return undefined;
      };

      // ── The cursor, on this face ──
      // The note the caret is on — or the one clicked: the caret lands on the
      // nearest gap between two characters, so a click on the right half of
      // a `d` puts it AFTER the `d`, before the next note. The note meant is
      // the character under the finger: of the two around the caret, the one
      // whose box holds the click, measured on the layer behind the box,
      // which lays out the very same text. Remembered for as long as the
      // caret stays where that click put it.
      let clickedAt: { caret: number; index: number } | null = null;
      textarea.addEventListener('input', () => { clickedAt = null; });
      const textCursorNote = (): ParsedNote | null => {
        const { ps, notes } = readShown();
        const a = textarea.selectionStart, b = textarea.selectionEnd;
        if (b === a && clickedAt && clickedAt.caret === a) {
          const s = sourceIndex(ps, clickedAt.index);
          const hit = notes.find(n => s >= n.start && s < n.end);
          if (hit) return hit;
        }
        return startNoteAt(notes, sourceIndex(ps, a), b > a ? sourceIndex(ps, b) : null);
      };
      /** What says the cursor moved since a run began. */
      const caretKey = (): string =>
        `${textarea.selectionStart},${textarea.selectionEnd},${clickedAt && clickedAt.caret === textarea.selectionStart ? clickedAt.index : ''}`;
      const caretMoved = (run: TextRun): boolean => caretKey() !== run.caret;

      interface TextResume { char: number; pass: number; playedTo: number; paused: boolean; caret: string }
      /** The place the run being prepared was asked to start from. A setting
       *  changed again before it is ready restarts the preparation from that
       *  same place, not from the cursor (the key changed press after press,
       *  2026-10-20: each press while loading sent it back to the caret). */
      let loadingResume: TextResume | null = null;

      /** Builds and starts a run on the box's text: from the cursor when it is
       *  inside the passage, from the passage's start when it is not — or,
       *  after a setting changed, at `resume`. */
      const startTextRun = (resume: TextResume | null) => {
        // One tune at a time: the stave's, hidden behind this face, stops.
        pauseIfPlaying();
        stopTap();
        const id = ++textRunId;
        loadingResume = resume;
        const caret = resume?.caret ?? caretKey();
        const ps = playableSource(splitXLine(tunes[currentIndex] ?? '').xLine, textarea.value);
        const cursorNote = resume ? null : textCursorNote();
        setTextState('loading');
        void (async () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const visualObj: any = abcjs.renderAbc('*', ps.source, {})[0];
            if (!visualObj) throw new Error('no tune');
            const audioParams: Record<string, unknown> = { soundFontVolumeMultiplier: abcjsVolumeMultiplier() };
            if (selectedProgram !== undefined) audioParams.program = selectedProgram;
            // The sound of the key the stave is transposed to, the dots being
            // the text's own here — see the stave's `midiTranspose`.
            if (transpose !== 0) audioParams.midiTranspose = transpose;
            const meter = parseAbcBlock(ps.source).meter;
            if (metronome) { audioParams.drum = drumPattern(beatsPerBar(meter)); audioParams.drumBars = 1; }
            if (swing !== NO_SWING && meterCanSwing(meter)) {
              Object.assign(audioParams, swingAudioParams(swing, visualObj.getMeterFraction(), visualObj.getPickupLength()));
            }
            // As SynthController.go() does it, at the shared speed.
            const millisecondsPerMeasure = visualObj.millisecondsPerMeasure() * 100 / tempoPercent;
            const qpm = Math.round(visualObj.getBeatsPerMeasure() / millisecondsPerMeasure * 60000);
            const synth = new abcjs.synth.CreateSynth();
            await synth.init({ visualObj, options: audioParams, millisecondsPerMeasure });
            await synth.prime();
            if (id !== textRunId) return;
            // eslint-disable-next-line prefer-const
            let run: TextRun;
            const timer = new abcjs.TimingCallbacks(visualObj, {
              qpm,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              eventCallback: (ev: any) => onTextEvent(run, ev),
            });
            const timings = timer.noteTimings as TimingEvent[];
            const region = textRegion();
            const regionStart = playPlan(timings, region.from, region.to)?.start;
            if (!regionStart) { stopTextPlay(); return; }
            let at = regionStart;
            if (resume) at = eventAt(timings, resume.char, resume.pass) ?? regionStart;
            else if (cursorNote) {
              // The cursor's note, its first time round.
              const here = playPlan(timings, cursorNote.start, null)?.start;
              if (here && touches(here, region.from, region.to)) at = here;
            }
            run = {
              id, synth, timer, ps, timings,
              playedTo: resume ? resume.playedTo : -1, last: null, caret,
            };
            textRun = run;
            // The cursor onto the note it starts on, before the first one
            // sounds; from there it follows the music (see paintText).
            textCurrent = noteRanges(ps, at);
            setTextHints({ start: null });
            const seekTo = Math.max(0, at.milliseconds - SEEK_BACKOFF_MS) / 1000;
            synth.seek(seekTo, 'seconds');
            if (resume?.paused) {
              setTextState('paused');
              timer.setProgress(seekTo, 'seconds');
              return;
            }
            setTextState('playing');
            synth.start();
            timer.start(seekTo, 'seconds');
          } catch (err) {
            if (id !== textRunId) return;
            console.warn('[abc] could not play the text', err);
            stopTextPlay();
          }
        })();
      };

      // ── Before play: where it will start, from the cursor ──
      /** The passage's marks in the text, from the bounds as they now stand. */
      const markTextBounds = () => {
        const region = shownRegion();
        const { ps } = readShown();
        textBoundMarks = {
          in: region?.first ? boxRange(ps, region.first.start, region.first.end) : null,
          out: region?.last ? boxRange(ps, region.last.start, region.last.end) : null,
        };
      };
      const refreshTextPreview = () => {
        if (currentMode !== 'text') return;
        markTextBounds();
        if (textState === 'loading' || textState === 'playing') { paintText(); return; }
        // Paused: the cursor on the note it stopped at while the caret is
        // where the run began — play resumes there — and on the caret's once
        // it has moved, since play then starts there (see playPause).
        if (textState === 'paused' && textRun) {
          if (!caretMoved(textRun)) {
            textCurrent = textRun.last ? noteRanges(textRun.ps, textRun.last) : [];
            paintText();
            return;
          }
          textCurrent = [];
        }
        const { ps } = readShown();
        const note = textCursorNote();
        cursorAt = note ? bodyIndex(ps, note.start) : null;
        setTextHints({ start: note ? boxRange(ps, note.start, note.end) : null });
      };
      // At most once a frame — a drag-select fires this at every pixel.
      let previewRaf = 0;
      const schedulePreview = () => {
        cancelAnimationFrame(previewRaf);
        previewRaf = requestAnimationFrame(refreshTextPreview);
      };
      const onSelectionChange = () => { if (document.activeElement === textarea) schedulePreview(); };
      document.addEventListener('selectionchange', onSelectionChange);
      for (const type of ['select', 'keyup', 'mouseup', 'input', 'focus']) textarea.addEventListener(type, schedulePreview);
      previewText = schedulePreview;

      // ── The passage: set here, drawn on both faces ──
      /** Where "here" is on this face, for one bound: the note sounding while
       *  it plays (or paused where it was), else the cursor's; a selection
       *  gives the start its first note and the end its last. */
      const textBoundAt = (side: 'in' | 'out'): number | null => {
        const { ps, notes } = readShown();
        const run = textRun;
        if (run && (textState === 'playing' || (textState === 'paused' && !caretMoved(run)))) {
          return boxPosition(run.last?.startCharArray?.[0]);
        }
        const a = textarea.selectionStart, b = textarea.selectionEnd;
        if (b > a) {
          const across = notesAcross(notes, sourceIndex(ps, a), sourceIndex(ps, b));
          return across ? bodyIndex(ps, (side === 'in' ? across.first : across.last).start) : null;
        }
        const note = textCursorNote();
        return note ? bodyIndex(ps, note.start) : null;
      };
      setBoundHere = (side) => {
        syncBounds();
        // On the stave, the note sounding or the one tapped — nothing yet is
        // the start of the tune.
        const at = currentMode === 'text' ? textBoundAt(side) : cursorAt;
        // An end at the start of the tune would hold nothing.
        if (at === null && side === 'out') return;
        bounds = setBound(bounds, side, at);
        boundsChanged();
      };
      redrawBounds = () => {
        drawBoundFlags();
        if (currentMode === 'text') refreshTextPreview();
      };

      // ── A tapped note, heard ──
      const charBox = (index: number): DOMRect | null => {
        const walker = document.createTreeWalker(textBackdrop, NodeFilter.SHOW_TEXT);
        let offset = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0;
          if (index < offset + length) {
            const range = document.createRange();
            range.setStart(node, index - offset);
            range.setEnd(node, index - offset + 1);
            return range.getBoundingClientRect();
          }
          offset += length;
        }
        return null;
      };
      // Read with `setUpAudio`, which leaves each note's pitches on it. Kept
      // for as long as the text and what changes the pitches are the same.
      let tapKey: string | null = null;
      let tapTune: unknown = null;
      let tapPs: PlayableSource | null = null;
      /** A click while the run plays sends it to the note clicked, the way a
       *  tap on the stave does (asked 2026-10-24: the click moved only the
       *  caret, and the music went on where it was). Same rule as a start from
       *  the cursor: that note's first time round, and only inside the
       *  passage. The run takes the new caret as its own, or a pause then play
       *  would read "the cursor moved" and start over from it. */
      const jumpTextRun = (run: TextRun) => {
        const note = textCursorNote();
        if (!note) return;
        const here = playPlan(run.timings, note.start, null)?.start;
        const region = textRegion();
        if (!here || !touches(here, region.from, region.to)) return;
        run.playedTo = -1;
        run.caret = caretKey();
        seekText(run, here);
      };
      textarea.addEventListener('click', (e) => {
        clickedAt = null;
        const caret = textarea.selectionStart;
        if (textarea.selectionEnd !== caret) return;
        const text = textarea.value;
        const index = [caret - 1, caret].find(i => {
          if (i < 0 || i >= text.length || /\s/.test(text[i]!)) return false;
          const box = charBox(i);
          return !!box && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
        });
        // The cursor is on the note clicked, whichever side of it the caret
        // went — see textCursorNote.
        if (index !== undefined) clickedAt = { caret, index };
        // Before the bail-out below: a click between two notes moves the
        // music too, to the next one, as it would start from there.
        if (currentMode === 'text' && textState === 'playing' && textRun) { jumpTextRun(textRun); return; }
        if (index === undefined) return;
        schedulePreview();
        if (currentMode !== 'text' || (textState !== 'idle' && textState !== 'paused')) return;
        if (!tapPlaysNote(appState.value)) return;
        const xLine = splitXLine(tunes[currentIndex] ?? '').xLine;
        const key = `${transpose}|${selectedProgram ?? ''}|${xLine}\n${text}`;
        if (key !== tapKey) {
          tapKey = key;
          tapPs = playableSource(xLine, text);
          tapTune = null;
          try {
            const tune = abcjs.parseOnly(tapPs.source)[0];
            // As the run builds it, so that the pitch is the one play gives.
            tune?.setUpAudio({ ...(selectedProgram !== undefined ? { program: selectedProgram } : {}), ...(transpose !== 0 ? { midiTranspose: transpose } : {}) });
            tapTune = tune ?? null;
          } catch { /* text abcjs cannot read: nothing to play */ }
        }
        if (!tapTune || !tapPs) return;
        const note = tappedNote(tapTune, sourceIndex(tapPs, index));
        if (!note) return;
        unlockAbcjsAudio();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        playTap(abcjs, tapTracks(note.pitches, note.graces, secondsPerWhole(tapTune as any, tempoPercent), selectedProgram));
      });

      // ── One cursor for both faces ──
      // Leaving one face for the other, the cursor goes along: onto the caret
      // in the box — without focusing it, which would put a keyboard over
      // half a phone screen for someone who had not asked to type — or onto
      // the stave, once it is primed.
      shareCursor = (mode) => {
        syncBounds();
        if (cursorAt === null) return;
        if (mode === 'text') {
          if (cursorAt > textarea.value.length) return;
          clickedAt = null;
          textarea.setSelectionRange(cursorAt, cursorAt);
          return;
        }
        if (synthControl?.timer && !sheetNeedsRerender) placeScoreCursor();
        else cursorPending = true;
      };

      textTransport = {
        playPause: () => {
          if (textState === 'idle') { startTextRun(null); return; }
          if (textState === 'loading') { stopTextPlay(); return; }
          const run = textRun;
          if (!run) return;
          if (textState === 'playing') {
            try { run.synth.pause(); run.timer.pause(); } catch { /* ended */ }
            setTextState('paused');
          } else if (caretMoved(run)) {
            // Paused, then the cursor moved: play means from THERE (reported
            // 2026-10-15 — it resumed where it was). Left where it began, it
            // resumes.
            stopTextPlay();
            startTextRun(null);
          } else {
            run.synth.start();
            run.timer.start();
            setTextState('playing');
          }
        },
        // Back to the start of the passage, playing or not, without stopping.
        rewind: () => {
          const run = textRun;
          if (!run || textState === 'loading') return;
          run.playedTo = -1;
          const start = textRegionStart(run);
          if (start) seekText(run, start);
        },
        stop: () => {
          textRunId++;
          const run = textRun;
          textRun = null;
          if (run) {
            try { run.timer.stop(); } catch { /* already stopped */ }
            try { run.synth.stop(); } catch { /* never started */ }
          }
          if (textState !== 'idle') setTextState('idle');
          textCurrent = [];
          refreshTextPreview();
        },
        // The same note, the same time round — rebuilt.
        retime: () => {
          if (textState === 'idle') return;
          const run = textRun;
          if (textState === 'loading' || !run) { startTextRun(loadingResume); return; }
          const at = run.last ?? textRegionStart(run);
          const resume: TextResume = {
            char: at?.startCharArray?.[0] ?? 0,
            pass: at ? passOf(run.timings, at) : 0,
            playedTo: run.playedTo,
            paused: textState === 'paused',
            caret: run.caret,
          };
          const old = run;
          textRun = null;
          try { old.timer.stop(); old.synth.stop(); } catch { /* ended */ }
          startTextRun(resume);
        },
      };
      // Space toggles playback, the way it does in every player.
      //
      // Ignored while a field or a button has focus: a button already answers
      // the space bar by activating itself — including the play button, which
      // gives the same result by its own route — and swallowing the key inside
      // the ABC text editor would make it impossible to type.
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
        // The play-along's player has the key (syncedScore.tsx).
        if (playAlongView) return;
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || active?.isContentEditable) return;
        e.preventDefault(); // or the page scrolls under the modal
        if (currentMode === 'text') { unlockAbcjsAudio(); textTransport.playPause(); return; }
        unlockAbcjsAudio();
        beforeScorePlay();
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
       *  silence while the buffer is rebuilt; there is no way around that one.
       *
       *  Several redraws closer together than a rebuild — the key changed
       *  press after press while it played (reported 2026-10-20: the cursor
       *  went haywire, the sound stopped while the cursor ran on, once a
       *  cacophony) — are ONE: the place is read at the first, put back after
       *  the last. Two things went wrong before. The second press read the
       *  controller mid-rebuild, "stopped, at the start", which the first
       *  setTune had just set, and gave up the playback. And the first press's
       *  `play()`, outside the queue, landed in the middle of the second
       *  setTune: it started the buffer being re-initialised and the OLD
       *  timer, which `go()` then orphaned by building a new one over it —
       *  never stopped, still driving the cursor from a drawing that was gone.
       *  So the putting back is a step of the queue too, behind its own
       *  setTune, and awaited, so the next rebuild waits for it. */
      let redrawGen = 0;
      const redrawPreservingPlayback = (draw: () => void) => {
        if (!pendingRestore) pendingRestore = { wasPlaying: !!synthControl?.isStarted, at: synthControl?.percent ?? 0 };
        const gen = ++redrawGen;
        draw();
        void enqueueSynth(() => {
          // A later redraw is queued behind this one: it puts the place back.
          if (gen !== redrawGen || !pendingRestore) return undefined;
          const { wasPlaying, at } = pendingRestore;
          // Cleared once it is done, not before: a press made while `play()`
          // is on its way would otherwise read the controller half restored.
          const done = () => { if (gen === redrawGen) pendingRestore = null; };
          // Stopped at the very beginning is "nothing to put back", and saying
          // so matters: seeking runs the cursor callback, which paints the note
          // it lands on. Restoring a position nobody had left would mark the
          // first note of a score that has never been played.
          if (!synthControl || (!wasPlaying && at === 0)) { done(); return undefined; }
          try {
            if (!wasPlaying || synthControl.isStarted) { synthControl.seek(at); done(); return undefined; }
            return Promise.resolve(synthControl.play()).then(() => synthControl.seek(at)).finally(done);
          } catch { done(); return undefined; /* nothing primed to resume */ }
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
      // is the one change that does not need wrapping — but it does need
      // QUEUEING, and collapsing. Each press of the speed stepper used to call
      // setWarp at once, and setWarp is a whole rebuild: tear down, re-render
      // the audio, new timer, then put the position back. Two presses closer
      // together than a rebuild ran two at once (reported 2026-09-29, "the
      // loop goes haywire"): the first's timer was left running with nobody
      // holding it, still firing end-of-tune into the controller, and the
      // second read "not playing, at the start" — which the first had just
      // set on its way down — and put the tune back there.
      //
      // So one rebuild at a time, through the same queue as a new tune, and
      // presses made while one is running fold into a single next one, which
      // goes straight to the speed the stepper shows by then.
      let warpPending = false;
      applyWarp = () => {
        if (warpPending) return;
        warpPending = true;
        void enqueueSynth(() => {
          warpPending = false;
          if (!synthControl || synthControl.warp === tempoPercent) return undefined;
          return Promise.resolve(synthControl.setWarp(tempoPercent)).then(() => {
            // setWarp's teardown clears the "on" look off EVERY button
            // (destroy → control.resetAll), the loop's included, while the
            // loop itself stays on. It looked off; pressing it to put it back
            // turned it off for real — "I lose the repeat".
            try { synthControl.control?.pushLoop(synthControl.isLooping); } catch { /* no widget */ }
          });
        });
      };

      // What abcjs makes of the text as it is typed — the warnings, and nothing
      // drawn. `parseOnly` does the reading without the engraving, which is the
      // whole cost of this: no SVG, no layout, no second score on screen.
      checkWarnings = () => {
        const marked = textWarnMarks.length > 0;
        textWarnMarks = [];
        if (currentMode !== 'text' || !showAbcSyntaxCheck(appState.value)) {
          showWarnings([]);
          if (marked) paintText();
          return;
        }
        // The `X:` line back on, because that is the block abcjs will be given
        // when this is saved — and a body without it parses differently. Line
        // for line with the box, so that a warning's line number is a line of
        // the box: an `X:` typed in the box and a dropped field become comment
        // lines rather than going, and the default tempo is not injected — a
        // `Q:` line of our own making cannot be wrong, and would push every
        // line after the `K:` one further down.
        const { xLine } = splitXLine(tunes[currentIndex] ?? '');
        const text = textarea.value;
        const boxLines = text.split('\n').map(l => (/^X:/.test(l) ? '%' : l));
        const source = blankForRender([...(xLine ? [xLine] : []), ...boxLines].join('\n'));
        const offset = xLine ? 1 : 0;
        try {
          const parsed = abcjs.parseOnly(source);
          // Optional at every step: `warnings` is declared optional in abcjs's
          // own typings, and this file has been caught before by a typing that
          // promised more than the code delivers.
          const list = Array.isArray(parsed?.[0]?.warnings) ? parsed[0]!.warnings! : [];
          const sourceLines = source.split('\n');
          const places = list.map(w => {
            const at = locateAbcWarning(sourceLines, w);
            // A warning on our own `X:` line has nothing in the box to mark.
            const range = at && at.line >= offset ? abcWarningRange(text, at.line - offset, at.col) : null;
            if (range) textWarnMarks.push(range);
            return range ? range[0] : null;
          });
          showWarnings(list, places);
        } catch {
          // Text so broken that abcjs throws rather than warning about it.
          showWarnings([t('fileViewer.abcError')]);
        }
        if (marked || textWarnMarks.length) paintText();
      };
      recheckAbcSyntax = checkWarnings;

      // Debounced: parsing is cheap, but doing it inside every keystroke's
      // input event makes the caret stutter on a long set. The marks go at
      // once, though: left in place, they would sit a character off from
      // what they named until the check came back.
      let warnTimer = 0;
      textarea.addEventListener('input', () => {
        window.clearTimeout(warnTimer);
        if (textWarnMarks.length) { textWarnMarks = []; paintText(); }
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
      // The source face's player goes with the dialog too.
      const stopWithText = releaseKeys;
      releaseKeys = () => {
        stopWithText();
        stopTextPlay();
        document.removeEventListener('selectionchange', onSelectionChange);
        cancelAnimationFrame(previewRaf);
      };

      // Changing instrument without losing your place.
      reapplyAbcPrefs = () => redrawPreservingPlayback(() => {
        selectedProgram = appState.value.abcInstrument;
        // The paper is set in that dialog too, and belongs to the ENGRAVING:
        // re-read here so one apply hook covers everything the preferences can
        // change about a score.
        paper = abcPaper(appState.value);
        applyPaper();
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

      // The practice row is shared by both faces (2026-10-15). On the source
      // face a change reaches the text's player, and the stave — hidden — is
      // only marked to be redrawn when it is next shown, which is what
      // `sheetNeedsRerender` is for.
      const redrawSheet = redrawScore;
      redrawScore = () => {
        if (currentMode === 'text') { sheetNeedsRerender = true; textTransport.retime(); return; }
        redrawSheet();
      };
      const warpSheet = applyWarp;
      applyWarp = (percent) => { warpSheet(percent); textTransport.retime(); };
      const prefsSheet = reapplyAbcPrefs;
      reapplyAbcPrefs = () => { prefsSheet?.(); textTransport.retime(); };
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

      /** Saves what the box holds; true once it is written. */
      const saveText = async (): Promise<boolean> => {
        const next = textarea.value;
        saveBtn.disabled = true;
        // Awaited, then applied: a save may ask something first and be
        // refused — see the ABC branch's theSessionScoreSaver.
        let result: PreviewSaveResult;
        try {
          result = await onSave(arrayBufferToBase64(new TextEncoder().encode(next).buffer));
        } catch (e) {
          console.warn('[viewer] save failed', e);
          saveStatus.textContent = t('fileViewer.saveFailed');
          saveBtn.disabled = false;
          return false;
        }
        if (result === false) {
          saveBtn.disabled = textarea.value === text;
          return false;
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
        return true;
      };
      saveBtn.onclick = () => { void saveText(); };
      guardClose = (dismiss) => {
        if (textarea.value === text) return false;
        askUnsavedChanges({ message: t('unsaved.message.text'), save: saveText, discard: () => { textarea.value = text; }, proceed: dismiss });
        return true;
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

  // Scores first: neither the preferences nor the room to spread out applied
  // to an image, a PDF or a recording. A score is the one thing here that a wider
  // frame genuinely re-renders — abcjs lays out to the container, so the extra
  // width buys fewer line breaks rather than a bigger picture.
  //
  // And recordings since 2026-10-10, at the user's request: a wider waveform
  // is a finer one to place the bounds of a part on. PDFs since 2026-10-15
  // (group feedback): a page read at the dialog's size is a page read small.
  const isScore = isAbcFile(entry);
  const onRename = opts?.onRename;
  showModal(entry.name, body, [], {
    maxWidth: modalWidth(entry),
    // The version arrows and the Sheet / ABC tabs are pressed again and again,
    // and every version, every face, is its own height (reported 2026-10-23).
    pinTop: true,
    onDismiss,
    guardDismiss: (dismiss) => guardClose?.(dismiss) ?? false,
    expandable: isScore || m.startsWith('audio/') || m === 'application/pdf',
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
    // abcTools left of the gear (2026-10-10, the user): both act on the tune as
    // a whole, and the dialog's own controls (full page, ✕) close the row.
    headerActions: isScore
      ? [
          {
            icon: iconElement(ExternalLinkIcon, 15),
            title: t('fileViewer.abc.openInAbcTools'),
            onClick: () => openInAbcTools?.(),
          },
          {
            icon: iconElement(GearIcon, 15),
            title: t('fileViewer.abc.prefs.title'),
            tour: 'abc-gear',
            onClick: () => showAbcPrefsModal(() => reapplyAbcPrefs?.(), () => recheckAbcSyntax?.()),
          },
        ]
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
