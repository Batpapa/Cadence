import { t } from '../services/i18nService';

// ── The line between the stave and its text (2026-11-04, the user) ─────────
// On the "both" face, side by side: dragged, it shares the width between the
// text and the stave; a double click puts them back half and half, and the
// arrow keys move it once it has the focus. Shown only where the two faces
// stand side by side — the stylesheet's call, as the layout is
// (`.abc-faces-split` in styles.css). The score viewer's own faces and the
// score the audio sync and the Play-along draw (syncedScore.tsx) share it,
// and share the one setting.

/** The text's share of the width: the device's own, kept as the sidebar's
 *  width is (appRoot.tsx) — a laptop and a large screen want different ones.
 *  Half and half until it is dragged; never so far that either face is left
 *  a sliver. */
const SPLIT_KEY = 'cadence_abc_split';
const SPLIT_DEFAULT = 0.5;
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
/** One press of an arrow key on the line. */
const SPLIT_STEP = 0.05;

const clampSplit = (r: number): number => Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, r));
function readSplit(): number {
  try {
    const r = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '');
    return Number.isFinite(r) ? clampSplit(r) : SPLIT_DEFAULT;
  } catch { return SPLIT_DEFAULT; }
}
function writeSplit(r: number): void {
  try { localStorage.setItem(SPLIT_KEY, String(r)); } catch { /* back to half and half next time, nothing worse */ }
}

export interface FaceSplit {
  /** True while the line is held: a stave engraved to its box's width is
   *  engraved once, at the end, not at every width it passes through. */
  splitting: () => boolean;
  /** The share read again — another view may have moved it since. */
  refresh: () => void;
  release: () => void;
}

/** Makes `line` the line between the faces of `grid` (`.abc-faces-both`),
 *  and gives the grid the stored share. `onSettled` once a move is over: the
 *  stave's width has changed. */
export function bindFaceSplit(line: HTMLElement, grid: HTMLElement, onSettled: () => void): FaceSplit {
  let split = readSplit();
  let splitting = false;
  const apply = (): void => {
    // Shares of 100 rather than of 1: flex factors adding up to less than
    // one would leave part of the row empty.
    grid.style.setProperty('--abc-text-fr', `${split * 100}fr`);
    grid.style.setProperty('--abc-score-fr', `${(1 - split) * 100}fr`);
  };
  apply();
  line.tabIndex = 0;
  line.title = t('fileViewer.abc.split');
  line.setAttribute('role', 'separator');
  line.setAttribute('aria-orientation', 'vertical');
  line.setAttribute('aria-label', t('fileViewer.abc.split'));
  /** The share set: kept for next time, and the stave engraved for it. */
  const settle = (): void => {
    writeSplit(split);
    onSettled();
  };
  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary || e.button !== 0) return;
    // No text selection starting under the drag.
    e.preventDefault();
    splitting = true;
    line.setPointerCapture(e.pointerId);
    line.classList.add('abc-faces-split-active');
  };
  const onMove = (e: PointerEvent): void => {
    if (!splitting) return;
    // Both in window pixels, whatever the app's zoom: a ratio of the two
    // needs no conversion.
    const box = grid.getBoundingClientRect();
    if (box.width <= 0) return;
    split = clampSplit((e.clientX - box.left) / box.width);
    apply();
  };
  const onUp = (): void => {
    if (!splitting) return;
    splitting = false;
    line.classList.remove('abc-faces-split-active');
    settle();
  };
  const onDouble = (): void => {
    split = SPLIT_DEFAULT;
    apply();
    settle();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    split = clampSplit(split + (e.key === 'ArrowLeft' ? -SPLIT_STEP : SPLIT_STEP));
    apply();
    settle();
  };
  line.addEventListener('pointerdown', onDown);
  line.addEventListener('pointermove', onMove);
  line.addEventListener('pointerup', onUp);
  line.addEventListener('pointercancel', onUp);
  line.addEventListener('dblclick', onDouble);
  line.addEventListener('keydown', onKey);
  return {
    splitting: () => splitting,
    refresh: () => { split = readSplit(); apply(); },
    release: () => {
      line.removeEventListener('pointerdown', onDown);
      line.removeEventListener('pointermove', onMove);
      line.removeEventListener('pointerup', onUp);
      line.removeEventListener('pointercancel', onUp);
      line.removeEventListener('dblclick', onDouble);
      line.removeEventListener('keydown', onKey);
    },
  };
}
