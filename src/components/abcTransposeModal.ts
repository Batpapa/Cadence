import { iconElement, PlusIcon, MinusIcon } from './icons';
import { t } from '../services/i18nService';
import { showModal, MODAL_W } from './modal';

// ── A score's transposition ──────────────────────────────────────────────────
// Out of fileViewer.ts since 2026-11-26, unchanged.

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
export function showTransposeModal(current: number, limit: number, onPick: (semitones: number) => void): void {
  let value = current;

  const body = document.createElement('div');
  body.className = 'space-y-4';

  const row = document.createElement('div');
  row.className = 'flex items-center justify-center gap-5';
  const stepBtn = 'btn-outline w-11 h-11 p-0 rounded-full flex items-center justify-center shrink-0';

  const down = document.createElement('button');
  down.className = stepBtn;
  down.appendChild(iconElement(MinusIcon, 16));
  down.setAttribute('aria-label', t('fileViewer.abc.transposeDown'));
  const readout = document.createElement('span');
  readout.className = 'font-mono tabular-nums text-2xl text-center';
  readout.style.width = '3ch';
  const up = document.createElement('button');
  up.className = stepBtn;
  up.appendChild(iconElement(PlusIcon, 16));
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
  showModal(t('fileViewer.abc.transpose'), body, [], { maxWidth: MODAL_W.s, pinTop: true });
}

