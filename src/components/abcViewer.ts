import LZString from 'lz-string';
import type { AbcPaper, ScoreFace } from '../types';
import { sanitizeEmphasisOnly } from './markdown';
import { qualityColour, faded } from './followColour';
import { keyGapText } from '../session/keyName';
import {
  starIconElement, iconElement, TrashIcon, PlusIcon, SaveIcon, ExpandIcon, CollapseIcon,
  MetronomeIcon, TuningForkIcon, WarningTriangleIcon, ChevronDownIcon, WaveformIcon, CloudIcon, ArrowLeftIcon, ArrowRightIcon, MicIcon, MusicNoteIcon,
  MinusIcon, CrossIcon, PencilIcon
} from './icons';
import { t } from '../services/i18nService';
import { unlockAbcjsAudio, claimAudioFocus, releaseAudioFocus } from '../services/audioSession';
import {
  injectDefaultTempo, stripForRender, decodeAbc, splitAbcTunes, parseAbcBlock, abcOpenMode,
  showAbcSyntaxCheck, suggestPlayedVersion, blankForRender, locateAbcWarning, abcWarningRange,
  abcPaper, abcSwingAtOpen, meterCanSwing, ABC_PAPERS
} from '../services/abcService';
import { engraveScore, type ScoreMeasure } from '../services/abcLineBreaks';
import { ENGRAVE_HYSTERESIS, engraveOptions, engraveWidthOf, cropToInk } from './scoreEngraving';
import { getZoom } from '../services/zoomService';
import {
  playableSource, sourceIndex, noteRanges, passOf, eventAt, isNote,
  notesOf, startNoteAt, boxRange, bodyIndex, type ParsedNote, type PlayableSource, type TimingEvent,
} from '../services/abcTextPlayback';
import { createAbcPlayer, type AbcPlayer, type PlayState, type Place, type PlayerRun } from './abcPlayer';
import { bindFaceSplit } from './faceSplit';
import { rangeInSource, posInDrawn, type ScoreEditor } from './scoreEditor';
import { tapTracks, tappedNote, secondsPerWhole, playTap, stopTap, tapPlaysNote, type MidiPitch } from '../services/abcTapNote';
import { shiftPosition, boundNote, notesAcross, regionOf, setBound, type Bounds } from '../services/abcBounds';
import { showModal, setModalMaxWidth, confirmModal, askUnsavedChanges } from './modal';
import { playIcon, pauseIcon, stopIcon, rewindIcon, repeatIcon, boundIcon } from './playbackIcons';
import { appState } from '../store';
import { mountPlayAlong } from '../session/ui/PlayAlongView';
import {
  DEFAULT_TEMPO_PERCENT, MIN_TEMPO_PERCENT, MAX_TEMPO_PERCENT, TEMPO_STEP_PERCENT, abcTempoPercent, mkSwingButton
} from './abcPlaybackPrefs';
import { showTransposeModal } from './abcTransposeModal';
import { readingPage } from './readingPage';
import { bindLongPress } from './longPress';
import {
  BOTH_FACES_WIDTH, modalWidth,
  type AudioSyncState, type AudioSyncView, type PlayAlongView, type ViewerContext,
} from './viewerShared';

// ── A score in the file viewer ────────────────────────────────────────────────
// The stave and its ABC, their versions, the transport, the passage and the
// cursor, the editor; and the recording or the microphone that can take the
// score's place (the audio sync, the Play-along). Out of fileViewer.ts since
// 2026-11-26, where it was one branch of a 4 000-line function.

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
 *  Not stuck any more since 2026-11-20 (BOTTOM_BLOCK_CLASS): the viewer is a
 *  column whose middle, the score, is the only thing that scrolls — the
 *  bottom stays where it is by being below it. */
const TRANSPORT_CLASS = 'abc-transport flex items-center justify-center gap-2 flex-wrap';
/** The bottom row: the transport, alone on it since 2026-11-20 — the source
 *  face's version buttons and Save, on its sides from 2026-10-15, went to the
 *  versions' box and the text's frame (`.abc-bottom-row` in styles.css). */
const BOTTOM_ROW_CLASS = 'abc-bottom-row';
/** The source tabs (who plays the score) over the bottom row: the foot of the
 *  viewer's column, its own height. */
const BOTTOM_BLOCK_CLASS = 'shrink-0 flex flex-col gap-2';

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

/** How long the typing pauses before the edit is aligned anew on the
 *  recording, under the audio sync (N3b): longer than the redraw — an
 *  alignment is a second or more of work, started over by each keystroke. */
const REALIGN_AFTER_TYPING_MS = 700;

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

/** Which faces a face shows. */
const showsSheet = (face: ScoreFace): boolean => face !== 'text';
const showsText = (face: ScoreFace): boolean => face !== 'sheet';

/** Room the versions' arrows need beyond their own width to widen again once
 *  they were narrowed (fitTopRow). */
const ROW_SLACK_PX = 8;

/** The narrowest the editor's "+", Save and bin get (fitTopRow): the arrows'
 *  own narrow width (.abc-nav-narrow, 1.25rem). */
const EDIT_MIN_PX = 20;

/** Where the key gap and its fork go in the audio sync's short name: a text
 *  for the translation, an icon in the tab. */
const GAP_MARK = '\u0001';

/** What abcjs brings once it has loaded: the stave, its sound and the cursor
 *  on both faces. Built in one go, at the end of the load, and null until
 *  then — a press, a resize or a keystroke that lands before it acts on a
 *  score that is not on screen yet, so does nothing (or, for the drawing,
 *  marks it to be done). Until 2026-11-26 each was a function declared empty
 *  and filled in later, sixteen of them. */
interface ScoreEngine {
  /** Draws a version on the stave. */
  renderTune: (index: number) => void;
  /** The drawing redone for a change to the drawing itself (the key, the
   *  paper) — or marked to be, when the stave is not on screen. */
  redrawScore: () => void;
  /** The stave redrawn once the typing pauses, on the "both" face. */
  redrawAfterTyping: () => void;
  /** Re-engraves for the box the score is in NOW, keeping the reader's place
   *  and whatever is playing. */
  remeasure: () => void;
  /** The sound of the tune made ahead of the next press, once things
   *  settle. */
  prepareSound: (delay?: number) => void;
  /** Re-reads the editor's text and refreshes the warning strip. */
  checkWarnings: () => void;
  /** Re-marks the cursor in the text, at the next frame. */
  previewText: () => void;
  /** The cursor drawn again on every face on screen. */
  showCursor: () => void;
  /** A bound set at the cursor — what is "here" needs the notes. */
  setBoundHere: (side: 'in' | 'out') => void;
  /** Flags and marks drawn again. */
  redrawBounds: () => void;
  /** What the play buttons do. `retime`: a setting changed — picks up at the
   *  same note, rebuilt. */
  transport: { playPause: () => void; rewind: () => void; stop: () => void; retime: () => void };
}

export function mountAbcViewer(ctx: ViewerContext): void {
  const { entry, body, opts, save } = ctx;
  body.classList.replace('items-center', 'items-start');
  /** See ScoreEngine: null until abcjs has loaded. */
  let engine: ScoreEngine | null = null;
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
  // Save where the opening is the editor's own (PreviewModalOpts.initialFace).
  let currentMode: ScoreFace = opts?.initialFace === 'both' && save ? 'both' : abcOpenMode(appState.value);
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
  //
  // A column of three (2026-11-20, the user): the faces, the versions and the
  // editing tools above; the stave and/or its text in the middle; what plays
  // and its controls below. The middle takes whatever the two others leave
  // of the dialog's height (showModal's `fill`) and is the only thing that
  // scrolls — where the dialog body used to scroll as a whole, the score
  // capped at a share of the screen guessed beforehand (capScore), the
  // controls stuck over its foot (sticky), a cursor going under them.
  container.className = 'abc-viewer w-full flex-1 min-h-0 flex flex-col gap-3';
  // The dialog's body, a column too, for the viewer to fill.
  body.className = 'w-full flex-1 min-h-0 flex flex-col';

  // ── Top row: Sheet/ABC tabs + version nav ──
  // Never wrapped (2026-11-01, the user): the versions' arrows give up their
  // width when it is short (`fitTopRow`). The audio sync's and the
  // Play-along's toggles were at its end until 2026-11-20; they are the
  // source tabs over the transport now (below).
  const topRow = document.createElement('div');
  topRow.className = 'shrink-0 flex items-center justify-between gap-2 flex-nowrap';

  const tabBar = document.createElement('div');
  tabBar.className = 'seg seg-lg w-fit shrink-0';
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
    // Tight tracking: at the 11 px floor (it was 9) the row of faces grew by
    // 7 px and pushed the Play-along toggle off a 390 px phone's edge.
    g.className = 'text-2xs font-mono font-bold leading-none tracking-tighter';
    g.textContent = 'ABC';
    return g;
  };
  const abcGlyph = mkAbcGlyph();
  // The stave and its text at once (2026-11-04, the user), to write ABC
  // while reading what it says — what the tester switched to abcTools for.
  // The editor, then (2026-11-20, the user): a pencil, where it was the two
  // others' icons with a "+" between them; and the only face the text is
  // written on. None where nothing can save it.
  const sheetTabBtn = mkAbcTab(t('fileViewer.abc.sheetTab'), iconElement(MusicNoteIcon, 14));
  const textTabBtn  = mkAbcTab(t('fileViewer.abc.textTab'), abcGlyph);
  const bothTabBtn  = mkAbcTab(t('fileViewer.abc.bothTab'), iconElement(PencilIcon, 14));
  sheetTabBtn.onclick = () => chooseMode('sheet');
  textTabBtn.onclick  = () => chooseMode('text');
  // A score written elsewhere asks first (PreviewModalOpts.editGate).
  const editGate = save ? undefined : opts?.editGate;
  // Its audio sync handed over with it when it is on: the copy is opened to
  // be corrected along the recording (2026-11-23, the user).
  bothTabBtn.onclick  = () => (editGate
    ? editGate(currentIndex, audioSyncView && audioSync ? { binding: audioSync, forced: audioSyncForced } : undefined)
    : chooseMode('both'));
  tabBar.append(sheetTabBtn, textTabBtn);
  if (save || editGate) tabBar.appendChild(bothTabBtn);
  tabBar.dataset.tour = 'abc-tabs';

  const versionNav = document.createElement('div');
  versionNav.className = `flex items-center gap-1 p-1 bg-bg rounded-lg w-fit ${versionCount <= 1 ? 'hidden' : ''}`;
  const mkNavBtn = (icon: typeof ArrowLeftIcon, label: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.append(iconElement(icon, 16));
    b.setAttribute('aria-label', label);
    b.title = label;
    b.className = 'abc-tool-btn text-xs font-medium text-muted hover:text-primary hover:bg-elevated disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted';
    return b;
  };
  const prevBtn = mkNavBtn(ArrowLeftIcon, t('fileViewer.abc.prevVersion'));
  const versionLabel = document.createElement('span');
  versionLabel.className = 'px-1 text-xs font-medium text-muted tabular-nums';
  const nextBtn = mkNavBtn(ArrowRightIcon, t('fileViewer.abc.nextVersion'));
  // Leaving a version with an edit pending asks first — see `draft`.
  prevBtn.onclick = () => settleDraft(() => goToVersion(currentIndex - 1));
  nextBtn.onclick = () => settleDraft(() => goToVersion(currentIndex + 1));
  // ── Adding / deleting a version ───────────────────────────────────────────
  // In the versions' box since 2026-11-20 (the user), where they were on the
  // bottom row beside the transport: a version added after the last arrow,
  // deleted after the star. On the source face only, and only when the
  // caller passed a save callback (`paintVersionNav`).
  const mkEditBtn = (icon: Element, title: string, danger: boolean): HTMLButtonElement => {
    const b = document.createElement('button');
    b.appendChild(icon);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.className = `abc-tool-btn text-muted hover:bg-elevated ${danger ? 'hover:text-danger' : 'hover:text-primary'}`;
    return b;
  };
  const addVersionBtn = mkEditBtn(iconElement(PlusIcon, 14), t('fileViewer.abc.addVersion'), false);
  const deleteVersionBtn = mkEditBtn(iconElement(TrashIcon, 14), t('fileViewer.abc.deleteVersion'), true);
  // ── Save, between the two (2026-11-20, the user) ──
  // It was a button on the bottom row beside the transport, then for a day
  // an icon in the text's corner shown only with an edit pending: here,
  // always there on the editor's face, muted when there is nothing to save —
  // which also says a save went through. A failed one turns it red, the
  // reason in its tooltip, until the next keystroke.
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.setAttribute('aria-label', t('fileViewer.abc.save'));
  saveBtn.appendChild(iconElement(SaveIcon, 14));
  saveBtn.disabled = true;
  let saveFailed = false;
  const paintSave = (): void => {
    saveBtn.style.display = editsText() ? '' : 'none';
    const look = saveFailed ? 'text-danger hover:bg-elevated'
      : 'text-accent hover:bg-elevated disabled:text-muted disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent';
    // Narrowed or not by the row (setEditWidth), as it was.
    const narrow = saveBtn.classList.contains('abc-nav-narrow');
    saveBtn.className = `abc-tool-btn ${look}${narrow ? ' abc-nav-narrow' : ''}`;
    saveBtn.title = saveFailed ? t('fileViewer.saveFailed') : t('fileViewer.abc.save');
  };
  versionNav.append(prevBtn, versionLabel, nextBtn, addVersionBtn, saveBtn, deleteVersionBtn);
  versionNav.dataset.tour = 'abc-versions';

  // ★ "set as default version" — independent of saving, works read-only too
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
  ctx.hooks.openInAbcTools = () => { window.open(abcToolsShareUrl(shownBlock(currentIndex)), '_blank', 'noopener,noreferrer'); };

  // ── What is left in the row ──────────────────────────────────────────────
  // The paper and the bars per line lived here until the user moved them
  // (2026-09-21): they are set once and then left alone for months, which is
  // what the gear is for. The way out to abcTools went to the header and the
  // full page onto the score itself (2026-10-10), so the row is the tabs and
  // the versions.
  topRow.append(tabBar, versionNav);
  container.appendChild(topRow);

  // ── Who plays the score: tabs (2026-11-20, the user) ─────────────────────
  // The synth, the recording (audio sync) or the one playing (Play-along):
  // one score, one cursor, so one of the three — tabs, where they were two
  // toggles at the end of the row above, which on a phone shrank to a bare
  // microphone nobody knew to press ("far from intuitive", for what a tester
  // uses most — Bédou, 2026-11-16). They choose what plays, not what the ABC
  // says: down with the playing, just above whatever plays — the transport,
  // and in the other two their player or their bar, whose views give them a
  // place under the score (`below`). Named always; a way that cannot play
  // this score is greyed, and says why when pressed. None on a set's score
  // (`sources: false`, the user): the synth alone, as before.
  const sourcesOn = opts?.sources !== false;
  const sourceRow = document.createElement('div');
  // One line always (styles.css, .abc-sources-row): the full names while
  // they fit, else short ones — Synth, Audio, Play, and the audio sync's
  // figure beside "Audio" when it is the one on (2026-11-20, the user). A phone's
  // French names with that figure were cut short on one line, and stood
  // icon over name in three shares for a day.
  sourceRow.className = 'abc-sources-row flex justify-center min-w-0';
  const sourceSeg = document.createElement('div');
  sourceSeg.className = 'seg seg-lg max-w-full';
  sourceSeg.setAttribute('role', 'group');
  sourceSeg.setAttribute('aria-label', t('fileViewer.abc.sources'));
  sourceSeg.dataset.tour = 'abc-sources';
  sourceRow.appendChild(sourceSeg);
  /** The names the row has room for, measured (styles.css): full; else
   *  short (`abc-sources-short`); else short without the audio sync's key
   *  gap (`abc-sources-tight`). Measured, not a width in CSS: the audio
   *  sync's full name runs from "Audio sync" to "Audio sync (83 %, 1
   *  semitone up)". A level given back only with a few pixels to spare;
   *  the row's own width, which the names cannot change, is what is watched. */
  let sourcesLevel = 0;
  const fitSources = (): void => {
    const room = sourceRow.clientWidth;
    if (!room) return;
    const was = sourcesLevel;
    const fits = (level: number): boolean => sourceSeg.scrollWidth + (level < was ? ROW_SLACK_PX : 0) <= room;
    sourceRow.classList.remove('abc-sources-short', 'abc-sources-tight');
    sourcesLevel = 0;
    if (fits(0)) return;
    sourceRow.classList.add('abc-sources-short');
    sourcesLevel = 1;
    if (fits(1)) return;
    sourceRow.classList.add('abc-sources-tight');
    sourcesLevel = 2;
  };
  const sourcesWatch = new ResizeObserver(() => fitSources());
  sourcesWatch.observe(sourceRow);
  /** A tab's look: on, off, or greyed — `colour`, the audio sync's quality,
   *  overriding the accent once its alignment is in. */
  const paintSourceTab = (btn: HTMLElement, on: boolean, usable: boolean): void => {
    btn.className = `seg-btn abc-source${on ? ' seg-btn-on' : ''}${usable ? '' : ' opacity-40'}`;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-disabled', String(!usable));
  };
  /** A tab's name, full and short, the stylesheet showing one of the two. */
  const mkSourceLabel = (): { el: HTMLSpanElement; full: HTMLSpanElement; short: HTMLSpanElement } => {
    const el = document.createElement('span');
    const full = document.createElement('span');
    full.className = 'abc-source-full';
    const short = document.createElement('span');
    short.className = 'abc-source-short';
    el.append(full, short);
    return { el, full, short };
  };
  /** Why a way cannot play this score, said when its greyed tab is pressed. */
  const explainSource = (title: string, why: string): void => {
    const body = document.createElement('p');
    body.className = 'text-sm text-muted leading-relaxed';
    body.textContent = why;
    showModal(title, body, []);
  };
  const synthTab = document.createElement('button');
  synthTab.type = 'button';
  const synthLabel = mkSourceLabel();
  synthLabel.full.textContent = t('fileViewer.abc.source.synth');
  synthLabel.short.textContent = t('fileViewer.abc.source.synth.short');
  synthTab.setAttribute('aria-label', t('fileViewer.abc.source.synth'));
  synthTab.append(iconElement(MusicNoteIcon, 14), synthLabel.el);
  synthTab.title = t('fileViewer.abc.source.synth.hint');
  sourceSeg.appendChild(synthTab);
  // ── The viewer's place, lent ─────────────────────────────────────────────
  // The audio sync and the Play-along each take the viewer's place under the
  // top row — the middle of the column (their score, filling it) and its foot
  // (their player, their bar) — and give it back as it was. One at a time:
  // one score, one cursor. The dialog keeps its size — it has its full height
  // whatever it holds (showModal's `fill`), where until 2026-11-20 the
  // Play-along was laid over the hidden viewer at a height held for it
  // (2026-11-01, the user: it shrank on turning on, grew on turning off).
  // One lending for both since 2026-11-26: each did it with a copy of its own.
  let audioSyncView: AudioSyncView | null = null;
  let playAlongView: PlayAlongView | null = null;
  /** Whichever of the two has the viewer's place. */
  const takenOver = (): AudioSyncView | PlayAlongView | null => audioSyncView ?? playAlongView;
  /** The place lent: the host it fills, and what was hidden for it, with how
   *  each was shown, to put back. */
  let lent: { host: HTMLElement; hidden: Array<[HTMLElement, string]> } | null = null;
  /** The viewer's place handed over: the score's own sound stopped for good,
   *  its full page left, everything under the top row hidden, and a host in
   *  their place. */
  const lendViewer = (): HTMLElement => {
    stopPlay();
    page.exit();
    const hidden = Array.from(container.children)
      .filter((el): el is HTMLElement => el instanceof HTMLElement && el !== topRow)
      .map((el): [HTMLElement, string] => [el, el.style.display]);
    for (const [el] of hidden) el.style.display = 'none';
    const host = document.createElement('div');
    host.className = 'flex-1 min-h-0 flex flex-col';
    container.appendChild(host);
    lent = { host, hidden };
    return host;
  };
  /** And taken back: the source tabs home, everything shown as it was, and
   *  everything the face decides decided again — the stave redrawn, as a
   *  version changed meanwhile was drawn into a hidden box. */
  const reclaimViewer = (): void => {
    if (!lent) return;
    lent.host.remove();
    homeSources();
    for (const [el, display] of lent.hidden) el.style.display = display;
    lent = null;
    sheetNeedsRerender = true;
    setAbcMode(currentMode);
  };
  // Whichever has the place goes with the dialog: its player, or the
  // microphone.
  ctx.whenClosed(() => {
    audioSyncView?.unmount();
    audioSyncView = null;
    playAlongView?.unmount();
    playAlongView = null;
  });
  /** The synth's tab: on whenever neither of the other two is. */
  const paintSynthTab = (): void => paintSourceTab(synthTab, !takenOver(), true);

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
  const audioSync = opts?.audioSyncCarry?.binding ?? opts?.audioSync;
  // Its tab is there with or without a recording: greyed without, saying
  // where one comes from.
  const audioSyncBtn = sourcesOn ? document.createElement('button') : null;
  /** Whether the version on screen can be played along its recording. */
  const audioSyncUsable = (): boolean => !!audioSync && audioSync.plays(shownBlock(currentIndex));
  /** How the alignment of the version on screen stands: the toggle shows it
   *  (AudioSyncState) instead of anything over the score. Kept when the
   *  toggle is turned off once it is known — the alignment is still the
   *  same — and dropped with the version. */
  let audioSyncState: AudioSyncState | null = null;
  const paintAudioSync = (): void => {
    paintSynthTab();
    if (!audioSyncBtn) return;
    const on = !!audioSyncView;
    if (!audioSync) {
      paintSourceTab(audioSyncBtn, false, false);
      audioSyncLabel.full.textContent = t('fileViewer.abc.audioSync');
      audioSyncLabel.short.textContent = t('fileViewer.abc.audioSync.short');
      audioSyncBtn.setAttribute('aria-label', t('fileViewer.abc.audioSync'));
      audioSyncBtn.title = t('fileViewer.abc.audioSync.hint');
      return;
    }
    const s = audioSyncState;
    // Once the alignment is in: the quality's colour, continuous — the
    // waveform's tint uses the same scale — on the tab's text, and under it
    // when it is the one on, in place of the accent.
    const colour = !s || s.kind === 'aligning' ? null
      : s.percent !== undefined ? qualityColour(s.percent / 100) : 'var(--color-danger)';
    // While it aligns, the tab is its progress bar (below): in the accent,
    // over no fill of its own.
    const aligning = s?.kind === 'aligning';
    paintSourceTab(audioSyncBtn, on && !colour && !aligning, audioSyncUsable());
    audioSyncBtn.style.color = colour ?? (aligning ? 'var(--color-accent)' : '');
    audioSyncBtn.style.backgroundColor = colour && on ? faded(colour, 0.18) : '';
    // The toggle as a progress bar while the alignment is made: filled from
    // the left as far as it has gone.
    if (s?.kind === 'aligning') {
      const p = Math.round(s.ratio * 100);
      audioSyncBtn.style.backgroundImage = `linear-gradient(to right, color-mix(in srgb, var(--color-accent) 22%, transparent) ${p}%, transparent ${p}%)`;
    } else {
      audioSyncBtn.style.backgroundImage = '';
    }
    // How well, in figures, on the toggle itself (2026-10-29, the user).
    const percent = s && s.kind !== 'aligning' ? s.percent : undefined;
    const gap = s && s.kind !== 'aligning' ? s.keyGap ?? 0 : 0;
    const label = percent === undefined
      ? t(s?.kind === 'aligning' && s.again ? 'fileViewer.abc.audioSync.realigning' : 'fileViewer.abc.audioSync')
      : gap !== 0
        ? t('fileViewer.abc.audioSync.percentKey', { percent, shift: keyGapText(gap) })
        : t('fileViewer.abc.audioSync.percent', { percent });
    audioSyncLabel.full.textContent = label;
    // Short: "Audio", with its figure while it is the one on and has one —
    // and the key the recording plays in, its semitones beside the
    // transposition's fork: "Audio (83 %, +1⑂)" (2026-11-20, the user). That
    // part is the first given up on the narrowest (.abc-source-extra).
    if (on && percent !== undefined && gap !== 0) {
      const extra = document.createElement('span');
      extra.className = 'abc-source-extra';
      extra.append(`, ${gap > 0 ? '+' : '−'}${Math.abs(gap)}`, iconElement(TuningForkIcon, 11));
      const [before, after] = t('fileViewer.abc.audioSync.percentKeyShort', { percent, gap: GAP_MARK }).split(GAP_MARK);
      audioSyncLabel.short.replaceChildren(before ?? '', extra, after ?? '');
    } else {
      audioSyncLabel.short.textContent = on && percent !== undefined
        ? t('fileViewer.abc.audioSync.percentShort', { percent })
        : t('fileViewer.abc.audioSync.short');
    }
    audioSyncBtn.setAttribute('aria-label', label);
    audioSyncBtn.title = s?.title ?? t(audioSync.fromDrive ? 'fileViewer.abc.audioSync.hintDrive' : 'fileViewer.abc.audioSync.hint');
    // Its name grew or shrank (its figure, its key gap): which names fit.
    fitSources();
  };
  const audioSyncLabel = mkSourceLabel();
  /** Puts the audio sync of the version on screen in the viewer's place — the
   *  source tabs with it, between its score and its player. */
  const mountAudioSync = (host: HTMLElement): void => {
    audioSyncState = null;
    audioSyncView = audioSync!.mount(host, shownBlock(currentIndex), currentMode, modalExpanded, (s) => {
      // Not once it is turned off: an alignment stopped half-way says nothing.
      if (!audioSyncView) return;
      audioSyncState = s;
      paintAudioSync();
    }, audioSyncForced, transpose, sourcesOn ? sourceRow : undefined, save ? syncEditor : undefined);
    lendEditor();
  };
  /** The hidden way round the verdict (2026-10-29, the user): a right click
   *  — a long press on a touch screen — follows the alignment even when it
   *  is judged too poor to be, turning the toggle on if it was off; the same
   *  gesture again gives the verdict back. The toggle stays red: the
   *  alignment is no better for being shown. Not advertised. */
  let audioSyncForced = false;
  const forceAudioSync = (): void => {
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
  const turnOnAudioSync = (asked: boolean): void => {
    // It takes the Play-along's place: a take in hand is asked about first.
    if (playAlongView?.settleTake(() => turnOnAudioSync(asked))) return;
    const forced = asked || !!audioSync?.forcedByDefault;
    if (!audioSync?.choose) {
      audioSyncForced = forced;
      setAudioSync(true);
      return;
    }
    if (choosing) return;
    choosing = true;
    void audioSync.choose(shownBlock(currentIndex)).then((ok) => {
      choosing = false;
      if (!ok || ctx.closed() || audioSyncView) return;
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
      // The middle and the foot of the column: its score over its player.
      mountAudioSync(lendViewer());
    } else {
      audioSyncView!.unmount();
      audioSyncView = null;
      // Turned off, it starts afresh: forced only by the gesture again.
      audioSyncForced = false;
      // An alignment stopped half-way is no alignment: the bar goes.
      if (audioSyncState?.kind === 'aligning') audioSyncState = null;
      homeEditor();
      reclaimViewer();
    }
    paintAudioSync();
  };
  /** Another version on screen: its audio sync, aligned anew under the same
   *  player — or none, for a version the binding cannot follow. */
  const versionChangedForAudioSync = (): void => {
    if (!audioSync) return;
    audioSyncState = null;
    if (audioSyncView) {
      if (audioSync.plays(shownBlock(currentIndex))) {
        audioSyncView.setVersion(shownBlock(currentIndex));
      } else {
        setAudioSync(false);
      }
    }
    paintAudioSync();
  };
  if (audioSyncBtn && !audioSync) {
    // No recording to follow: the tab says where one would come from.
    audioSyncBtn.type = 'button';
    audioSyncBtn.append(iconElement(WaveformIcon, 14), audioSyncLabel.el);
    audioSyncBtn.onclick = () => explainSource(t('fileViewer.abc.audioSync'), t('fileViewer.abc.source.noRecording'));
    paintAudioSync();
    sourceSeg.appendChild(audioSyncBtn);
  }
  if (audioSyncBtn && audioSync) {
    audioSyncBtn.type = 'button';
    audioSyncBtn.append(iconElement(WaveformIcon, 14), audioSyncLabel.el);
    if (audioSync.fromDrive) audioSyncBtn.appendChild(iconElement(CloudIcon, 12));
    // The right click, and a long press on a touch screen — iOS has no
    // contextmenu for one (longPress.ts).
    const tookClick = bindLongPress(audioSyncBtn, forceAudioSync, audioSyncUsable);
    audioSyncBtn.onclick = () => {
      // A long press is not also a click once it has done its work.
      if (tookClick()) return;
      if (!audioSyncUsable()) { explainSource(t('fileViewer.abc.audioSync'), t('fileViewer.abc.source.noKey')); return; }
      // A tab: pressed again while on, it stays on.
      if (!audioSyncView) turnOnAudioSync(false);
    };
    paintAudioSync();
    sourceSeg.appendChild(audioSyncBtn);
  }
  // ── Play-along (2026-10-31, the user — developer mode only) ─────────────
  // A toggle after the audio sync's, on any version with a key: on, the
  // score follows what the microphone hears (session/ui/PlayAlongView.tsx)
  // in the viewer's place, as the audio sync's player takes it — the tabs,
  // the versions and the full page driving it the same way, the viewer's
  // own sound and space bar standing down. The two exclude each other: one
  // score, one cursor. Labelled as the audio sync's is, the two moving
  // together to their own row when the row is short (2026-11-20). Out of
  // developer mode since 2026-11-01 (the user: « it pleases me »).
  const playAlongBtn = document.createElement('button');
  const playAlongLabel = mkSourceLabel();
  playAlongLabel.full.textContent = t('fileViewer.abc.playAlong');
  playAlongLabel.short.textContent = t('fileViewer.abc.playAlong.short');
  /** Offered on a version with a key, as the audio sync's is. */
  const playsAlong = (): boolean => /^K:/m.test(shownBlock(currentIndex));
  const paintPlayAlong = (): void => {
    paintSynthTab();
    paintSourceTab(playAlongBtn, !!playAlongView, playsAlong());
    playAlongBtn.title = t('fileViewer.abc.playAlong.hint');
  };
  const setPlayAlong = (on: boolean): void => {
    if (on === !!playAlongView) return;
    if (on) {
      if (audioSyncView) setAudioSync(false);
      // Within the tap: the microphone is asked for at once.
      playAlongView = mountPlayAlong(lendViewer(), {
        versions: Array.from({ length: versionCount }, (_, i) => shownBlock(i)),
        index: currentIndex,
        suggest: suggestPlayedVersion(appState.value),
        // The offer taken: that version on screen, as its arrow would.
        onShowVersion: (i) => settleDraft(() => goToVersion(i)),
        face: currentMode,
        expanded: modalExpanded,
        onKeepRecording: opts?.onKeepRecording,
        transpose,
        below: sourcesOn ? sourceRow : undefined,
      });
    } else {
      playAlongView!.unmount();
      playAlongView = null;
      reclaimViewer();
    }
    paintPlayAlong();
  };
  /** Another version on screen: followed in its turn — or no Play-along,
   *  for one without a key. */
  const versionChangedForPlayAlong = (): void => {
    if (playAlongView) {
      if (playsAlong()) playAlongView.setVersion(shownBlock(currentIndex), currentIndex);
      else setPlayAlong(false);
    }
    paintPlayAlong();
  };
  playAlongBtn.type = 'button';
  playAlongBtn.append(iconElement(MicIcon, 14), playAlongLabel.el);
  playAlongBtn.setAttribute('aria-label', t('fileViewer.abc.playAlong'));
  playAlongBtn.onclick = () => {
    if (!playsAlong()) { explainSource(t('fileViewer.abc.playAlong'), t('fileViewer.abc.source.noKey')); return; }
    // A tab: pressed again while on, it stays on.
    setPlayAlong(true);
  };
  if (sourcesOn && opts?.playAlong !== false) sourceSeg.appendChild(playAlongBtn);
  versionChangedForPlayAlong();
  // The synth's tab: back to the score's own sound — a Play-along's take in
  // hand asked about first.
  synthTab.onclick = () => {
    if (audioSyncView) setAudioSync(false);
    if (playAlongView && !playAlongView.settleTake(() => setPlayAlong(false))) setPlayAlong(false);
  };
  paintSynthTab();
  // ── The row over the score: on one line ──────────────────────────────────
  // At once, in the observer — which runs after layout and before paint: at
  // the next frame, the row was seen wrapping onto a second line for one
  // frame before it shrank (2026-10-29, the user). What is observed is a
  // ruler as wide as the row and of no height, which the change cannot
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
  /** What the row gives up before it would wrap (2026-11-01, the user — it
   *  no longer does), in order (2026-11-20, the user): first the versions'
   *  selection itself — its arrows and its gaps; then the editor's "+", Save
   *  and bin, the three together and by as little as it takes, down to the
   *  arrows' own narrow width; and only then, last resort, the faces' tabs.
   *  0 to 3, each keeping what the ones before gave up. */
  let narrowStep = 0;
  const editBtns = [addVersionBtn, saveBtn, deleteVersionBtn];
  const setSelectionNarrow = (on: boolean): void => {
    prevBtn.classList.toggle('abc-nav-narrow', on);
    nextBtn.classList.toggle('abc-nav-narrow', on);
    versionNav.style.columnGap = on ? '0.125rem' : '';
  };
  /** The three editing buttons at `px` layout pixels wide each, no padding;
   *  null, their own width. */
  const setEditWidth = (px: number | null): void => {
    for (const b of editBtns) {
      b.classList.toggle('abc-nav-narrow', px !== null);
      b.style.minWidth = px === null ? '' : `${px}px`;
    }
  };
  /** The row of tabs and versions over the score, kept on one line: the
   *  versions' arrows give up their width when it is short. */
  const fitTopRow = (): void => {
    // Tried from nothing given up, measured as the row then stands, in
    // the same task — nothing painted in between. A step that jumps (the
    // arrows, the tabs) is only given back with a few pixels to spare;
    // the buttons' width follows the room, nothing to flicker between.
    const was = narrowStep;
    const room = topRow.clientWidth;
    setSelectionNarrow(false);
    setEditWidth(null);
    tabBar.classList.remove('abc-tabs-narrow');
    narrowStep = 0;
    // The arrows jump back to their width: with room to spare only.
    if (rowNeed() + (was > 0 ? ROW_SLACK_PX : 0) <= room) return;
    setSelectionNarrow(true);
    narrowStep = 1;
    if (rowNeed() <= room) return;
    const shown = editBtns.filter(b => b.style.display !== 'none' && b.offsetParent);
    if (shown.length) {
      // The tabs, too, jump back: the buttons leave them the spare room.
      const spare = was === 3 ? ROW_SLACK_PX : 0;
      const full = shown[0]!.offsetWidth;
      const short = rowNeed() + spare - room;
      const width = Math.floor(full - short / shown.length);
      setEditWidth(Math.min(full, Math.max(EDIT_MIN_PX, width)));
      narrowStep = 2;
      if (width >= EDIT_MIN_PX) return;
    }
    tabBar.classList.add('abc-tabs-narrow');
    narrowStep = 3;
  };
  const rowWatch = new ResizeObserver(() => fitTopRow());
  topRow.classList.add('relative');
  topRow.appendChild(rowRuler);
  rowWatch.observe(rowRuler);
  ctx.whenClosed(() => { rowWatch.disconnect(); sourcesWatch.disconnect(); });
  fitTopRow();
  /** A tab pressed: the viewer's face, or the audio sync's, or the
   *  Play-along's. */
  const chooseMode = (mode: ScoreFace): void => {
    // Wider for the two faces side by side, back to its own width after —
    // at the press only: the face a score opens on is never "both".
    if ((mode === 'both') !== (currentMode === 'both')) {
      setModalMaxWidth(body, mode === 'both' ? BOTH_FACES_WIDTH : modalWidth(entry));
    }
    const view = takenOver();
    if (!view) { setAbcMode(mode); return; }
    currentMode = mode;
    paintTabs(mode);
    view.setFace(mode);
    // The editor's face under the audio sync: its box, written in there.
    lendEditor();
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
  warnRow.className = 'hidden shrink-0 flex-col gap-1 px-3 py-2 rounded-lg text-xs border border-warn/30 bg-warn/10 text-primary';
  container.appendChild(warnRow);
  /** Folded or not: kept for the life of the viewer, since the strip is
   *  rebuilt at every pause in the typing. */
  let warningsOpen = false;

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
    head.appendChild(iconElement(WarningTriangleIcon, 14));
    const headText = document.createElement('span');
    headText.textContent = t('fileViewer.abc.warnings', { n: String(list.length) });
    const chevron = document.createElement('span');
    chevron.className = 'ml-auto transition-transform';
    chevron.appendChild(iconElement(ChevronDownIcon, 12));
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
    t('fileViewer.abc.listen.title'), () => engine?.transport.playPause());
  const rewindBtn = mkPlayBtn('abc-midi-rewind', rewindIcon(15), t('fileViewer.abc.rewindStart'), () => engine?.transport.rewind());
  const stopBtn = mkPlayBtn('abcjs-midi-reset', stopIcon(15), t('fileViewer.abc.listen.stop'), () => engine?.transport.stop());
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
  /** Typing, another version, the audio sync, the Play-along and the
   *  dialog going stop it. */
  const stopPlay = (): void => engine?.transport.stop();

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

  const boundsGroup = document.createElement('div');
  boundsGroup.className = 'flex items-center rounded-lg border border-border bg-bg shrink-0';
  const mkBoundBtn = (face: string | Element, cls: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `abc-tool-btn text-xs font-mono font-semibold ${cls}`;
    if (typeof face === 'string') b.innerHTML = face; else b.appendChild(face);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = () => { b.blur(); onClick(); };
    return b;
  };
  const boundInBtn = mkBoundBtn(boundIcon('in'), 'abc-bound-btn-in', t('fileViewer.abc.bounds.setIn'), () => engine?.setBoundHere('in'));
  const boundOutBtn = mkBoundBtn(boundIcon('out'), 'abc-bound-btn-out', t('fileViewer.abc.bounds.setOut'), () => engine?.setBoundHere('out'));
  const boundClearBtn = mkBoundBtn(iconElement(CrossIcon, 14), 'text-muted hover:text-primary disabled:opacity-40 disabled:cursor-default disabled:hover:text-muted',
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
    engine?.redrawBounds();
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
    down.appendChild(iconElement(MinusIcon, 14));
    const value = document.createElement('button');
    value.className = 'px-2 min-h-[2.25rem] text-xs font-medium tabular-nums text-primary cursor-pointer transition-colors hover:text-accent';
    value.title = titles.reset;
    const up = document.createElement('button');
    up.className = 'abc-tool-btn text-muted hover:text-primary';
    up.title = titles.up;
    up.setAttribute('aria-label', titles.up);
    up.appendChild(iconElement(PlusIcon, 14));
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
      engine?.redrawScore();
      engine?.transport.retime();
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
      engine?.transport.retime();
    },
    () => {
      if (tempoPercent === DEFAULT_TEMPO_PERCENT) return;
      tempoPercent = DEFAULT_TEMPO_PERCENT;
      updateTempo();
      engine?.transport.retime();
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
    engine?.transport.retime();
  });

  // abcjs does the work (its `addSwing`); all this chooses is the number.
  const swingBtn = mkSwingButton(swing, (v) => {
    swing = v;
    // Swing is applied when the note map is built, so it needs the buffer
    // rebuilt — same as the metronome.
    engine?.transport.retime();
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
  // The middle of the column: whatever the rows above and below leave.
  facesBox.className = 'abc-faces';
  facesBox.appendChild(scoreFrame);
  container.appendChild(facesBox);
  // The transport goes UNDER the faces, which is why it is not appended
  // where it was built (see TRANSPORT_CLASS) — nor here: after the ABC
  // source's box, which goes into `facesBox` beside the stave.

  // The score's own scrolling viewport, as tall as the middle of the column
  // (styles.css, .abc-faces): the score is the only thing that should move
  // while the cursor advances. When the modal body was the scroller, centring a staff dragged
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
  // No room kept over the first staff for the full-page button (scoreTools):
  // `pt-8` held 32 px of the score's height for it from 2026-10-24, when it
  // had landed on the last notes of the first line; the user would rather
  // have the height (2026-11-20 — the score is the point of this crowded
  // dialog) and the button floating, on a paper-coloured ground of its own
  // (`.abc-score-tool-small`) so that it reads over whatever it covers.
  scoreScroll.className = 'abc-score-paper w-full rounded p-2 overflow-y-auto';
  scoreFrame.appendChild(scoreScroll);

  // Full page, in the score's top right corner, over the paper (2026-10-10,
  // the user) — where the way back already was once in full page. One button
  // for both: it belongs to the frame, so it travels into the full-page
  // overlay with the score and turns into the way out there.
  const scoreTools = document.createElement('div');
  scoreTools.className = 'absolute top-1 right-1 z-20 flex items-center';
  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.className = 'abc-score-tool-small rounded-md transition-colors cursor-pointer flex items-center justify-center';
  fullscreenBtn.title = t('fileViewer.abc.fullscreen');
  fullscreenBtn.setAttribute('aria-label', t('fileViewer.abc.fullscreen'));
  fullscreenBtn.dataset.tour = 'abc-fullscreen';
  fullscreenBtn.appendChild(iconElement(ExpandIcon, 14));
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
  // No cap on the score's height any more (2026-11-20): it is the middle of
  // a column the dialog's height (see the container). The dialog grown to the
  // page gives it the room by itself.
  ctx.hooks.onExpanded = (expanded) => { modalExpanded = expanded; takenOver()?.setExpanded(expanded); };



  const notation = document.createElement('div');
  notation.className = 'w-full';
  notation.id = `abc-notation-${uid}`;
  scoreScroll.appendChild(notation);

  // ── The reading page ─────────────────────────────────────────────────────
  // The whole dialog can already be expanded (modal.tsx's own toggle), which
  // is a different thing: that one gives the tabs, the transport and the
  // version nav the room too. This gives the page to the music — a stand you
  // can read from across the room (readingPage.ts).
  //
  // The TRANSPORT COMES WITH IT, since 2026-09-21. Before that only the score
  // travelled and the controls stayed behind in the dialog, under the
  // overlay: on a desktop the space bar still played, and on a phone the one
  // mode built for reading from a stand could not start, stop or slow the
  // tune down. Measured, not deduced — the only button inside the overlay was
  // the one that left it.
  //
  // No page-turn bands here on purpose. The full-page reader had a band down
  // each side that scrolled by a screenful; it was dropped on 2026-09-22
  // because a reader scrolls the score, and two tap targets over the music
  // were read as settings rather than as a page turn. Nothing is built for
  // the full page any more: its way out is the very button that led in
  // (scoreTools), which travels with the frame.
  const page = readingPage([scoreFrame, transportBar], (on) => {
    // The paper is the score box's own background, and that box fills the
    // column, so the page still reads as one sheet.
    scoreFrame.classList.toggle('flex', on);
    scoreFrame.classList.toggle('flex-col', on);
    scoreFrame.classList.toggle('flex-1', on);
    scoreFrame.classList.toggle('min-h-0', on);
    scoreScroll.classList.toggle('rounded', !on);
    scoreScroll.classList.toggle('flex-1', on);
    scoreScroll.classList.toggle('min-h-0', on);
    // The transport, at the bottom where a thumb is. It keeps its element
    // and its abcjs bindings — only where it sits and what it sits on change.
    transportBar.className = on
      ? 'abc-transport shrink-0 flex items-center justify-center gap-2 flex-wrap px-2 py-2 bg-elevated border-t border-border'
      : TRANSPORT_CLASS;
    const key = on ? 'fileViewer.abc.fullscreenExit' : 'fileViewer.abc.fullscreen';
    fullscreenBtn.replaceChildren(iconElement(on ? CollapseIcon : ExpandIcon, 14));
    fullscreenBtn.title = t(key);
    fullscreenBtn.setAttribute('aria-label', t(key));
    // The score is engraved to the width of its box, so a box this much
    // wider is a different engraving — not merely the same one scaled; and
    // on the way out, the box changed width twice over. Not for a dialog
    // that is going.
    if (!ctx.closed()) engine?.remeasure();
  });
  fullscreenBtn.onclick = () => { if (page.on) page.exit(); else page.enter(); };
  // The viewer can go while the score is still filling the page — the stack
  // is popped from elsewhere by closeAllModals — and a frame left inside an
  // overlay nothing points at any more would stay on screen for good.
  ctx.whenClosed(page.exit);

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
  // As tall as its share of the middle (styles.css, .abc-faces): no handle
  // to resize it by — it had one while the box was a fixed 18rem.
  textarea.className = 'relative block w-full h-full font-mono text-xs p-3 border border-border rounded-lg bg-transparent text-primary resize-none outline-none focus:border-accent';
  textarea.spellcheck = false;
  textarea.readOnly = !save;
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
  const faceSplit = bindFaceSplit(splitter, facesBox, () => engine?.remeasure());

  const bottomRow = document.createElement('div');
  bottomRow.className = BOTTOM_ROW_CLASS;
  bottomRow.appendChild(transportBar);
  // The source tabs over it, stuck with it (`homeSources`: back here from
  // the audio sync's or the Play-along's view).
  const bottomBlock = document.createElement('div');
  bottomBlock.className = BOTTOM_BLOCK_CLASS;
  if (sourcesOn) bottomBlock.appendChild(sourceRow);
  bottomBlock.appendChild(bottomRow);
  container.appendChild(bottomBlock);
  /** The source tabs back over the transport, from a view that had them. */
  const homeSources = (): void => { if (sourcesOn) bottomBlock.prepend(sourceRow); };
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
  ctx.whenClosed(() => backdropRo.disconnect());

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
  /** The audio sync's marks while it has the box (N3b): the note heard and
   *  its region's bounds, in place of the viewer's own — whose player is
   *  silent meanwhile. */
  let syncMarks: { cur: [number, number] | null; in: [number, number] | null; out: [number, number] | null } | null = null;

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
    const sync = audioSyncView ? syncMarks ?? { cur: null, in: null, out: null } : null;
    const current = (sync ? (sync.cur ? [sync.cur] : []) : textCurrent)
      .map(r => trimNote(text, r)).filter((r): r is [number, number] => !!r);
    // The cursor's bar: on the notes sounding while there are any — it
    // follows the music, as the stave's cursor does (the user, 2026-10-15)
    // — else on the caret's note: not under the audio sync, whose player
    // starts where it is told, not at the caret.
    const caretNote = sync ? null : trimNote(text, textHints.start);
    const cursors = current.length ? current : caretNote ? [caretNote] : [];
    // The passage's start against its first note's left edge, its end
    // against its last note's right edge: it reads as [ … ].
    const markIn = trimNote(text, sync ? sync.in : textBoundMarks.in);
    const markOut = trimNote(text, sync ? sync.out : textBoundMarks.out);
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
  const goToWarning = (at: number): void => {
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



  body.appendChild(container);


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

  /** The dot on the ABC tab: the stave may be showing an edit, and nothing
   *  else on that face would say so. Drawn, not a "●" character. */
  const markDraft = (): void => {
    textTabBtn.replaceChildren(abcGlyph);
    textTabBtn.title = t('fileViewer.abc.textTab');
    if (!draft) return;
    const dot = document.createElement('span');
    dot.className = 'w-1.5 h-1.5 rounded-full bg-warn ml-1 shrink-0';
    textTabBtn.appendChild(dot);
    textTabBtn.title = `${t('fileViewer.abc.textTab')} · ${t('unsaved.title')}`;
  };

  // Assigned by the editable branch below; a viewer without a save has
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
        saveBtn.disabled = true; paintSave();
        // The stave was drawing the edit: stale now. Whatever proceeds next
        // redraws it straight away when it is on screen, or the dialog is
        // going away.
        sheetNeedsRerender = true;
        if (showsText(currentMode)) { fillBox(currentBody()); engine?.checkWarnings(); }
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
  ctx.hooks.guardClose = (dismiss) => {
    if (playAlongView?.settleTake(() => { if (!guardDraft(dismiss)) dismiss(); })) return true;
    return guardDraft(dismiss);
  };
  ctx.hooks.pendingText = () => {
    if (!draft) return null;
    const next = [...tunes];
    next[draft.index] = withXLine(draft.index, draft.body);
    return next.join('\n');
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
    paintVersionNav();
    updateStarBtn?.();
    versionChangedForAudioSync();
    versionChangedForPlayAlong();
    // Each face on screen redrawn for it; one that is not, when it is next
    // shown.
    if (showsSheet(currentMode)) engine?.renderTune(currentIndex);
    else sheetNeedsRerender = true;
    if (showsText(currentMode)) {
      fillBox(pendingBody() ?? currentBody());
      saveBtn.disabled = pendingBody() === null;
      saveFailed = false; paintSave();
      engine?.checkWarnings();
      engine?.previewText();
    }
    // The sound of the version now on screen.
    engine?.prepareSound();
  }

  /** The editor's face: the stave and its text together, of a file that can
   *  be saved (2026-11-20, the user — "that is the editor mode"). The text
   *  is written there only: read-only on the ABC face alone, as it is when
   *  nothing can save it; and the version and save tools are there only. */
  function editsText(): boolean {
    return !!save && currentMode === 'both';
  }

  /** The versions' box: there with two versions or more — and on the
   *  editor's face of a file with one, for its "+" (2026-11-20). Adding and
   *  deleting on that face only; the last version cannot be deleted without
   *  the file going with it, so not offered. The row's width changes with
   *  them: its arrows judged again. */
  function paintVersionNav(): void {
    const editing = editsText();
    versionNav.classList.toggle('hidden', versionCount <= 1 && !editing);
    addVersionBtn.style.display = editing ? '' : 'none';
    deleteVersionBtn.style.display = editing && versionCount > 1 ? '' : 'none';
    // Save too, BEFORE the row is fitted: shown after, on a narrow screen
    // the editor's face opened overflowing until the next resize
    // (2026-11-20, the user).
    paintSave();
    fitTopRow();
  }

  function paintTabs(mode: ScoreFace): void {
    // The segmented control's button, on the `seg-lg` rail: 36 layout px,
    // which the app's own zoom turns into 45 on a desktop and 32,4 on a
    // phone — the floor `.tap-btn` sets everywhere else. These were 24 px
    // tall until 2026-09-21. As wide, an icon each (no padding, so the one-icon tabs
    // stay square) — the "both" tab two icons
    // wide, with a little room either side.
    // `px-0 gap-0`: as narrow as before the charter (measured on an
    // iPhone 14: the class's padding and gap made the rail 30 px wider and
    // pushed the versions' box off the dialog's right edge).
    const tabBase = 'seg-btn px-0 gap-0 min-w-[2.25rem]';
    sheetTabBtn.className = `${tabBase}${mode === 'sheet' ? ' seg-btn-on' : ''}`;
    textTabBtn.className  = `${tabBase}${mode === 'text'  ? ' seg-btn-on' : ''}`;
    bothTabBtn.className  = `${tabBase}${mode === 'both' ? ' seg-btn-on' : ''}`;
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

    paintVersionNav();
    textarea.readOnly = !editsText();
    if (showsSheet(mode) && sheetNeedsRerender) {
      sheetNeedsRerender = false;
      engine?.renderTune(currentIndex);
    }
    if (showsText(mode) && !textShown) {
      fillBox(pendingBody() ?? currentBody());
      saveBtn.disabled = pendingBody() === null;
      saveFailed = false; paintSave();
    }
    textShown = showsText(mode);
    // No focus: switching to the source face is often just a look, and
    // stealing the caret put a keyboard over half a phone screen for someone
    // who had not asked to type. The box is one tap away.
    if (textShown) engine?.checkWarnings();
    engine?.showCursor();
    // Back from the audio sync or the Play-along, which had the sound.
    engine?.prepareSound();
  }

  // ── Writing under the audio sync (N3b, 2026-11-23, the user) ──
  // The audio sync is used to correct the ABC: on the editor's face, its text
  // is this box — lent to its view (SyncedScoreProps.editor), every tool of
  // the editor with it — and the version is aligned anew at each pause in
  // the typing (`realignAfterTyping`), the player going on meanwhile.
  /** The editor's text box, lent to the audio sync on the editor's face —
   *  and back in its place once the audio sync is off. */
  const lendEditor = (): void => {
    if (!audioSyncView) return;
    const editing = editsText();
    textarea.readOnly = !editing;
    if (editing) {
      textBox.style.display = '';
      if (!textShown) {
        fillBox(pendingBody() ?? currentBody());
        saveBtn.disabled = pendingBody() === null;
        saveFailed = false; paintSave();
      }
    }
    textShown = editing;
    paintVersionNav();
  };
  const homeEditor = (): void => {
    facesBox.insertBefore(textBox, splitter);
    syncMarks = null;
    paintText();
  };
  // Its marks from the audio sync, on the box's own text: drawn without
  // its `X:` line and some header lines (rangeInSource). Brought into view
  // only while the box is not being written in — the writer keeps the
  // scroll.
  let mapped: { drawn: string; source: string; map: ReturnType<typeof rangeInSource> } | null = null;
  /** The audio sync's way to a character of the text it drew, while it
   *  has the box. */
  let syncSeek: ((drawnAt: number) => void) | null = null;
  const syncEditor: ScoreEditor = {
    box: textBox,
    mark: (m) => {
      const source = textarea.value;
      if (mapped?.drawn !== m.text || mapped.source !== source) mapped = { drawn: m.text, source, map: rangeInSource(m.text, source) };
      syncMarks = { cur: mapped.map(m.cur), in: mapped.map(m.in), out: mapped.map(m.out) };
      paintText(document.activeElement !== textarea);
    },
    bind: (seek) => { syncSeek = seek; },
  };
  // A click in the text sends the recording to its note, as a note pressed
  // on the stave does (2026-11-23, the user) — a click, not a selection:
  // the caret stays where it landed, to write there.
  textarea.addEventListener('click', () => {
    if (!audioSyncView || !syncSeek || !mapped || textarea.selectionStart !== textarea.selectionEnd) return;
    const at = posInDrawn(mapped.drawn, textarea.value, textarea.selectionStart);
    if (at !== null) syncSeek(at);
  });

  if (save) {
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
      const outcome = await save!(nextText);
      if (outcome === 'failed') {
        // Say so where the edit is, keep the editor as it is, and do not
        // pretend it was saved.
        saveFailed = true; paintSave();
        return false;
      }
      if (outcome === 'refused') return false;
      tunes = nextTunes;
      abcText = nextText;
      versionCount = tunes.length;
      // Every writer folds the edit in (or deletes its version), so once the
      // file is written there is nothing pending any more.
      draft = null;
      markDraft();
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
      saveFailed = false; paintSave();
      // The stave is drawn from the draft, so it is stale from now on:
      // redrawn as it is typed when it is on screen beside the text, else
      // when it is next shown. Under the audio sync, the stave on screen
      // is its own: the edit aligned anew there.
      if (audioSyncView) { sheetNeedsRerender = true; realignAfterTyping(); }
      else if (showsSheet(currentMode) && engine) engine.redrawAfterTyping();
      else sheetNeedsRerender = true;
    });

    /** The edit aligned on the recording once the typing pauses: every
     *  keystroke would start the work again before it could end. Not
     *  turned off when the text stops being a tune — a key line deleted on
     *  the way to another: it says it cannot align, and aligns again once
     *  it can. */
    let realignTimer = 0;
    const realignAfterTyping = (): void => {
      window.clearTimeout(realignTimer);
      realignTimer = window.setTimeout(() => {
        if (ctx.closed() || !audioSyncView) return;
        audioSyncView.setVersion(shownBlock(currentIndex), draft?.index === currentIndex);
      }, REALIGN_AFTER_TYPING_MS);
    };

    saveDraft = async () => {
      if (!draft) return true;
      const nextTunes = [...tunes];
      nextTunes[draft.index] = withXLine(draft.index, draft.body);
      saveBtn.disabled = true; paintSave();
      if (!await persist(nextTunes, currentIndex)) {
        saveBtn.disabled = pendingBody() === null; paintSave();
        return false;
      }
      saveFailed = false; paintSave();
      return true;
    };
    saveBtn.onclick = () => { void saveDraft(); };

    addVersionBtn.onclick = async () => {
      const nextTunes = tunesWithPendingEdit();
      nextTunes.push(newVersionBlock(nextTunes));
      // Straight onto the new one: it is empty, and there is nothing else to
      // do with it than write in it.
      if (await persist(nextTunes, nextTunes.length - 1)) setAbcMode('both');
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
  // Handed an audio sync that was on (PreviewModalOpts.audioSyncCarry): on
  // again at once, its recording chosen already — once the dialog is up.
  const carried = opts?.audioSyncCarry;
  if (carried && audioSync?.plays(shownBlock(currentIndex))) {
    requestAnimationFrame(() => {
      if (ctx.closed() || audioSyncView) return;
      audioSyncForced = carried.forced;
      setAudioSync(true);
    });
  }

  import('abcjs').then((abcjs) => {
    // Closed while abcjs was still loading: no score, player or listener for
    // a dialog nobody sees — the audio branch's same check.
    if (ctx.closed()) return;
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
    const prepareSound = (delay = PREPARE_DELAY_MS): void => {
      window.clearTimeout(prepareTimer);
      prepareTimer = window.setTimeout(() => {
        if (ctx.closed() || takenOver()) return;
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
    /** The width the score on screen was engraved for, so a resize that
     *  changes nothing worth redrawing can be ignored. */
    let lastEngravedWidth = 0;
    const renderTune = (index: number): void => {
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

    const showCursor = (): void => {
      paintSheetCursor();
      schedulePreview();
    };

    // ── The passage: set here, drawn on both faces ──
    const setBoundHere = (side: 'in' | 'out'): void => {
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
    const redrawBounds = (): void => {
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
      soundNoteAt(index);
    });
    // A note typed is heard as a note tapped is (2026-11-28, the user: in a
    // transcription's editor and in every score's): its letter, or the octave
    // mark that moves it — the note the caret has just closed. Typed only: a
    // paste or a deletion sounds nothing.
    textarea.addEventListener('input', (e) => {
      const ie = e as InputEvent;
      if (ie.inputType !== 'insertText' || !ie.data || !/^[A-Ga-g',]$/.test(ie.data)) return;
      const caret = textarea.selectionStart;
      if (textarea.selectionEnd !== caret || caret < 1) return;
      soundNoteAt(caret - 1);
    });
    /** The note at `index` in the text, heard on its own — not while the
     *  music plays, and as the preferences say (tapPlaysNote). */
    function soundNoteAt(index: number): void {
      const state = player.state();
      if (!showsText(currentMode) || state === 'playing' || state === 'loading') return;
      if (!tapPlaysNote(appState.value)) return;
      const text = textarea.value;
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
    }

    // ── The transport ──
    const transport: ScoreEngine['transport'] = {
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
      // A score in a page: not under a dialog opened over it (its own full
      // page aside — that one is the score).
      if (ctx.ownsKeys && !page.on && !ctx.ownsKeys()) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || active?.isContentEditable) return;
      e.preventDefault(); // or the page scrolls under the modal
      unlockAbcjsAudio();
      transport.playPause();
    };
    document.addEventListener('keydown', onKeyDown);
    ctx.whenClosed(() => document.removeEventListener('keydown', onKeyDown));

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
    const redrawScore = (): void => {
      if (!showsSheet(currentMode)) { sheetNeedsRerender = true; return; }
      renderTune(currentIndex);
    };
    // On the "both" face, the stave follows the typing once it pauses —
    // engraving a set at every keystroke would make the caret stutter.
    // Stale meanwhile, and marked so: the cursor waits for the new drawing
    // rather than being put on the old one's notes.
    let typingTimer = 0;
    const redrawAfterTyping = (): void => {
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
    const checkWarnings = (): void => {
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
    ctx.whenClosed(() => { window.clearTimeout(warnTimer); window.clearTimeout(typingTimer); });
    const remeasure = (): void => {
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
    ctx.whenClosed(releaseResize);
    // The player goes with the dialog too.
    ctx.whenClosed(() => {
      // Stopped, and the sound made ahead let go of.
      window.clearTimeout(prepareTimer);
      player.dispose();
      document.removeEventListener('selectionchange', onSelectionChange);
      cancelAnimationFrame(previewRaf);
    });

    // Changing instrument without losing your place: the stave redrawn —
    // the paper is set in that dialog too — and the music rebuilt at the
    // same note.
    const reapplyPrefs = (): void => {
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
    // The score, from here on: everything the viewer reaches in it.
    engine = {
      renderTune, redrawScore, redrawAfterTyping, remeasure, prepareSound, checkWarnings,
      previewText: schedulePreview, showCursor, setBoundHere, redrawBounds, transport,
    };
    ctx.hooks.reapplyPrefs = reapplyPrefs;
    ctx.hooks.recheckSyntax = checkWarnings;
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
    err.className = 'text-sm text-danger';
    err.textContent = t('fileViewer.abcError');
    body.appendChild(err);
  });
}
