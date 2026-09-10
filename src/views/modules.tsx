import { navigate } from '../store';
import { t } from '../services/i18nService';
import { WaveformIcon, TrendIcon, RecordingPulseDot, PinIcon } from '../components/icons';
import { sessionRecordingSignal } from '../session/ui/sessionStore';
import { PINNABLE_MODULES, pinnedModuleId, togglePin } from '../components/pinnedModule';
import type { JSX } from 'preact';

// ── Modules page ──────────────────────────────────────────────────────────────
// Was a modal (modulesModal.ts) — moved to a routed page for back/forward
// history support and more vertical space. Just the module picker: clicking
// the analyzer pushes a real `{ view: 'sessions' }` route (see views/sessions.tsx),
// so back/forward properly step through module → analyzer → session.

/** The pin toggle, on the module card it pins.
 *
 *  Here rather than in Settings because this is where the modules are: a
 *  shortcut is placed from the thing it points at, and removed from the same
 *  place — which is also the only way anyone will ever find it. It sits inside
 *  a card that is itself a button, so it stops the click from also navigating. */
function PinButton({ id }: { id: string }) {
  const pinned = pinnedModuleId.value === id;
  return (
    <button
      class={`tap-btn cursor-pointer shrink-0 ${pinned ? 'text-accent bg-accent/10' : 'text-dim hover:text-primary hover:bg-elevated'}`}
      title={t(pinned ? 'modules.unpin' : 'modules.pin')}
      onClick={(e) => {
        e.stopPropagation();
        togglePin(id);
      }}
    >
      <PinIcon size={14} filled={pinned} />
    </button>
  );
}

function ModuleCard({ id, icon, title, desc, extra, onOpen, first }: {
  id: string;
  icon: JSX.Element;
  title: string;
  desc: string;
  extra?: JSX.Element | false;
  onOpen: () => void;
  first?: boolean;
}) {
  return (
    <div
      class={`w-full text-left p-4 rounded-lg border border-border bg-bg hover:border-accent/50 hover:bg-accent/5 transition-colors cursor-pointer flex items-center gap-3 ${first ? '' : 'mt-3'}`}
      onClick={onOpen}
    >
      <div class="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 text-accent">
        {icon}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-primary mb-0.5 flex items-center gap-2">
          {title}
          {extra}
        </div>
        <div class="text-xs text-muted">{desc}</div>
      </div>
      <PinButton id={id} />
    </div>
  );
}

export function ModulesView() {
  const ids = PINNABLE_MODULES.map(m => m.id);
  return (
    <div class="p-6">
      <h1 class="text-xl font-semibold text-primary mb-4">{t('modules.title')}</h1>

      <ModuleCard
        first
        id={ids[0]!}
        icon={<WaveformIcon size={20} />}
        title={t('sessions.moduleTitle')}
        desc={t('sessions.moduleDesc')}
        extra={sessionRecordingSignal.value && <RecordingPulseDot size={10} />}
        onOpen={() => navigate({ view: 'sessions' })}
      />

      <ModuleCard
        id={ids[1]!}
        icon={<TrendIcon size={20} />}
        title={t('trending.moduleTitle')}
        desc={t('trending.moduleDesc')}
        onOpen={() => navigate({ view: 'trending' })}
      />

      <p class="text-xs text-dim mt-4 leading-relaxed">{t('modules.pinHint')}</p>
    </div>
  );
}
