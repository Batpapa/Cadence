import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { AppContext, AppState } from '../types';
import { t } from '../services/i18nService';
import { updateUser } from '../services/userService';
import { addDefaultSamples, addIrishSamples, fetchIrishSampleTunes } from '../services/sampleLibrary';
import { showModal, closeModal, renderModalBody } from './modal';
import { CadenceLogo, MusicNoteIcon } from './icons';

// ── What a new user is here for (2026-10-26) ─────────────────────────────────
// A brand-new user starts with every extension off (extensions.ts): Cadence is
// for anything worth remembering. Asked once, at creation, so that someone who
// came for Irish music does not have to know there is a switch somewhere in
// the settings: two answers, the plain app or the app with the Irish trad
// extension on — one of them has to be picked. Either is changed later in
// Settings → Extensions, as the window says.
//
// Not called "profile": Cadence's profiles are something else (one review
// history each, on the same cards).
//
// The same window offers a first library to learn from (2026-10-30), ticked
// by default, matching the answer — see services/sampleLibrary.ts. The Irish
// one is fetched from TheSession before the window closes, so the walkthrough
// that follows already has it to show.

/** The Irish answer is framed in the extension's green, as it is in Settings. */
const BORDERS = {
  plain: 'border-border hover:border-accent hover:bg-accent/5',
  irish: 'border-irish/50 hover:border-irish hover:bg-irish/5',
};

function Choice({ icon, title, desc, tone = 'plain', disabled, onPick }: {
  icon: ComponentChildren; title: string; desc: string; tone?: keyof typeof BORDERS; disabled?: boolean; onPick: () => void;
}) {
  return (
    <button
      type="button"
      class={`w-full flex items-center gap-3.5 px-4 py-3.5 rounded-xl border bg-bg text-left cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default ${BORDERS[tone]}`}
      disabled={disabled}
      onClick={onPick}
    >
      <span class="w-10 h-10 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">{icon}</span>
      <span class="flex-1 min-w-0">
        <span class="block text-sm font-medium text-primary">{title}</span>
        <span class="block text-xs text-muted leading-relaxed mt-0.5">{desc}</span>
      </span>
    </button>
  );
}

type Phase = 'choose' | 'loading' | 'failed';

function UsageChoice({ onAnswer }: { onAnswer: (irishTrad: boolean, samples: ((s: AppState) => void) | null) => void }) {
  const [withSamples, setWithSamples] = useState(true);
  const [phase, setPhase] = useState<Phase>('choose');

  const pickIrish = async () => {
    if (!withSamples) { onAnswer(true, null); return; }
    setPhase('loading');
    try {
      const tunes = await fetchIrishSampleTunes();
      onAnswer(true, s => addIrishSamples(s, s.language, tunes));
    } catch {
      setPhase('failed');
    }
  };

  if (phase === 'failed') {
    return (
      <div class="space-y-3">
        <p class="text-sm text-muted leading-relaxed">{t('usageChoice.samplesFailed')}</p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" onClick={() => onAnswer(true, null)}>{t('usageChoice.continueWithout')}</button>
          <button type="button" class="btn-primary" onClick={() => void pickIrish()}>{t('usageChoice.retry')}</button>
        </div>
      </div>
    );
  }

  const busy = phase === 'loading';
  return (
    <div class="space-y-2.5">
      <p class="text-sm text-muted leading-relaxed pb-1">{t('usageChoice.intro')}</p>
      <Choice
        icon={<CadenceLogo size={22} glyph />}
        title={t('usageChoice.default')}
        desc={t('usageChoice.defaultDesc')}
        disabled={busy}
        onPick={() => onAnswer(false, withSamples ? s => addDefaultSamples(s, s.language) : null)}
      />
      <Choice
        icon={<MusicNoteIcon size={18} />}
        title={t('extensions.irishTrad.title')}
        desc={t('usageChoice.irishTradDesc')}
        tone="irish"
        disabled={busy}
        onPick={() => void pickIrish()}
      />
      <label class={`flex items-center gap-2 pt-1 select-none ${busy ? 'opacity-50' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          class="card-checkbox"
          checked={withSamples}
          disabled={busy}
          onChange={(e) => setWithSamples((e.target as HTMLInputElement).checked)}
        />
        <span class="text-xs text-muted">{t('usageChoice.withSamples')}</span>
      </label>
      <p class="text-xs text-dim leading-relaxed pt-1">
        {busy ? t('usageChoice.loadingSamples') : t('usageChoice.changeLater')}
      </p>
    </div>
  );
}

/** `onDone` runs once the question is answered — the walkthrough a new user is
 *  shown next waits for it, rather than opening over it. The window cannot be
 *  closed without an answer (the author's call): only a reload gets past it,
 *  and leaves the user as created, with no extension and no examples. */
export function showUsageChoiceModal(ctx: AppContext, onDone: () => void): void {
  const answer = (irishTrad: boolean, samples: ((s: AppState) => void) | null) => {
    closeModal();
    cleanup();
    if (irishTrad || samples) {
      void ctx.mutate(s => {
        if (irishTrad) updateUser(s, { extensions: { ...s.extensions, irishTrad: true } });
        samples?.(s);
      });
    }
    onDone();
  };
  const { el, cleanup } = renderModalBody(<UsageChoice onAnswer={answer} />);
  showModal(t('usageChoice.title'), el, [], { maxWidth: '26rem', dismissable: false });
}
