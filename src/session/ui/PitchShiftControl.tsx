import { useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, renderModalBody } from '../../components/modal';
import { TuningForkIcon } from '../../components/icons';

// ── Manual pitch shift ────────────────────────────────────────────────────────
// Rewritten 2026-09-09 after two complaints that landed on the same control for
// different reasons: nobody could tell whether a session played N semitones off
// needed +N or -N, and on a phone the old inline "− N +" stepper was about twice
// the width of the Stop button in an already crowded status bar.
//
// Both are answered by moving the choice OUT of the bar: what stays there is one
// round button the size of the pause button beside it, and the room freed up
// buys the space to state the question in words.

/** SIGN. The engine's parameter shifts the RECORDING's transcribed contour, and
 *  the tune index stores everything at written pitch with no transposition
 *  invariance — so a session played a tone DOWN needs +2 there, the
 *  transcription being raised to meet the index.
 *
 *  That is the opposite of how the world says it: every tuner, DAW and capo
 *  calls "lower" negative, and a player says "we're a tone down". The engine's
 *  convention was never guessable — the code's own comments had it backwards
 *  until 2026-09-09 — so it is flipped once, here, and never shown.
 *
 *  `heard` below always means "how the session SOUNDS against the written tune",
 *  negative = lower. `engine` is what liveSession/importSession take. */
const flip = (semitones: number) => -semitones;

/** The number said out loud, so that reading the sign is never required to know
 *  what was set — the whole failure this control had. */
function pitchDescription(heard: number): string {
  if (heard === 0) return t('sessions.pitchShift.asWritten');
  const dir = heard < 0 ? 'lower' : 'higher';
  const n = Math.abs(heard);
  if (n === 1) return t(`sessions.pitchShift.semitone.${dir}`);
  if (n === 2) return t(`sessions.pitchShift.tone.${dir}`);
  return t(`sessions.pitchShift.semitones.${dir}`, { n: String(n) });
}

const signed = (heard: number) => (heard > 0 ? `+${heard}` : String(heard));

function PitchShiftBody({ initialHeard, onPick }: { initialHeard: number; onPick: (heard: number) => void }) {
  const [heard, setHeard] = useState(initialHeard);

  // No confirm button: the shift is live-adjustable by design (it takes effect
  // on the next analysis window), so each tap IS the change and the ✕ is the
  // only way out that makes sense.
  const step = (delta: number) => {
    const next = Math.max(-12, Math.min(12, heard + delta));
    if (next === heard) return;
    setHeard(next);
    onPick(next);
  };

  const stepBtn = 'btn-ghost border border-border w-11 h-11 p-0 rounded-full flex items-center justify-center shrink-0 text-lg leading-none';

  return (
    <div class="space-y-4">
      <div class="flex items-center justify-center gap-5">
        <button class={stepBtn} disabled={heard <= -12} onClick={() => step(-1)}>−</button>
        <span
          class={`font-mono tabular-nums text-2xl text-center ${heard === 0 ? 'text-dim' : 'text-accent font-semibold'}`}
          style={{ width: '3ch' }}
        >{heard === 0 ? '0' : signed(heard)}</span>
        <button class={stepBtn} disabled={heard >= 12} onClick={() => step(1)}>+</button>
      </div>

      <p class="text-sm text-primary text-center leading-relaxed">
        {t('sessions.pitchShift.question')}{' '}
        <span class="font-medium">{pitchDescription(heard)}</span>
      </p>
    </div>
  );
}

export function PitchShiftControl({ value, onChange }: { value: number; onChange: (semitones: number) => void }) {
  // Local, like the stepper it replaces: `value` comes off a plain field on the
  // session engine, which re-renders nothing when it changes.
  const [heard, setHeard] = useState(flip(value));

  const open = () => {
    const { el, cleanup } = renderModalBody(
      <PitchShiftBody
        initialHeard={heard}
        onPick={(next) => { setHeard(next); onChange(flip(next)); }}
      />,
    );
    showModal(t('sessions.pitchShift'), el, [], { maxWidth: '20rem', onDismiss: cleanup });
  };

  // Same shape as the pause button next to it. Reads as an icon at rest and as
  // its own value once set — a hue change alone would say "something is on"
  // without saying what, and this is a control whose whole problem was that
  // nobody knew what it was doing.
  return (
    <button
      class={`btn-ghost border border-border h-8 min-w-8 p-0 px-1.5 rounded-full flex items-center justify-center shrink-0
        text-xs font-mono tabular-nums ${heard === 0 ? '' : 'text-accent font-semibold'}`}
      title={t('sessions.pitchShift.hint')}
      onClick={open}
    >
      {heard === 0 ? <TuningForkIcon size={13} /> : signed(heard)}
    </button>
  );
}
