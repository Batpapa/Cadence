import type { ComponentChildren } from 'preact';
import type { AppContext } from '../types';
import { t } from '../services/i18nService';
import { updateUser } from '../services/userService';
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

/** The Irish answer is framed in the extension's green, as it is in Settings. */
const BORDERS = {
  plain: 'border-border hover:border-accent hover:bg-accent/5',
  irish: 'border-irish/50 hover:border-irish hover:bg-irish/5',
};

function Choice({ icon, title, desc, tone = 'plain', onPick }: {
  icon: ComponentChildren; title: string; desc: string; tone?: keyof typeof BORDERS; onPick: () => void;
}) {
  return (
    <button
      type="button"
      class={`w-full flex items-center gap-3.5 px-4 py-3.5 rounded-xl border bg-bg text-left cursor-pointer transition-colors ${BORDERS[tone]}`}
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

/** `onDone` runs once the question is answered — the walkthrough a new user is
 *  shown next waits for it, rather than opening over it. The window cannot be
 *  closed without an answer (the author's call): only a reload gets past it,
 *  and leaves the user as created, with no extension. */
export function showUsageChoiceModal(ctx: AppContext, onDone: () => void): void {
  const pick = (irishTrad: boolean) => {
    closeModal();
    cleanup();
    if (irishTrad) void ctx.mutate(s => updateUser(s, { extensions: { ...s.extensions, irishTrad: true } }));
    onDone();
  };
  const { el, cleanup } = renderModalBody(
    <div class="space-y-2.5">
      <p class="text-sm text-muted leading-relaxed pb-1">{t('usageChoice.intro')}</p>
      <Choice
        icon={<CadenceLogo size={22} glyph />}
        title={t('usageChoice.default')}
        desc={t('usageChoice.defaultDesc')}
        onPick={() => pick(false)}
      />
      <Choice
        icon={<MusicNoteIcon size={18} />}
        title={t('extensions.irishTrad.title')}
        desc={t('usageChoice.irishTradDesc')}
        tone="irish"
        onPick={() => pick(true)}
      />
      <p class="text-xs text-dim leading-relaxed pt-1">{t('usageChoice.changeLater')}</p>
    </div>,
  );
  showModal(t('usageChoice.title'), el, [], { maxWidth: '26rem', dismissable: false });
}
