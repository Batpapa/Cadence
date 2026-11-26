import type { AbcOpenMode, AbcPaper } from '../types';
import { focusIfDesktop } from '../utils';
import { mkCustomSelect } from './customSelectVanilla';
import { iconElement, SwingStraightIcon, SwingLightIcon, SwingMediumIcon, SwingStrongIcon } from './icons';
import { t } from '../services/i18nService';
import {
  abcOpenMode, showAbcSyntaxCheck, suggestPlayedVersion, abcPaperSetting, ABC_PAPER_AUTO, abcSwingAtOpen,
  SWING_CHOICES, NO_SWING, stepSwingChoice,
} from '../services/abcService';
import { tapPlaysNote } from '../services/abcTapNote';
import { showModal } from './modal';
import { appState, mutate } from '../store';

// ── Score playback preferences ───────────────────────────────────────────────
// The dialog reachable from any score's header, with what it shares with the
// viewer's transport: the speed bounds, the stored speed, the swing button.
// Out of fileViewer.ts since 2026-11-26, unchanged.

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
export const DEFAULT_TEMPO_PERCENT = 100;
export const MIN_TEMPO_PERCENT = 10;
export const MAX_TEMPO_PERCENT = 300;

/** What one press of the speed stepper is worth, in points of percentage —
 *  and the percentage is of the tune's own written tempo, which is how this
 *  music is practised ("take it at three-quarter speed"). It is also the unit
 *  `setWarp` takes, so nothing is converted on the way. */
export const TEMPO_STEP_PERCENT = 5;

export function abcTempoPercent(): number {
  const stored = appState.value.abcTempoPercent;
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_TEMPO_PERCENT;
  return Math.max(MIN_TEMPO_PERCENT, Math.min(MAX_TEMPO_PERCENT, Math.round(stored)));
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
export function mkSwingButton(initial: number, onChange: (value: number) => void): HTMLButtonElement {
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
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded-md px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
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
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded-md px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
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
    'flex items-center gap-2 w-full text-sm bg-surface border border-border rounded-md px-3 py-1.5 text-primary cursor-pointer hover:border-accent',
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

