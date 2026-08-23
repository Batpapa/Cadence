import { useState } from 'preact/hooks';
import { t } from '../../services/i18nService';

// ── Manual pitch-shift stepper ────────────────────────────────────────────────
// Compact "− N +" stepper for the manual pitch shift applied to an ongoing
// live/import analysis (e.g. a session played in Bb). Plain +/- taps rather
// than a slider — with only 25 discrete steps, big touch targets beat
// dragging a thin range input on a phone. Live-adjustable: takes effect on
// the next analysis window. Sits inline in the status bar, next to the
// stop/cancel button — no label, just the tooltip.

export function PitchShiftControl({ value, onChange }: { value: number; onChange: (semitones: number) => void }) {
  const [v, setV] = useState(value);
  const step = (delta: number) => {
    const next = Math.max(-12, Math.min(12, v + delta));
    setV(next);
    onChange(next);
  };
  const stepBtnClass = (disabled: boolean) =>
    `btn-ghost border border-border w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 leading-none${disabled ? ' opacity-40' : ''}`;

  return (
    <div class="flex items-center gap-1 text-xs shrink-0" title={t('sessions.pitchShift.hint')}>
      <button class={stepBtnClass(v <= -12)} disabled={v <= -12} onClick={() => step(-1)}>−</button>
      <span class={`font-mono tabular-nums text-center shrink-0 ${v === 0 ? 'text-dim' : 'text-accent font-semibold'}`} style={{ width: '2em' }}>
        {v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`}
      </span>
      <button class={stepBtnClass(v >= 12)} disabled={v >= 12} onClick={() => step(1)}>+</button>
    </div>
  );
}
