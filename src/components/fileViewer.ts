import LZString from 'lz-string';
import type { AbcOpenMode, AbcPaper, Attachment, FileEntry, ScoreFace } from '../types';
import { entryToObjectUrl, entryToBytes, arrayBufferToBase64, focusIfDesktop, downloadBlob, isAppleTouchDevice } from '../utils';
import { isNative } from '../native/platform';
import { renderMarkdown, sanitizeEmphasisOnly } from './markdown';
import { mkCustomSelect } from './customSelectVanilla';
import { qualityColour, faded } from './followColour';
import { keyGapText } from '../session/keyName';
import { starIconElement, iconElement, ExternalLinkIcon, GearIcon, TrashIcon, PlusIcon, ExpandIcon, CollapseIcon,
  MetronomeIcon, TuningForkIcon, SwingStraightIcon, SwingLightIcon, SwingMediumIcon, SwingStrongIcon,
  WarningTriangleIcon, ChevronDownIcon, ScoreFollowIcon, CloudIcon, ArrowLeftIcon, ArrowRightIcon, MicIcon, MusicNoteIcon } from './icons';
import { t } from '../services/i18nService';
import { unlockAbcjsAudio, claimAudioFocus, releaseAudioFocus } from '../services/audioSession';
import { injectDefaultTempo, stripForRender, isAbcFile, decodeAbc, splitAbcTunes, parseAbcBlock, abcOpenMode,
  showAbcSyntaxCheck, suggestPlayedVersion, blankForRender, locateAbcWarning, abcWarningRange,
  abcPaper, abcPaperSetting, ABC_PAPER_AUTO, abcSwingAtOpen, meterCanSwing,
  ABC_PAPERS, SWING_CHOICES, NO_SWING, stepSwingChoice } from '../services/abcService';
import { engraveScore, type ScoreMeasure } from '../services/abcLineBreaks';
import { ENGRAVE_HYSTERESIS, engraveOptions, engraveWidthOf, cropToInk } from './scoreEngraving';
import { modalMaxH, modalMaxW, getZoom } from '../services/zoomService';
import {
  playableSource, sourceIndex, noteRanges, passOf, eventAt, isNote,
  notesOf, startNoteAt, boxRange, bodyIndex, type ParsedNote, type PlayableSource, type TimingEvent,
} from '../services/abcTextPlayback';
import { createAbcPlayer, type AbcPlayer, type PlayState, type Place, type PlayerRun } from './abcPlayer';
import { bindFaceSplit } from './faceSplit';
import { tapTracks, tappedNote, secondsPerWhole, playTap, stopTap, tapPlaysNote, type MidiPitch } from '../services/abcTapNote';
import { shiftPosition, boundNote, notesAcross, regionOf, setBound, type Bounds } from '../services/abcBounds';
import { showModal, updateTopModal, setModalMaxWidth, confirmModal, askUnsavedChanges } from './modal';
import { splitFileName, renamedFileName, safeFileName } from '../services/attachmentNames';
import type { AudioPresetsBinding } from '../services/audioPresets';
import { playIcon, pauseIcon, stopIcon, rewindIcon, repeatIcon, boundIcon } from './playbackIcons';
import { appState, mutate } from '../store';
import { registerOverlay } from './overlayStack';
import { mountPlayAlong } from '../session/ui/PlayAlongView';
import { viewMimeType, isHeif, heifToJpeg } from '../services/heic';

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

// ── MIME helpers ──────────────────────────────────────────────────────────────

function isText(entry: FileEntry): boolean {
  return entry.mimeType.startsWith('text/') ||
    entry.name.endsWith('.md') || entry.name.endsWith('.txt');
}

function isMarkdown(entry: FileEntry): boolean {
  return entry.mimeType === 'text/markdown' || entry.name.endsWith('.md');
}


/** How far from a note a tap may land and still mean it, in window pixels —
 *  across, to the nearest note of the system, and above or below the system.
 *  About half a fingertip: notes in a phone-width bar sit a dozen pixels
 *  apart, so the nearest one wins long before this is reached, and a tap
 *  further off than this is a tap on empty paper. */
const TAP_REACH_PX = 20;

/** How far a press may travel and still be a tap rather than a drag. */
const TAP_SLOP_PX = 10;

/** How long the typing pauses before the stave beside it is redrawn, on the
 *  "both" face — the syntax check's pace, a little slower: engraving costs
 *  more than parsing. */
const TYPING_REDRAW_MS = 300;

/** How long things settle before the tune's sound is made ahead of the next
 *  press — the stave drawn first, a run of presses on a stepper folded into
 *  one. After a keystroke, longer: a whole performance is rendered each
 *  time, which typing would otherwise pay for at every pause. */
const PREPARE_DELAY_MS = 400;
const PREPARE_AFTER_TYPING_MS = 1500;

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

  // ── The Play-along's offer of the version being played ──
  // Read when the Play-along is turned on: one already listening goes on as
  // it started.
  const suggestBox = document.createElement('input');
  suggestBox.type = 'checkbox';
  suggestBox.className = 'card-checkbox';
  suggestBox.checked = suggestPlayedVersion(appState.value);
  suggestBox.addEventListener('change', () => {
    const on = suggestBox.checked;
    void mutate(st => { if (on) delete st.abcSuggestPlayedVersion; else st.abcSuggestPlayedVersion = false; });
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
    row('fileViewer.abc.prefs.suggestVersion', suggestBox),
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

/** A score's dialog while it shows the stave and the ABC together (the "both"
 *  face): room for the two side by side, the stave keeping about the width it
 *  has alone. Still capped by the screen (modal.tsx's `modalMaxW`). */
const BOTH_FACES_WIDTH = '1400px';

/** Which faces a face shows. */
const showsSheet = (face: ScoreFace): boolean => face !== 'text';
const showsText = (face: ScoreFace): boolean => face !== 'sheet';

export interface PreviewModalOpts {
  /** Multi-tune ABC files: which splitAbcTunes() index to open at — the
   *  attachment's stored `preferredIndex`, if any. */
  initialIndex?: number;
  /** An ABC score opened already transposed, in semitones: a card's score
   *  opened from a detection, in the key it was played in (2026-11-07). The
   *  reader's own transposition from there, never stored either. */
  initialTranspose?: number;
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
  /** A score with a recording of it: the viewer offers "Audio sync", which
   *  puts that recording's player in the score's place, the score following
   *  it (2026-10-28, the user). Today a detection's score, its recording the
   *  analysis's (session/ui/ScoreFollowView.tsx). */
  audioSync?: AudioSyncBinding;
  /** Adds a recording to the card the score belongs to: the Play-along's
   *  take, kept (2026-11-01, the user). Absent — a score with no card, a
   *  detection's — the Play-along has no record button. */
  onKeepRecording?: (a: Attachment) => void;
}

/** What the viewer is handed to play a score along its recording. */
export interface AudioSyncBinding {
  /** The recording is only on Drive: the toggle wears the play button's cloud. */
  fromDrive: boolean;
  /** Whether this version — its ABC, as the viewer shows it — can be played
   *  along: the toggle is offered on those only. */
  plays: (version: string) => boolean;
  /** Asked each time the toggle is turned on, before `mount`: which of a
   *  card's recordings (cardAudioSync.ts). False: it stays off. */
  choose?: (version: string) => Promise<boolean>;
  /** Puts the audio sync of `version` in `host`, on the viewer's face (stave
   *  or text) and at its size, drawn in the viewer's key (`transpose`,
   *  semitones). `onState` hears how its alignment goes. */
  mount: (
    host: HTMLElement, version: string, face: ScoreFace, expanded: boolean,
    onState: (s: AudioSyncState) => void, forced: boolean, transpose: number,
  ) => AudioSyncView;
}

/** Where an audio sync's alignment stands — what its toggle shows (2026-10-29,
 *  the user): filling up like a progress bar while it is made, then coloured
 *  by how well it fits, on followColour.ts's red-to-green scale — red when
 *  there is none to follow, too poor to be trusted or impossible. `percent`:
 *  the share of notes on the score, when there was an alignment. `title` says
 *  it in full, for the tooltip. */
export type AudioSyncState =
  | { kind: 'aligning'; ratio: number; title: string }
  | { kind: 'aligned'; title: string; percent: number; keyGap?: number }
  | { kind: 'none'; title: string; percent?: number; keyGap?: number };
// `keyGap`: how many semitones above the score as shown the recording plays
// it (2026-11-07, the user: the gap is said wherever audio and score meet),
// -5 to +6; absent or 0 when they agree.

/** Room the toggles' labels need beyond their own width to come back once
 *  they were dropped (fitToggles). */
const TOGGLE_SLACK_PX = 8;

/** A press this long on the toggle is the hidden "follow anyway". */
const LONG_PRESS_MS = 550;

/** An audio sync in place, as the viewer drives it: its versions, its tabs,
 *  its full page. */
export interface AudioSyncView {
  /** Another version on screen, one `plays` accepts: aligned anew, the
   *  player kept — the recording has not changed (2026-10-29, the user). */
  setVersion: (version: string) => void;
  /** Followed even when the alignment is judged too poor to be (the hidden
   *  gesture on the toggle). */
  setForced: (forced: boolean) => void;
  setFace: (face: ScoreFace) => void;
  setExpanded: (expanded: boolean) => void;
  /** The viewer's transposition changed: the score drawn in that key, the
   *  gap to the recording measured from it. */
  setTranspose: (semitones: number) => void;
  unmount: () => void;
}

/** The Play-along in place (session/ui/PlayAlongView.tsx): the score
 *  following what the microphone hears, driven by the viewer's versions,
 *  tabs and full page as the audio sync is. */
export interface PlayAlongView {
  /** The version on screen now: its ABC, and its index in the file. */
  setVersion: (version: string, index: number) => void;
  setFace: (face: ScoreFace) => void;
  setExpanded: (expanded: boolean) => void;
  /** The viewer's transposition changed: the score is followed in that key. */
  setTranspose: (semitones: number) => void;
  /** A take recorded and neither kept nor discarded: asks first, and true
   *  when it did — `proceed` runs once it is answered. */
  settleTake: (proceed: () => void) => boolean;
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
  // Set by the ABC branch while an audio sync is on: its player goes with the
  // modal.
  let releaseAudioSync: () => void = () => {};
  // And while a Play-along is on: the microphone goes with it.
  let releasePlayAlong: () => void = () => {};
  // And the watch on the row of the toggles' labels.
  let releaseToggleRow: () => void = () => {};
  const onDismiss = () => { closed = true; stopAudio(); releaseKeys(); releasePdf(); releaseFullscreen(); releaseAudioSync(); releasePlayAlong(); releaseToggleRow(); };

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

  // A HEIC with no type of its own is still a picture (heic.ts).
  const m = viewMimeType(entry.mimeType, entry.name);
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

    // A HEIC the browser cannot show (every one but Safari's) is converted
    // here, at the moment it is shown; the stored file stays the original.
    // Native first: when the browser reads it, there is nothing to load.
    if (isHeif(entry.mimeType, entry.name)) {
      img.addEventListener('error', () => {
        if (closed) return;
        URL.revokeObjectURL(img.src);
        img.style.display = 'none';
        const status = document.createElement('p');
        status.className = 'text-sm text-muted py-8';
        status.textContent = t('fileViewer.imageConverting');
        body.appendChild(status);
        heifToJpeg(new Blob([entryToBytes(entry)]))
          .then((jpeg) => {
            if (closed) return;
            img.src = URL.createObjectURL(jpeg);
            img.style.display = '';
            status.remove();
          })
          .catch((e) => {
            console.warn('[heic] could not convert ' + entry.name, e);
            status.textContent = t('fileViewer.imageUnreadable');
          });
      }, { once: true });
    }

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
    // freely and never write it back. Never the "both" face: that one is a
    // tab only, not a preference (the user, 2026-11-04).
    let currentMode: ScoreFace = abcOpenMode(appState.value);
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
    // on every opening and is never stored — save where the opening asks for a
    // key: a detection's, the one it was played in.
    let transpose = Math.max(-12, Math.min(12, Math.round(opts?.initialTranspose ?? 0)));

    const container = document.createElement('div');
    // `abc-viewer`: the container the "both" face asks how wide it is, to put
    // its two faces side by side or one above the other (styles.css).
    container.className = 'abc-viewer w-full space-y-3';

    // ── Top row: Sheet/ABC tabs + version nav + the tools that act on the score ──
    // One line, never wrapped (2026-11-01, the user): the toggles at the end
    // give up their labels, then the versions' arrows their width
    // (`fitToggles`). It wrapped until then, the tools going under the tabs.
    const topRow = document.createElement('div');
    topRow.className = 'flex items-center justify-between gap-2 flex-nowrap';

    const tabBar = document.createElement('div');
    tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg w-fit shrink-0';
    // Icons, the card's incipit's (incipit.tsx): the note for the stave, "ABC"
    // set small for the text (2026-11-01, the user) — the words in tooltips.
    const mkAbcTab = (label: string, face: Node): HTMLButtonElement => {
      const b = document.createElement('button');
      b.append(face);
      b.title = label;
      b.setAttribute('aria-label', label);
      return b;
    };
    const mkAbcGlyph = (): HTMLSpanElement => {
      const g = document.createElement('span');
      g.className = 'text-[9px] font-mono font-bold leading-none';
      g.textContent = 'ABC';
      return g;
    };
    const abcGlyph = mkAbcGlyph();
    // The two others side by side with a "+" between them (2026-11-04, the
    // user): the stave and its text at once, to write ABC while reading what
    // it says — what the tester switched to abcTools for.
    const bothGlyph = document.createElement('span');
    bothGlyph.className = 'flex items-center gap-0.5';
    const plus = document.createElement('span');
    plus.className = 'text-[10px] font-bold leading-none';
    plus.textContent = '+';
    bothGlyph.append(iconElement(MusicNoteIcon, 12), plus, mkAbcGlyph());
    const sheetTabBtn = mkAbcTab(t('fileViewer.abc.sheetTab'), iconElement(MusicNoteIcon, 14));
    const textTabBtn  = mkAbcTab(t('fileViewer.abc.textTab'), abcGlyph);
    const bothTabBtn  = mkAbcTab(t('fileViewer.abc.bothTab'), bothGlyph);
    sheetTabBtn.onclick = () => chooseMode('sheet');
    textTabBtn.onclick  = () => chooseMode('text');
    bothTabBtn.onclick  = () => chooseMode('both');
    tabBar.append(sheetTabBtn, textTabBtn, bothTabBtn);
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
    // The "X/Y" and the star are ONE button since 2026-10-31 (the user): the
    // star sits against the figures and a press anywhere on them toggles it,
    // which saves the width of a second target in a row a phone already wraps.
    let updateStarBtn: (() => void) | null = null;
    const onSetPreferredIndex = opts?.onSetPreferredIndex;
    if (onSetPreferredIndex) {
      const starBtn = document.createElement('button');
      starBtn.className = 'abc-tool-btn gap-1 group hover:bg-elevated';
      versionLabel.className = 'text-xs font-medium text-muted tabular-nums group-hover:text-primary';
      const starSlot = document.createElement('span');
      starBtn.append(versionLabel, starSlot);
      updateStarBtn = () => {
        // Strictly the stored preference. A score with several versions and
        // none chosen shows NO star at all: it still opens on the first,
        // because that is how every reader defaults an absent value, but
        // "where this opens by default" is not "the one you picked", and
        // lighting the first would invent a choice nobody made.
        const isFavorite = currentIndex === favoriteIndex;
        starSlot.innerHTML = '';
        starSlot.appendChild(starIconElement(isFavorite, 12));
        starSlot.className = `flex ${isFavorite ? 'text-warn' : 'text-muted group-hover:text-warn'}`;
        starBtn.title = t(isFavorite ? 'fileViewer.abc.isDefault' : 'fileViewer.abc.setDefault');
        starBtn.setAttribute('aria-pressed', String(isFavorite));
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

    // ── Audio sync (2026-10-28, the user) ────────────────────────────────────
    // A toggle at the end of the row, for a score that comes with a recording
    // of it: on, the recording's player takes the score's place — waveform,
    // tempo, transposition, region — the score drawn above it following what
    // is heard; off, the viewer is as it was left. The tabs stay and drive it
    // (the text face lights the note heard, read-only), and so do the versions:
    // another version is aligned anew (2026-10-29, the user — one may want to
    // sync the recording to a version other than the one heard). Only a
    // version the binding can follow offers it (`plays`). The viewer's own
    // sound, its full page and its space bar stand down meanwhile.
    const audioSync = opts?.audioSync;
    let audioSyncView: AudioSyncView | null = null;
    let audioSyncHost: HTMLElement | null = null;
    /** What the audio sync hid, with how each was shown, to put back. */
    let hiddenByAudioSync: Array<[HTMLElement, string]> = [];
    const audioSyncBtn = audioSync ? document.createElement('button') : null;
    /** How the alignment of the version on screen stands: the toggle shows it
     *  (AudioSyncState) instead of anything over the score. Kept when the
     *  toggle is turned off once it is known — the alignment is still the
     *  same — and dropped with the version. */
    let audioSyncState: AudioSyncState | null = null;
    const paintAudioSync = (): void => {
      if (!audioSyncBtn || !audioSync) return;
      const on = !!audioSyncView;
      const s = audioSyncState;
      // Once the alignment is in: the quality's colour, continuous — the
      // waveform's tint uses the same scale.
      const colour = !s || s.kind === 'aligning' ? null
        : s.percent !== undefined ? qualityColour(s.percent / 100) : 'var(--color-danger)';
      const look = colour ? 'hover:brightness-110'
        : on ? 'border-accent/60 text-accent' : 'border-border text-muted hover:text-primary hover:border-accent/50';
      audioSyncBtn.className = `ml-auto inline-flex items-center gap-1.5 ${togglesCompact ? 'px-2.5' : 'px-3'} min-h-[2.25rem] text-xs font-medium rounded-full border transition-colors cursor-pointer ${look}`;
      audioSyncBtn.style.color = colour ?? '';
      audioSyncBtn.style.borderColor = colour ? faded(colour, on ? 0.6 : 0.4) : '';
      audioSyncBtn.style.backgroundColor = colour && on ? faded(colour, 0.14) : '';
      // The toggle as a progress bar while the alignment is made: filled from
      // the left as far as it has gone.
      if (s?.kind === 'aligning') {
        const p = Math.round(s.ratio * 100);
        audioSyncBtn.style.backgroundImage = `linear-gradient(to right, color-mix(in srgb, var(--color-accent) 22%, transparent) ${p}%, transparent ${p}%)`;
      } else {
        audioSyncBtn.style.backgroundImage = '';
      }
      audioSyncBtn.setAttribute('aria-pressed', String(on));
      // How well, in figures, on the toggle itself (2026-10-29, the user).
      const percent = s && s.kind !== 'aligning' ? s.percent : undefined;
      const gap = s && s.kind !== 'aligning' ? s.keyGap ?? 0 : 0;
      const label = percent === undefined
        ? t('fileViewer.abc.audioSync')
        : gap !== 0
          ? t('fileViewer.abc.audioSync.percentKey', { percent, shift: keyGapText(gap) })
          : t('fileViewer.abc.audioSync.percent', { percent });
      audioSyncLabel.textContent = label;
      audioSyncBtn.setAttribute('aria-label', label);
      const title = s?.title ?? t(audioSync.fromDrive ? 'fileViewer.abc.audioSync.hintDrive' : 'fileViewer.abc.audioSync.hint');
      // Its name in the tooltip once the label is gone.
      audioSyncBtn.title = togglesCompact ? `${label} · ${title}` : title;
      // The label may have grown (its figure): does it still fit?
      fitToggles();
    };
    const audioSyncLabel = document.createElement('span');
    /** The icons alone when the toggles' labels do not fit at the end of the
     *  row (the user, 2026-10-29) rather than a toggle wrapping onto a line of
     *  its own: the audio sync's colour still says how well, the tooltips the
     *  rest. Both labels go and come back together (2026-10-31, the user):
     *  the audio sync's and the Play-along's (below, which sets `fitToggles`
     *  once both toggles are in the row). */
    let togglesCompact = false;
    let fitToggles: () => void = () => {};
    const showAudioSyncBtn = (): void => {
      if (!audioSyncBtn || !audioSync) return;
      audioSyncBtn.style.display = audioSync.plays(shownBlock(currentIndex)) ? '' : 'none';
      fitToggles();
    };
    /** Puts the audio sync of the version on screen in its place. */
    const mountAudioSync = (): void => {
      audioSyncState = null;
      audioSyncView = audioSync!.mount(audioSyncHost!, shownBlock(currentIndex), currentMode, modalExpanded, (s) => {
        // Not once it is turned off: an alignment stopped half-way says nothing.
        if (!audioSyncView) return;
        audioSyncState = s;
        paintAudioSync();
      }, audioSyncForced, transpose);
    };
    /** The hidden way round the verdict (2026-10-29, the user): a right click
     *  — a long press on a touch screen — follows the alignment even when it
     *  is judged too poor to be, turning the toggle on if it was off; the same
     *  gesture again gives the verdict back. The toggle stays red: the
     *  alignment is no better for being shown. Not advertised. */
    let audioSyncForced = false;
    let lastForceAt = 0;
    const forceAudioSync = (): void => {
      // Android sends both a long press and a contextmenu for one gesture.
      const now = Date.now();
      if (now - lastForceAt < 800) return;
      lastForceAt = now;
      if (!audioSyncView) {
        turnOnAudioSync(true);
        return;
      }
      audioSyncForced = !audioSyncForced;
      audioSyncView.setForced(audioSyncForced);
    };
    /** On, once the binding has been told what to play when it asks
     *  (`choose`) — unless the question was walked away from, or the viewer
     *  closed or another way turned it on meanwhile. */
    let choosing = false;
    const turnOnAudioSync = (forced: boolean): void => {
      // It takes the Play-along's place: a take in hand is asked about first.
      if (playAlongView?.settleTake(() => turnOnAudioSync(forced))) return;
      if (!audioSync?.choose) {
        audioSyncForced = forced;
        setAudioSync(true);
        return;
      }
      if (choosing) return;
      choosing = true;
      void audioSync.choose(shownBlock(currentIndex)).then((ok) => {
        choosing = false;
        if (!ok || closed || audioSyncView) return;
        audioSyncForced = forced;
        setAudioSync(true);
      }, (err: unknown) => {
        choosing = false;
        console.error('[audio-sync]', err);
      });
    };
    const setAudioSync = (on: boolean): void => {
      if (!audioSync || on === !!audioSyncView) return;
      if (on) {
        // One cursor at a time: the Play-along goes (below).
        if (playAlongView) setPlayAlong(false);
        // The score's own sound stops, for good.
        stopPlay();
        if (fullscreen) exitFullscreen();
        hiddenByAudioSync = Array.from(container.children)
          .filter((el): el is HTMLElement => el instanceof HTMLElement && el !== topRow)
          .map(el => [el, el.style.display]);
        for (const [el] of hiddenByAudioSync) el.style.display = 'none';
        audioSyncHost = document.createElement('div');
        container.appendChild(audioSyncHost);
        mountAudioSync();
      } else {
        audioSyncView!.unmount();
        audioSyncView = null;
        // Turned off, it starts afresh: forced only by the gesture again.
        audioSyncForced = false;
        // An alignment stopped half-way is no alignment: the bar goes.
        if (audioSyncState?.kind === 'aligning') audioSyncState = null;
        audioSyncHost?.remove();
        audioSyncHost = null;
        for (const [el, display] of hiddenByAudioSync) el.style.display = display;
        hiddenByAudioSync = [];
        // Everything the face decides, decided again — the stave redrawn, as
        // a version changed meanwhile was drawn into a hidden box.
        sheetNeedsRerender = true;
        setAbcMode(currentMode);
      }
      paintAudioSync();
    };
    /** Another version on screen: its audio sync, aligned anew under the same
     *  player — or none, for a version the binding cannot follow. */
    const versionChangedForAudioSync = (): void => {
      if (!audioSync) return;
      audioSyncState = null;
      showAudioSyncBtn();
      if (audioSyncView) {
        if (audioSync.plays(shownBlock(currentIndex))) {
          audioSyncView.setVersion(shownBlock(currentIndex));
        } else {
          setAudioSync(false);
        }
      }
      paintAudioSync();
    };
    if (audioSyncBtn && audioSync) {
      audioSyncBtn.type = 'button';
      audioSyncBtn.append(iconElement(ScoreFollowIcon, 13), audioSyncLabel);
      if (audioSync.fromDrive) audioSyncBtn.appendChild(iconElement(CloudIcon, 11));
      // A long press is not also a click once it has done its work.
      let pressTimer = 0, pressed = false;
      audioSyncBtn.onclick = () => {
        if (pressed) { pressed = false; return; }
        if (audioSyncView) setAudioSync(false); else turnOnAudioSync(false);
      };
      audioSyncBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); forceAudioSync(); });
      // iOS has no contextmenu on a long press: timed by hand, touch only —
      // and its own callout and text selection kept off the button.
      audioSyncBtn.style.setProperty('-webkit-touch-callout', 'none');
      audioSyncBtn.style.userSelect = 'none';
      audioSyncBtn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        pressed = false;
        window.clearTimeout(pressTimer);
        pressTimer = window.setTimeout(() => { pressed = true; forceAudioSync(); }, LONG_PRESS_MS);
      });
      for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
        audioSyncBtn.addEventListener(end, () => window.clearTimeout(pressTimer));
      }
      paintAudioSync();
      showAudioSyncBtn();
      topRow.appendChild(audioSyncBtn);
      releaseAudioSync = () => {
        audioSyncView?.unmount();
        audioSyncView = null;
      };
    }
    // ── Play-along (2026-10-31, the user — developer mode only) ─────────────
    // A toggle after the audio sync's, on any version with a key: on, the
    // score follows what the microphone hears (session/ui/PlayAlongView.tsx)
    // in the viewer's place, as the audio sync's player takes it — the tabs,
    // the versions and the full page driving it the same way, the viewer's
    // own sound and space bar standing down. The two exclude each other: one
    // score, one cursor. Labelled as the audio sync's is, the two labels
    // dropped together when the row is short (2026-10-31, the user). Out of
    // developer mode since 2026-11-01 (the user: « it pleases me »).
    let playAlongView: PlayAlongView | null = null;
    let playAlongHost: HTMLElement | null = null;
    /** What the Play-along hid, with how each was shown, to put back. */
    let hiddenByPlayAlong: Array<[HTMLElement, string]> = [];
    /** The viewer's height held at what the dialog shows of it while the
     *  Play-along is laid over it. A long tune makes the viewer taller than
     *  the dialog, whose body scrolls with the transport stuck at its foot
     *  (BOTTOM_ROW_CLASS): laid over the whole viewer, the Play-along ran on
     *  under that foot and its bar was cut off (2026-11-02, the user). It now
     *  ends above the body's bottom padding — not over it, as the transport
     *  does: its bar would touch the dialog's edge (2026-11-02, the user) —
     *  and nothing scrolls under it. */
    const holdPlayAlongHeight = (): void => {
      const s = container.style;
      s.height = s.overflow = '';
      const scroller = container.parentElement ? nearestScroller(container.parentElement) : null;
      if (scroller) scroller.scrollTop = 0;
      const box = container.getBoundingClientRect();
      // Rects are in the page's pixels, styles in layout ones (the app's zoom).
      const scale = container.offsetHeight > 0 ? box.height / container.offsetHeight : 1;
      const limit = scroller
        ? scroller.getBoundingClientRect().top
          + (scroller.clientTop + scroller.clientHeight - parseFloat(getComputedStyle(scroller).paddingBottom)) * scale
        : box.bottom;
      s.height = `${(Math.min(box.bottom, limit) - box.top) / scale}px`;
      s.overflow = 'hidden';
    };
    const releasePlayAlongHeight = (): void => {
      const s = container.style;
      s.height = s.overflow = '';
      window.removeEventListener('resize', holdPlayAlongHeight);
    };
    const playAlongBtn = document.createElement('button');
    const playAlongLabel = document.createElement('span');
    playAlongLabel.textContent = t('fileViewer.abc.playAlong');
    const paintPlayAlong = (): void => {
      const on = !!playAlongView;
      // At the end of the row: the audio sync's toggle has the margin that
      // puts it there, when it is shown.
      const afterSync = !!audioSyncBtn && audioSyncBtn.style.display !== 'none';
      playAlongBtn.className = `${afterSync ? '' : 'ml-auto '}inline-flex items-center gap-1.5 ${togglesCompact ? 'px-2.5' : 'px-3'} min-h-[2.25rem] text-xs font-medium rounded-full border transition-colors cursor-pointer ${
        on ? 'border-accent/60 text-accent bg-accent/10' : 'border-border text-muted hover:text-primary hover:border-accent/50'}`;
      playAlongBtn.setAttribute('aria-pressed', String(on));
      const hint = t('fileViewer.abc.playAlong.hint');
      // Its name in the tooltip once the label is gone.
      playAlongBtn.title = togglesCompact ? `${t('fileViewer.abc.playAlong')} · ${hint}` : hint;
      // Shown or hidden with its version, it changes the room the audio
      // sync's label has.
      fitToggles();
    };
    /** Offered on a version with a key, as the audio sync's is. */
    const playsAlong = (): boolean => /^K:/m.test(shownBlock(currentIndex));
    const setPlayAlong = (on: boolean): void => {
      if (on === !!playAlongView) return;
      if (on) {
        if (audioSyncView) setAudioSync(false);
        // As for the audio sync: the score's own sound stops for good.
        stopPlay();
        if (fullscreen) exitFullscreen();
        // The viewer stays where it is, laid out but unseen, and the
        // Play-along is laid over it: the dialog keeps the very size it had
        // (2026-11-01, the user: it shrank on turning the Play-along on and
        // grew back on turning it off, the pane sizing itself on its own
        // allowances). The score inside fills what the bar leaves.
        hiddenByPlayAlong = Array.from(container.children)
          .filter((el): el is HTMLElement => el instanceof HTMLElement && el !== topRow)
          .map(el => [el, el.style.visibility]);
        for (const [el] of hiddenByPlayAlong) el.style.visibility = 'hidden';
        container.classList.add('relative');
        holdPlayAlongHeight();
        window.addEventListener('resize', holdPlayAlongHeight);
        playAlongHost = document.createElement('div');
        // From under the tabs' row (the container's gap is the host's own
        // margin) to the bottom of what the viewer takes.
        playAlongHost.style.cssText = `position:absolute;left:0;right:0;bottom:0;top:${topRow.offsetTop + topRow.offsetHeight}px`;
        container.appendChild(playAlongHost);
        // Within the tap: the microphone is asked for at once.
        playAlongView = mountPlayAlong(playAlongHost, {
          versions: Array.from({ length: versionCount }, (_, i) => shownBlock(i)),
          index: currentIndex,
          suggest: suggestPlayedVersion(appState.value),
          // The offer taken: that version on screen, as its arrow would.
          onShowVersion: (i) => settleDraft(() => goToVersion(i)),
          face: currentMode,
          expanded: modalExpanded,
          onKeepRecording: opts?.onKeepRecording,
          transpose,
        });
      } else {
        playAlongView!.unmount();
        playAlongView = null;
        playAlongHost?.remove();
        playAlongHost = null;
        for (const [el, visibility] of hiddenByPlayAlong) el.style.visibility = visibility;
        hiddenByPlayAlong = [];
        container.classList.remove('relative');
        releasePlayAlongHeight();
        sheetNeedsRerender = true;
        setAbcMode(currentMode);
      }
      paintPlayAlong();
    };
    /** Another version on screen: followed in its turn — or no Play-along,
     *  for one without a key. */
    const versionChangedForPlayAlong = (): void => {
      playAlongBtn.style.display = playsAlong() ? '' : 'none';
      if (playAlongView) {
        if (playsAlong()) playAlongView.setVersion(shownBlock(currentIndex), currentIndex);
        else setPlayAlong(false);
      }
      paintPlayAlong();
    };
    playAlongBtn.type = 'button';
    playAlongBtn.append(iconElement(MicIcon, 13), playAlongLabel);
    playAlongBtn.setAttribute('aria-label', t('fileViewer.abc.playAlong'));
    // Turned off with a take in hand: asked first (PlayAlongView.settleTake).
    playAlongBtn.onclick = () => {
      if (playAlongView?.settleTake(() => setPlayAlong(false))) return;
      setPlayAlong(!playAlongView);
    };
    topRow.appendChild(playAlongBtn);
    versionChangedForPlayAlong();
    releasePlayAlong = () => {
      playAlongView?.unmount();
      playAlongView = null;
      releasePlayAlongHeight();
    };
    // ── The toggles' labels: both, or neither ────────────────────────────────
    const toggles: Array<[HTMLElement, HTMLElement]> = [];
    if (audioSyncBtn) toggles.push([audioSyncBtn, audioSyncLabel]);
    toggles.push([playAlongBtn, playAlongLabel]);
    // At once, in the observer — which runs after layout and before paint: at
    // the next frame, the toggle was seen wrapping onto a line of its own for
    // one frame before it shrank (2026-10-29, the user). What is observed is
    // a ruler as wide as the row and of no height, which the change cannot
    // resize: observing the row itself, whose height the change does move,
    // is the loop the browser reports (see syncedScore.tsx).
    const rowRuler = document.createElement('div');
    rowRuler.setAttribute('aria-hidden', 'true');
    rowRuler.style.cssText = 'position:absolute;left:0;right:0;top:0;height:0;pointer-events:none';
    /** The row's width as it stands: its children side by side. */
    const rowNeed = (): number => {
      const gap = parseFloat(getComputedStyle(topRow).columnGap) || 0;
      const shown = Array.from(topRow.children).filter(el => el !== rowRuler && (el as HTMLElement).offsetParent) as HTMLElement[];
      return shown.reduce((sum, el) => sum + el.offsetWidth, 0) + gap * Math.max(0, shown.length - 1);
    };
    /** The versions' arrows narrowed: the last thing given up before the row
     *  would wrap (2026-11-01, the user — it no longer does), once the
     *  toggles are down to their icons. */
    let navNarrow = false;
    const setNavNarrow = (narrow: boolean): void => {
      navNarrow = narrow;
      prevBtn.classList.toggle('abc-nav-narrow', narrow);
      nextBtn.classList.toggle('abc-nav-narrow', narrow);
    };
    {
      fitToggles = (): void => {
        // The toggles are judged against the arrows at their full width:
        // they give up their labels first.
        if (navNarrow) setNavNarrow(false);
        const shown = toggles.filter(([btn]) => btn.style.display !== 'none' && btn.isConnected);
        if (shown.length) fitLabels(shown);
        // Measured as it now stands, in the same task — nothing painted in
        // between; with the same few pixels to spare before widening again.
        const need = rowNeed();
        const room = topRow.clientWidth;
        if (wasNarrow ? need + TOGGLE_SLACK_PX > room : need > room) setNavNarrow(true);
        wasNarrow = navNarrow;
      };
      let wasNarrow = false;
      const fitLabels = (shown: Array<[HTMLElement, HTMLElement]>): void => {
        // Their widths in their FULL shape, labels shown and full padding —
        // measured so whichever shape they are in, in the same task, so
        // nothing is painted in between. Measured in the icon's narrower
        // padding, the label seemed to fit by a few pixels, came back,
        // overflowed, went: the toggle flickered between the two for as long
        // as the width stood at the edge (2026-10-29, the user).
        const full = shown.reduce((sum, [btn, label]) => {
          label.style.display = '';
          btn.classList.replace('px-2.5', 'px-3');
          const w = btn.offsetWidth;
          btn.classList.replace('px-3', togglesCompact ? 'px-2.5' : 'px-3');
          return sum + w;
        }, 0);
        const gap = parseFloat(getComputedStyle(topRow).columnGap) || 0;
        const others = Array.from(topRow.children).reduce((sum, el) => (
          toggles.some(([btn]) => btn === el) || el === rowRuler || !(el as HTMLElement).offsetParent ? sum : sum + (el as HTMLElement).offsetWidth + gap
        ), 0);
        const need = full + gap * (shown.length - 1);
        const room = topRow.clientWidth - others;
        // And a few pixels to spare before the labels come back: at the edge,
        // a rounding either way must not toggle them.
        const compact = togglesCompact ? need + TOGGLE_SLACK_PX > room : need > room;
        for (const [, label] of shown) label.style.display = compact ? 'none' : '';
        if (compact !== togglesCompact) { togglesCompact = compact; paintAudioSync(); paintPlayAlong(); }
      };
      const rowWatch = new ResizeObserver(() => fitToggles());
      topRow.classList.add('relative');
      topRow.appendChild(rowRuler);
      rowWatch.observe(rowRuler);
      releaseToggleRow = () => rowWatch.disconnect();
      fitToggles();
    }
    /** A tab pressed: the viewer's face, or the audio sync's, or the
     *  Play-along's. */
    const chooseMode = (mode: ScoreFace): void => {
      // Wider for the two faces side by side, back to its own width after —
      // at the press only: the face a score opens on is never "both".
      if ((mode === 'both') !== (currentMode === 'both')) {
        setModalMaxWidth(body, mode === 'both' ? BOTH_FACES_WIDTH : modalWidth(entry));
      }
      const takenOver = audioSyncView ?? playAlongView;
      if (!takenOver) { setAbcMode(mode); return; }
      currentMode = mode;
      paintTabs(mode);
      takenOver.setFace(mode);
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
      if (list.length === 0 || !showsText(currentMode) || !showAbcSyntaxCheck(appState.value)) {
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
    // The play buttons and our practice controls on the SAME line, since
    // 2026-09-21: two stacked bars for four controls was the earlier shape and
    // it spent a centimetre of a phone screen on nothing.
    //
    // ONE set of play buttons for every face since 2026-11-04 (the user: "the
    // controls at the bottom must be there whatever the view(s)"). They drive
    // the viewer's one player (abcPlayer.ts) and each face only shows where it
    // is. Until then the stave had abcjs's own widget, dressed in our glyphs,
    // and the ABC face a copy of it driving a player of its own — two players,
    // one shown at a time, the cursor copied across when the tab changed.
    const transportBar = document.createElement('div');
    transportBar.className = TRANSPORT_CLASS;
    // Appended AFTER the score, further down — see the note there.

    // abcjs's classes, and so abcjs's look (styles.css, `.abc-transport
    // .abcjs-inline-audio`): its stylesheet is what shows play, pause or the
    // spinner on the one button.
    const playControls = document.createElement('div');
    playControls.className = 'abcjs-inline-audio shrink-0';
    playControls.dataset.tour = 'abc-play';
    const withClass = (svg: string, cls: string) => svg.replace('<svg ', `<svg class="${cls}" `);
    // abcjs's own spinner (synth/images/loading.svg.js), which its CSS turns.
    const LOADING_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="abcjs-loading-svg"><circle cx="50" cy="50" fill="none" stroke-width="20" r="35" stroke-dasharray="160 55"></circle></svg>';
    const mkPlayBtn = (cls: string, html: string, title: string, onClick: () => void): HTMLButtonElement => {
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
    // Play, back, stop, repeat — the audio player's order, with the one
    // control it has no counterpart for next to play. "Back" is back to the
    // start of the passage without stopping (asked for 2026-09-25): the tune
    // is left looping and practised against, and reaching for stop then play
    // every time breaks the flow.
    const playBtn = mkPlayBtn('abcjs-midi-start',
      withClass(playIcon(15), 'abcjs-play-svg') + withClass(pauseIcon(15), 'abcjs-pause-svg') + LOADING_SVG,
      t('fileViewer.abc.listen.title'), () => transport.playPause());
    const rewindBtn = mkPlayBtn('abc-midi-rewind', rewindIcon(15), t('fileViewer.abc.rewindStart'), () => transport.rewind());
    const stopBtn = mkPlayBtn('abcjs-midi-reset', stopIcon(15), t('fileViewer.abc.listen.stop'), () => transport.stop());
    const loopBtn = mkPlayBtn('abcjs-midi-loop', repeatIcon(15), t('fileViewer.abc.listen.loop'), () => setLooping(!looping));
    playControls.append(playBtn, rewindBtn, stopBtn, loopBtn);
    transportBar.appendChild(playControls);
    /** How the play button looks — abcjs's classes, abcjs's CSS. */
    const paintPlay = (state: PlayState): void => {
      playBtn.classList.toggle('abcjs-pushed', state === 'playing');
      playBtn.classList.toggle('abcjs-loading', state === 'loading');
    };
    /** The loop. On by default: a score is opened to be practised against,
     *  and reaching for the button on every pass is friction. */
    let looping = true;
    const setLooping = (on: boolean): void => {
      looping = on;
      loopBtn.classList.toggle('abcjs-pushed', on);
    };
    setLooping(true);
    /** What the buttons do — assigned once abcjs has loaded. */
    let transport = {
      playPause: () => {}, rewind: () => {}, stop: () => {},
      /** A setting changed: picks up at the same note, rebuilt. */
      retime: () => {},
    };
    /** Typing, another version, the audio sync, the Play-along and the
     *  dialog going stop it. */
    const stopPlay = (): void => transport.stop();
    /** Re-marks the cursor in the text — assigned once abcjs has loaded. */
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
    // ── The cursor (2026-11-04, the user) ──
    // ONE cursor, which each face only shows: "it is supposed to be literally
    // the same", so moving it on one face moves it on the other at once — a
    // note tapped on the stave puts the caret on it, a caret moved in the
    // text puts the stave's cursor there. It was one variable already, but
    // each face kept its own idea of it and handed it over when the tab
    // changed, which two faces on screen together could not live with.
    //
    // While the music plays the cursor is the note sounding; paused, the note
    // it stopped on; stopped, it goes back to where play started.
    /** The note the cursor is on, as a position in the box's text: what play
     *  starts from and what a bound is set at. Null is the start. */
    let cursorAt: number | null = null;
    /** Which time round the repeats: a note tapped on the stave is on one of
     *  them, a caret in the text on the first. */
    let cursorPass = 0;
    /** Bumped by every move the READER makes, on either face — not by the
     *  music moving it. Paused, a cursor moved since says "play from there". */
    let cursorGen = 0;
    /** `cursorGen` when the music last took the cursor as its own. */
    let runGen = 0;
    /** Where play started, for the stop to put the cursor back. */
    let playFrom: { at: number | null; pass: number } | null = null;
    /** Late-bound, once abcjs has loaded: what is "here" needs the notes. */
    let setBoundHere: (side: 'in' | 'out') => void = () => {};
    /** Flags and marks drawn again — late-bound for the same reason. */
    let redrawBounds: () => void = () => {};
    /** The cursor drawn again on every face on screen — late-bound too. */
    let showCursor: () => void = () => {};

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
    boundsGroup.append(boundInBtn, boundOutBtn, boundClearBtn);
    boundsGroup.dataset.tour = 'abc-bounds';
    transportBar.appendChild(boundsGroup);

    /** What the controls say: whether there is anything to clear, and where
     *  "back" goes. */
    const paintBoundControls = (): void => {
      boundClearBtn.disabled = bounds.in === null && bounds.out === null;
      const title = t(bounds.in !== null ? 'fileViewer.abc.rewindIn' : 'fileViewer.abc.rewindStart');
      rewindBtn.title = title;
      rewindBtn.setAttribute('aria-label', title);
    };
    paintBoundControls();

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
    // One round button that opens a dialog, as the analyser's pitch control did
    // until 2026-11-07 — the user's call, and for the same reason it was built
    // that way there: a "− value +" stepper inline is about
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
        // The dots move, and the sound with them — and the Play-along's
        // score, which follows the key on screen.
        redrawScore();
        transport.retime();
        playAlongView?.setTranspose(transpose);
        audioSyncView?.setTranspose(transpose);
      });
    };

    // ── Speed ──
    // A percentage of the tune's written tempo. A change is heard at once, at
    // the same note: the player rebuilds the tune at the new speed.
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
        transport.retime();
      },
      () => {
        if (tempoPercent === DEFAULT_TEMPO_PERCENT) return;
        tempoPercent = DEFAULT_TEMPO_PERCENT;
        updateTempo();
        transport.retime();
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
      // The drum is baked into the audio buffer, so it takes a rebuild.
      transport.retime();
    });

    // abcjs does the work (its `addSwing`); all this chooses is the number.
    const swingBtn = mkSwingButton(swing, (v) => {
      swing = v;
      // Swing is applied when the note map is built, so it needs the buffer
      // rebuilt — same as the metronome.
      transport.retime();
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
    scoreFrame.className = 'abc-score-frame relative w-full';
    scoreFrame.dataset.tour = 'abc-score';
    // The stave and the ABC source in one box: one or the other on their own
    // tabs, the two together on the "both" tab (2026-11-04) — side by side
    // when the viewer is wide enough, the stave on the right, and under the
    // text when it is not (the user: the text first).
    // Decided in CSS, by a container query on the viewer (`.abc-faces-both`
    // in styles.css), never by measuring here: a layout that measures itself
    // can chase its own scrollbar.
    const facesBox = document.createElement('div');
    facesBox.appendChild(scoreFrame);
    container.appendChild(facesBox);
    // The transport goes UNDER the faces, which is why it is not appended
    // where it was built (see TRANSPORT_CLASS) — nor here: after the ABC
    // source's box, which goes into `facesBox` beside the stave.

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
      const cap = modalExpanded ? `calc(${modalMaxH(1)} - 12rem)` : modalMaxH(0.62);
      // With the text beside it or under it, the stylesheet has the last word:
      // the full cap side by side, a share of it under the text.
      facesBox.style.setProperty('--abc-score-cap', cap);
      scoreScroll.style.maxHeight = currentMode === 'both' ? '' : cap;
    };
    capScore();
    onModalExpanded = (expanded) => { modalExpanded = expanded; capScore(); audioSyncView?.setExpanded(expanded); if (playAlongView) { holdPlayAlongHeight(); playAlongView.setExpanded(expanded); } };

    /** Re-engraves for the box the score is in NOW, keeping the reader's place
     *  and whatever is playing. Assigned once abcjs has loaded; a resize that
     *  lands before then is a score that is not on screen yet. */
    let remeasure: () => void = () => {};
    /** Same, for a change to the drawing itself rather than to its size. */
    let redrawScore: () => void = () => {};
    /** The stave redrawn once the typing pauses, on the "both" face. */
    let redrawAfterTyping: () => void = () => { sheetNeedsRerender = true; };
    /** The sound of the tune made ahead of the next press, once things
     *  settle — assigned once abcjs has loaded. */
    let prepareSound: (delay?: number) => void = () => {};
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
    // ── The source face plays too (2026-10-15, a TheSession user editing ABC
    // by ear): the transport plays the text in the box as it stands — from
    // the cursor — and the note sounding is lit in the text as it is on the
    // stave. On every viewer, the read-only one too: listening is not editing.

    // The box over a layer that marks its text, since a textarea cannot
    // colour part of its own (2026-10-15): where play will start — a bar in
    // the colour of the stave's cursor, which is the same answer to the same
    // question — the passage a selection plays, tinted, and the note sounding.
    // (A dashed line under the passage while looping was tried and dropped,
    // 2026-10-15: it seemed to crawl as the playing note went by.) The layer copies the box's
    // text in the same font, padding and wrapping, transparent; the box is
    // see-through over it, and the layer paints the background.
    const textBox = document.createElement('div');
    textBox.className = 'abc-text-box relative';
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
    facesBox.appendChild(textBox);

    // ── The line between the two, side by side (2026-11-04, the user) ──
    // See faceSplit.ts. Lives as long as the dialog: nothing to release.
    const splitter = document.createElement('div');
    splitter.className = 'abc-faces-split';
    const splitLine = document.createElement('div');
    splitLine.className = 'abc-faces-split-line';
    splitter.appendChild(splitLine);
    facesBox.appendChild(splitter);
    const faceSplit = bindFaceSplit(splitter, facesBox, () => remeasure());

    const bottomRow = document.createElement('div');
    bottomRow.className = BOTTOM_ROW_CLASS;
    bottomRow.appendChild(transportBar);
    container.appendChild(bottomRow);
    // The positions marked are positions in the text as it was: a keystroke
    // makes them wrong, so typing stops it — on the "both" face too, where
    // the music could have gone on round the loop with the change in it: the
    // simpler rule, kept (the user, 2026-11-04).
    textarea.addEventListener('input', () => stopPlay());

    // ── The caret, as the cursor's face in the text ──
    /** The note clicked, when the caret landed beside it: the caret goes to
     *  the nearest gap between two characters, so a click on the right half
     *  of a `d` puts it AFTER the `d`, before the next note. Kept for as long
     *  as the caret stays where that click put it — see textCursorNote. */
    let clickedAt: { caret: number; index: number } | null = null;
    /** Where the caret is, as a key: what says the reader moved it. */
    const caretKey = (): string =>
      `${textarea.selectionStart},${textarea.selectionEnd},${clickedAt && clickedAt.caret === textarea.selectionStart ? clickedAt.index : ''}`;
    /** The caret as the cursor last saw it: a caret anywhere else was moved by
     *  the reader since, and takes the cursor along. */
    let lastCaretKey = '';
    /** The caret put on the cursor's note, and taken as seen — without the
     *  focus, which would put a keyboard over half a phone screen for someone
     *  who had not asked to type. */
    const placeCaret = (): void => {
      const at = Math.min(cursorAt ?? 0, textarea.value.length);
      clickedAt = null;
      textarea.setSelectionRange(at, at);
      lastCaretKey = caretKey();
    };
    /** The box refilled — which sends a caret to the end of the text, a place
     *  nobody put it: it goes onto the cursor instead. */
    const fillBox = (value: string): void => {
      // Not rewritten when it already holds it — what a save leaves — which
      // would lose its scroll and its undo history for nothing.
      if (textarea.value !== value) textarea.value = value;
      // The cursor brought up to the text first: another version drops it.
      syncBounds();
      placeCaret();
    };
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
     *  off the pieces' natural widths (`max-content`), never off the layout
     *  they are in.
     *
     *  That alone did not keep it still (2026-11-08, an Android tablet in
     *  portrait, reproduced in Chromium at 795-801 px wide, zoom 125 %, a set's
     *  score: ~30 switches in 0.7 s, for ever). Nothing beside the transport,
     *  the score face, was decided by the same sum without the grid's two gaps:
     *  "it fits" while its column was 16 px short, so the transport wrapped
     *  onto two lines by itself; the taller row made the dialog scroll, its
     *  scrollbar (6 px, styles.css) took that off the row, "it does not fit",
     *  stacked — on one line again, shorter, no scrollbar, and round again.
     *  Hence:
     *  - nothing beside it: nothing measured. The transport has the row
     *    (`abc-bottom-solo`) and wraps by CSS alone, which nothing can chase;
     *  - beside the source face's buttons: a slack wider than that scrollbar
     *    before going back to one line, and a stop after a few switches a
     *    second, kept until the window is resized. */
    const STACK_SLACK_PX = 12;
    let stackFlips: number[] = [];
    let stackFrozenAt = '';
    const layoutBottomRow = (): void => {
      const natural = (el: HTMLElement): number => {
        const prev = el.style.width;
        el.style.width = 'max-content';
        const w = el.offsetWidth;
        el.style.width = prev;
        return w;
      };
      const sideW = (el: HTMLElement) => (el.style.display === 'none' ? 0 : natural(el));
      const side = Math.max(sideW(versionEdit), sideW(saveGroup));
      bottomRow.classList.toggle('abc-bottom-solo', side === 0);
      if (side === 0) { bottomRow.classList.remove('abc-bottom-stacked'); return; }
      const gap = parseFloat(getComputedStyle(bottomRow).columnGap) || 0;
      const need = natural(transportBar) + 2 * (side + gap);
      const room = bottomRow.clientWidth;
      const stacked = bottomRow.classList.contains('abc-bottom-stacked');
      const stack = stacked ? need + STACK_SLACK_PX > room : need > room;
      if (stack === stacked) return;
      const windowSize = `${window.innerWidth}x${window.innerHeight}`;
      if (stackFrozenAt === windowSize) return;
      const now = performance.now();
      stackFlips = stackFlips.filter((at) => now - at < 1000);
      stackFlips.push(now);
      if (stackFlips.length > 4) { stackFrozenAt = windowSize; return; }
      bottomRow.classList.toggle('abc-bottom-stacked', stack);
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
        cursorPass = 0;
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
      textTabBtn.replaceChildren(abcGlyph);
      textTabBtn.title = t('fileViewer.abc.textTab');
      if (!draft) return;
      const dot = document.createElement('span');
      dot.className = 'text-warn ml-1 text-xs';
      dot.textContent = '●';
      textTabBtn.appendChild(dot);
      textTabBtn.title = `${t('fileViewer.abc.textTab')} · ${t('unsaved.title')}`;
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
          if (showsText(currentMode)) { fillBox(currentBody()); checkWarnings(); }
        },
        proceed,
      });
    }
    // Read-only viewers never have a draft, so this holds nothing for them.
    // The Play-along's take first, then the draft.
    const guardDraft = (dismiss: () => void): boolean => {
      if (!draft) return false;
      settleDraft(dismiss);
      return true;
    };
    guardClose = (dismiss) => {
      if (playAlongView?.settleTake(() => { if (!guardDraft(dismiss)) dismiss(); })) return true;
      return guardDraft(dismiss);
    };

    function goToVersion(index: number): void {
      stopPlay();
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
      versionChangedForAudioSync();
      versionChangedForPlayAlong();
      // Each face on screen redrawn for it; one that is not, when it is next
      // shown.
      if (showsSheet(currentMode)) doRenderTune?.(currentIndex);
      else sheetNeedsRerender = true;
      if (showsText(currentMode)) {
        fillBox(pendingBody() ?? currentBody());
        saveBtn.disabled = pendingBody() === null;
        saveStatus.textContent = '';
        checkWarnings();
        previewText();
      }
      // The sound of the version now on screen.
      prepareSound();
    }

    function paintTabs(mode: ScoreFace): void {
      const active = 'bg-accent text-white';
      const inactive = 'text-muted hover:text-primary hover:bg-elevated';
      // `min-h-[2.25rem]`: 36 layout px, which the app's own zoom turns into 45
      // on a desktop and 32,4 on a phone — the floor `.tap-btn` sets everywhere
      // else. These were 24 px tall until 2026-09-21. As wide, an icon each —
      // the "both" tab two icons wide, with a little room either side.
      const tabBase = 'flex items-center justify-center min-w-[2.25rem] min-h-[2.25rem] rounded transition-colors cursor-pointer';
      sheetTabBtn.className = `${tabBase} ${mode === 'sheet' ? active : inactive}`;
      textTabBtn.className  = `${tabBase} ${mode === 'text'  ? active : inactive}`;
      bothTabBtn.className  = `${tabBase} px-1.5 ${mode === 'both' ? active : inactive}`;
    }

    /** Whether the ABC source is on screen — to refill the box only when it
     *  comes on: refilled under the reader, it would lose its scroll and its
     *  undo history going from the ABC face to both. */
    let textShown = false;

    function setAbcMode(mode: ScoreFace): void {
      currentMode = mode;
      paintTabs(mode);
      // Hidden by an inline style.display, not just the 'hidden' class:
      // abcjs's own resize handling can otherwise leave the notation SVG
      // visibly reflowing. The transport is the same on every face, and so
      // is whatever it is doing: changing the face does not stop the music.
      facesBox.classList.toggle('abc-faces-both', mode === 'both');
      // The share as stored: the audio sync's line may have moved it.
      if (mode === 'both') faceSplit.refresh();
      // The frame, not the score inside it: the reading tools act on the
      // picture and would otherwise stay hanging over the ABC source.
      scoreFrame.style.display = showsSheet(mode) ? '' : 'none';
      // Full page acts on a drawing nobody is looking at while the source is on
      // screen — and not on the two faces together either (the user,
      // 2026-11-04). The link to abcTools is not one of them: it hands the
      // TUNE over, whichever face you were reading.
      fullscreenBtn.style.display = mode === 'sheet' ? '' : 'none';
      textBox.style.display = showsText(mode) ? '' : 'none';
      // The warnings are the source face's alone (2026-10-19).
      if (!showsText(mode)) showWarnings([]);

      if (onSave) {
        versionEdit.style.display = showsText(mode) ? '' : 'none';
        saveGroup.style.display = showsText(mode) ? '' : 'none';
      }
      layoutBottomRow();
      capScore();
      if (showsSheet(mode) && sheetNeedsRerender) {
        sheetNeedsRerender = false;
        doRenderTune?.(currentIndex);
      }
      if (showsText(mode) && !textShown) {
        fillBox(pendingBody() ?? currentBody());
        saveBtn.disabled = pendingBody() === null;
        saveStatus.textContent = '';
      }
      textShown = showsText(mode);
      // No focus: switching to the source face is often just a look, and
      // stealing the caret put a keyboard over half a phone screen for someone
      // who had not asked to type. The box is one tap away.
      if (textShown) checkWarnings();
      showCursor();
      // Back from the audio sync or the Play-along, which had the sound.
      prepareSound();
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
        // Refreshes the nav, the label, the ★, the share link and the box —
        // and the stave, now when it is on screen, else once it is reopened.
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
        // The stave is drawn from the draft, so it is stale from now on:
        // redrawn as it is typed when it is on screen beside the text, else
        // when it is next shown.
        if (showsSheet(currentMode)) redrawAfterTyping();
        else sheetNeedsRerender = true;
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
        if (await persist(nextTunes, nextTunes.length - 1)) setAbcMode(currentMode === 'sheet' ? 'text' : currentMode);
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
      // ── The stave's face of the cursor ───────────────────────────────────
      // Keeps the cursor's staff in the middle of what is visible of the
      // score — a fused set runs to several systems, and reading it meant
      // scrolling by hand while playing.
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

      /** The cursor line, made if the drawing has not got one yet — renderAbc
       *  replaces the SVG wholesale on every drawing. */
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
      // once per text. Every face reads it, and so does the player: the
      // stave's source and the box's are the same text (abcTextPlayback's
      // playableSource), so a position in one is a position in the other.
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

      // ── The stave's notes in time ─────────────────────────────────────────
      /** Every time a note is played, as abcjs times the DRAWING on screen:
       *  one event per pass round the repeats, in time order, each with where
       *  it sits on the page — read for the cursor, the flags and a tap. Never
       *  started: the player keeps time on its own engraving of the same text,
       *  matched to this one note for note (sheetEventOf). Empty until the
       *  stave is drawn. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sheetTimings: any[] = [];
      /** The drawing's tune, for the length of a note tapped. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let sheetVisual: any = null;
      /** The events of the note at `startChar` on the drawing, one per pass. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const passesOf = (startChar: number): any[] =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sheetTimings.filter((ev: any) => ev.type === 'event' && ev.left != null
          && Array.isArray(ev.startCharArray) && ev.startCharArray.includes(startChar));

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

      // ── The player ───────────────────────────────────────────────────────
      /** Opens the audio output before the first note needs it.
       *
       *  The cursor running ahead of the music on the FIRST play is the output
       *  itself arriving late: a browser opens the device's stream lazily, and
       *  the first sound of a page pays for it while the timer, counting in
       *  software, does not. Every play after that is already open, which is
       *  exactly the shape of what was reported.
       *
       *  One inaudible sample, once, at the first press — before the sound is
       *  made when it was not made ahead, which then gives the device the
       *  time to open. Silent, so it
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

      const player: AbcPlayer = createAbcPlayer(abcjs, {
        // The version on screen as it reads now — its edit, if any.
        source: () => readShown().ps,
        settings: () => ({ program: selectedProgram, transpose, metronome, swing, tempoPercent }),
        region: () => shownRegion(),
        looping: () => looping,
        beforeBuild: () => { stopTap(); warmAudioOutput(); },
        onState: (state) => {
          paintPlay(state);
          if (state === 'playing') claimAudioFocus(pauseForFocus);
          else if (state === 'idle') {
            releaseAudioFocus(pauseForFocus);
            // Stopped — the button, the end of the tune without the loop,
            // a keystroke: the cursor goes back to where play started, unless
            // the reader has put it somewhere since.
            if (playFrom && runGen === cursorGen) { cursorAt = playFrom.at; cursorPass = playFrom.pass; }
            playFrom = null;
            // Stopped by a keystroke, the next sound is of another text.
            prepareSound();
          }
          showCursor();
        },
        onNote: (ev, run) => {
          // The cursor is the note sounding — the music moving it, not the
          // reader: `cursorGen` stays.
          const char = ev.startCharArray?.[0];
          const at = typeof char === 'number' ? bodyIndex(run.ps, char) : null;
          if (at !== null) { cursorAt = at; cursorPass = passOf(run.timings, ev); }
          paintSheetCursor();
          if (showsText(currentMode)) lightText(noteRanges(run.ps, ev));
        },
      });
      /** Another app took the sound (Android app): as the pause button does. */
      const pauseForFocus = (): void => player.pause();

      // ── The sound made ahead (2026-11-04, the user) ──
      // So that play starts at once, as it did when abcjs's controller made
      // the sound with the drawing: made once things settle — the score
      // opened, a version changed, a setting changed, the music stopped —
      // and later after a keystroke, so that typing a set on the "both" face
      // does not pay for a whole performance at every pause. Not while the
      // audio sync or the Play-along has the score: theirs is the sound.
      let prepareTimer = 0;
      prepareSound = (delay = PREPARE_DELAY_MS) => {
        window.clearTimeout(prepareTimer);
        prepareTimer = window.setTimeout(() => {
          if (closed || audioSyncView || playAlongView) return;
          player.prepare();
        }, delay);
      };
      textarea.addEventListener('input', () => prepareSound(PREPARE_AFTER_TYPING_MS));

      /** Whether the music holds the cursor: playing, or paused and left where
       *  it stopped. */
      const musicHoldsCursor = (): boolean => {
        const state = player.state();
        return !!player.run()?.last && (state === 'playing' || (state === 'paused' && runGen === cursorGen));
      };

      /** The cursor as a note to play from, null for the start. */
      const cursorPlace = (): Place | null => {
        syncBounds();
        if (cursorAt === null) return null;
        const { ps, notes } = readShown();
        const note = boundNote(notes, sourceIndex(ps, cursorAt), 'in');
        return note ? { char: note.start, pass: cursorPass } : null;
      };

      /** The reader moved the cursor, on either face. While the music runs it
       *  goes there too — it is the same cursor — when that note is inside
       *  the passage. */
      const moveCursor = (at: number | null, pass: number): void => {
        cursorAt = at;
        cursorPass = pass;
        cursorGen++;
        const state = player.state();
        if (state !== 'playing' && state !== 'paused') return;
        const place = cursorPlace();
        if (!place || !player.jump(place)) return;
        runGen = cursorGen;
        playFrom = { at, pass };
      };

      /** Play from the cursor: from its note when it is inside the passage,
       *  from the passage's start when it is not. */
      const startFromCursor = (): void => {
        syncBounds();
        playFrom = { at: cursorAt, pass: cursorPass };
        runGen = cursorGen;
        player.start(cursorPlace());
      };

      // ── The stave's face of the cursor, drawn ──
      /** The run's note on the stave's drawing: the same event, found at the
       *  same place in the list — the two timings are of the same text — and
       *  checked by its note; else looked up by its note and time round. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sheetEventOf = (ev: TimingEvent, run: PlayerRun): any | null => {
        const char = ev.startCharArray?.[0];
        const i = run.timings.indexOf(ev);
        const same = i >= 0 ? sheetTimings[i] : undefined;
        if (same && same.startCharArray?.[0] === char) return same;
        return typeof char === 'number' ? eventAt(sheetTimings as TimingEvent[], char, passOf(run.timings, ev)) : null;
      };
      /** What the stave's cursor stands on: the note sounding, while the music
       *  holds the cursor; else the cursor's own note, on its time round. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sheetCursorEvent = (): any | null => {
        const run = player.run();
        if (run?.last && musicHoldsCursor()) return sheetEventOf(run.last, run);
        syncBounds();
        if (cursorAt === null) return null;
        const { ps, notes } = readShown();
        const note = boundNote(notes, sourceIndex(ps, cursorAt), 'in');
        if (!note) return null;
        const passes = passesOf(note.start);
        return passes[Math.min(cursorPass, passes.length - 1)] ?? null;
      };
      /** The cursor line before its note, the note lit, its system brought
       *  into view — or nothing, at the start. */
      const paintSheetCursor = (): void => {
        if (!showsSheet(currentMode) || sheetNeedsRerender || !notation.querySelector('svg')) return;
        const ev = sheetCursorEvent();
        // The second half of a tie across a bar line: no place of its own on
        // the page, the cursor stays where it was.
        if (ev && ev.left == null) return;
        notation.querySelectorAll('.abcjs-highlight').forEach(el => el.classList.remove('abcjs-highlight'));
        const cursor = ensureCursor();
        if (!cursor) return;
        if (!ev) {
          cursor.setAttribute('x1', '0'); cursor.setAttribute('x2', '0');
          cursor.setAttribute('y1', '0'); cursor.setAttribute('y2', '0');
          lastCursorTop = null;
          return;
        }
        for (const note of ev.elements ?? []) {
          for (const el of note) el.classList.add('abcjs-highlight');
        }
        cursor.setAttribute('x1', String(ev.left - 2));
        cursor.setAttribute('x2', String(ev.left - 2));
        cursor.setAttribute('y1', String(ev.top));
        cursor.setAttribute('y2', String(ev.top + ev.height));
        followCursor(ev);
      };

      // ── A note tapped on the stave ──
      /** Which time round a note tapped means: the one nearest where the music
       *  is now — a bar tapped during the second time through means that bar,
       *  this time round (reported 2026-09-21: every tap went back to the
       *  first). Stopped, the first. */
      const passNear = (char: number): number => {
        const run = player.run();
        if (!run?.last) return 0;
        const now = run.last.milliseconds;
        let best = 0, bestD = Infinity, pass = 0;
        for (const ev of run.timings) {
          if (!isNote(ev) || ev.startCharArray[0] !== char) continue;
          const d = Math.abs(ev.milliseconds - now);
          if (d < bestD) { bestD = d; best = pass; }
          pass++;
        }
        return best;
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
        // One box per note (the passes of a repeat share one), grouped by
        // the system it is drawn on.
        const seen = new Set<number>();
        const notes: { startChar: number; line: number; box: DOMRect }[] = [];
        for (const ev of sheetTimings) {
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
        const at = boxPosition(startChar);
        if (at === null) return;
        // Read before the move, which may send the music there.
        const playing = player.state() === 'playing';
        // The cursor only: the passage changes through its own buttons alone
        // (the user, 2026-10-15) — this used to set a bookmark too.
        moveCursor(at, passNear(startChar));
        // The same cursor in the text: the caret onto the note.
        placeCaret();
        showCursor();
        // Heard only while the music is stopped: playing, the tap already
        // means "from here", and the tune goes on from that very note.
        if (!playing && tapPlaysNote(appState.value)) {
          const ev = passesOf(startChar)[0];
          if (!ev?.midiPitches?.length || !sheetVisual) return;
          // One event holds every voice sounding at that moment; the note
          // tapped is the one written at this place.
          const pitches = (ev.midiPitches as (MidiPitch & { startChar?: number })[])
            .filter(p => p.startChar === undefined || p.startChar === startChar);
          unlockAbcjsAudio();
          playTap(abcjs, tapTracks(pitches, ev.midiGraceNotePitches, secondsPerWhole(sheetVisual, tempoPercent), selectedProgram));
        }
      };
      notation.addEventListener('pointerup', onScoreTap);

      const engraveWidth = (): number => engraveWidthOf(scoreScroll);

      const scoreMeasure: { measure: ScoreMeasure | null } = { measure: null };
      const renderTune = (index: number) => {
        const ink = ABC_PAPERS[paper].ink;
        const source = injectDefaultTempo(stripForRender(shownBlock(index)));
        lastEngravedWidth = engraveWidth();
        // The drawing is replaced wholesale — on the "both" face at every
        // pause in the typing: the reader's place in it is kept.
        const scrollTop = scoreScroll.scrollTop;
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
        scoreScroll.scrollTop = scrollTop;
        // The metre can change from one version of a file to the next, and it
        // is the metre that decides whether the swing does anything at all.
        updateSwing();

        lastCursorTop = null;
        sheetVisual = visualObj?.[0] ?? null;
        sheetTimings = [];
        if (sheetVisual) {
          // The notes' pitches first, which the timeline's events then carry
          // (`midiPitches`) for a tap to be heard — in the key drawn, on the
          // instrument chosen. `midiTranspose` as the player passes it: the
          // drawing's `visualTranspose` alone is subtracted back out of the
          // sound. Nothing is played: it only builds the note sequence.
          try {
            sheetVisual.setUpAudio({
              ...(selectedProgram !== undefined ? { program: selectedProgram } : {}),
              ...(transpose !== 0 ? { midiTranspose: transpose } : {}),
            });
          } catch { /* no pitches: a tapped note is silent */ }
          try { sheetTimings = new abcjs.TimingCallbacks(sheetVisual, {}).noteTimings; } catch { /* nothing to time */ }
        }
        drawBoundFlags();
        paintSheetCursor();
      };

      doRenderTune = renderTune;

      // ── The text's face of the cursor ─────────────────────────────────────
      // The note the caret is on — or the one clicked: the caret lands on the
      // nearest gap between two characters, so a click on the right half of
      // a `d` puts it AFTER the `d`, before the next note. The note meant is
      // the character under the finger: of the two around the caret, the one
      // whose box holds the click, measured on the layer behind the box,
      // which lays out the very same text. Remembered for as long as the
      // caret stays where that click put it.
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
      /** The caret moved by the reader since it was last seen: the cursor goes
       *  onto its note — a selection's first — on the first time round. True
       *  when it moved. */
      const readCaret = (): boolean => {
        const key = caretKey();
        if (key === lastCaretKey) return false;
        lastCaretKey = key;
        const { ps } = readShown();
        const note = textCursorNote();
        moveCursor(note ? bodyIndex(ps, note.start) : null, 0);
        return true;
      };

      /** The passage's marks in the text, from the bounds as they now stand. */
      const markTextBounds = () => {
        const region = shownRegion();
        const { ps } = readShown();
        textBoundMarks = {
          in: region?.first ? boxRange(ps, region.first.start, region.first.end) : null,
          out: region?.last ? boxRange(ps, region.last.start, region.last.end) : null,
        };
      };
      /** The cursor's note in the text — none at the start, as on the stave
       *  (the user, 2026-11-04: the stave was right). The text used to mark
       *  the note play would begin on, which put a bar on every score opened
       *  and never played, and on one face only. */
      const cursorRange = (): [number, number] | null => {
        syncBounds();
        if (cursorAt === null) return null;
        const { ps, notes } = readShown();
        const note = boundNote(notes, sourceIndex(ps, cursorAt), 'in');
        return note ? boxRange(ps, note.start, note.end) : null;
      };
      /** The bar on the note sounding while the music holds the cursor, else
       *  on the cursor's note; and the passage's marks. */
      const refreshTextPreview = () => {
        if (!showsText(currentMode)) return;
        // The caret first: moved, it moves the cursor — on the stave too.
        if (readCaret()) paintSheetCursor();
        markTextBounds();
        const run = player.run();
        if (player.state() === 'loading') { paintText(); return; }
        if (run?.last && musicHoldsCursor()) {
          textCurrent = noteRanges(run.ps, run.last);
          setTextHints({ start: null });
          return;
        }
        textCurrent = [];
        setTextHints({ start: cursorRange() });
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

      showCursor = () => {
        paintSheetCursor();
        schedulePreview();
      };

      // ── The passage: set here, drawn on both faces ──
      setBoundHere = (side) => {
        syncBounds();
        // Where "here" is: the note sounding while the music holds the
        // cursor, else the cursor's note — or, on a face showing the text, a
        // selection: its first note for the start, its last for the end.
        let at = cursorAt;
        const a = textarea.selectionStart, b = textarea.selectionEnd;
        if (!musicHoldsCursor() && showsText(currentMode) && b > a) {
          const { ps, notes } = readShown();
          const across = notesAcross(notes, sourceIndex(ps, a), sourceIndex(ps, b));
          at = across ? bodyIndex(ps, (side === 'in' ? across.first : across.last).start) : null;
        }
        // An end at the start of the tune would hold nothing.
        if (at === null && side === 'out') return;
        bounds = setBound(bounds, side, at);
        boundsChanged();
      };
      redrawBounds = () => {
        drawBoundFlags();
        refreshTextPreview();
      };

      // ── A note clicked in the text, heard ──
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
        // At once rather than at the next frame: a click while the music
        // plays sends it to the note clicked (asked 2026-10-24) — between two
        // notes, to the next one, as it would start from there.
        refreshTextPreview();
        if (index === undefined) return;
        const state = player.state();
        if (!showsText(currentMode) || state === 'playing' || state === 'loading') return;
        if (!tapPlaysNote(appState.value)) return;
        const xLine = splitXLine(tunes[currentIndex] ?? '').xLine;
        const key = `${transpose}|${selectedProgram ?? ''}|${xLine}\n${text}`;
        if (key !== tapKey) {
          tapKey = key;
          tapPs = playableSource(xLine, text);
          tapTune = null;
          try {
            const tune = abcjs.parseOnly(tapPs.source)[0];
            // As the player builds it, so that the pitch is the one play gives.
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

      // ── The transport ──
      transport = {
        playPause: () => {
          const state = player.state();
          if (state === 'idle') startFromCursor();
          else if (state === 'loading') player.stop();
          else if (state === 'playing') player.pause();
          // Paused, then the cursor moved: play means from THERE (reported
          // 2026-10-15 — it resumed where it was). Left where it stopped, it
          // resumes.
          else if (runGen !== cursorGen) startFromCursor();
          else player.resume();
        },
        // Back to the start of the passage, playing or not, without stopping —
        // stopped, the cursor goes there, as it would have gone playing.
        rewind: () => {
          if (player.state() !== 'idle') { player.rewind(); return; }
          const first = shownRegion()?.first;
          moveCursor(first ? boxPosition(first.start) : null, 0);
          placeCaret();
          showCursor();
        },
        stop: () => player.stop(),
        // The same note, the same time round — rebuilt.
        retime: () => { player.retime(); prepareSound(); },
      };
      // Space toggles playback, the way it does in every player.
      //
      // Ignored while a field or a button has focus: a button already answers
      // the space bar by activating itself — including the play button, which
      // gives the same result by its own route — and swallowing the key inside
      // the ABC text editor would make it impossible to type.
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
        // The audio sync's player has the key (syncedScore.tsx); the
        // Play-along plays nothing to pause.
        if (audioSyncView || playAlongView) return;
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || active?.isContentEditable) return;
        e.preventDefault(); // or the page scrolls under the modal
        unlockAbcjsAudio();
        transport.playPause();
      };
      document.addEventListener('keydown', onKeyDown);
      releaseKeys = () => document.removeEventListener('keydown', onKeyDown);

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
      //
      // Only the drawing: the music has a player of its own, which a redraw
      // leaves playing where it was.
      redrawScore = () => {
        if (!showsSheet(currentMode)) { sheetNeedsRerender = true; return; }
        renderTune(currentIndex);
      };
      // On the "both" face, the stave follows the typing once it pauses —
      // engraving a set at every keystroke would make the caret stutter.
      // Stale meanwhile, and marked so: the cursor waits for the new drawing
      // rather than being put on the old one's notes.
      let typingTimer = 0;
      redrawAfterTyping = () => {
        sheetNeedsRerender = true;
        window.clearTimeout(typingTimer);
        typingTimer = window.setTimeout(() => {
          if (!showsSheet(currentMode) || !sheetNeedsRerender) return;
          sheetNeedsRerender = false;
          renderTune(currentIndex);
        }, TYPING_REDRAW_MS);
      };

      // What abcjs makes of the text as it is typed — the warnings, and nothing
      // drawn. `parseOnly` does the reading without the engraving, which is the
      // whole cost of this: no SVG, no layout, no second score on screen.
      checkWarnings = () => {
        const marked = textWarnMarks.length > 0;
        textWarnMarks = [];
        if (!showsText(currentMode) || !showAbcSyntaxCheck(appState.value)) {
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
      releaseKeys = () => { stopWarnTimer(); window.clearTimeout(warnTimer); window.clearTimeout(typingTimer); };
      remeasure = () => {
        // The line between the faces held: engraved once it is let go.
        if (faceSplit.splitting() || !showsSheet(currentMode) || !notation.querySelector('svg')) return;
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
      // The player goes with the dialog too.
      const stopWithPlayer = releaseKeys;
      releaseKeys = () => {
        stopWithPlayer();
        // Stopped, and the sound made ahead let go of.
        window.clearTimeout(prepareTimer);
        player.dispose();
        document.removeEventListener('selectionchange', onSelectionChange);
        cancelAnimationFrame(previewRaf);
      };

      // Changing instrument without losing your place: the stave redrawn —
      // the paper is set in that dialog too — and the music rebuilt at the
      // same note.
      reapplyAbcPrefs = () => {
        selectedProgram = appState.value.abcInstrument;
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
          redrawScore();
          transport.retime();
        }
      };
      // Only if the stave is on screen. Drawing into a display:none container
      // is exactly what `sheetNeedsRerender` exists to avoid (abcjs's resize
      // handling makes the SVG reflow visibly when it reappears), and someone
      // who opens on the source may never look at the notation at all.
      if (showsSheet(currentMode)) renderTune(currentIndex);
      else sheetNeedsRerender = true;
      showCursor();
      prepareSound();
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
