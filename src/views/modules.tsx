import { navigate } from '../store';
import { t } from '../services/i18nService';
import { WaveformIcon, FlameIcon } from '../components/icons';
import { isSessionRecording } from '../session/ui/sessionModule';

// ── Modules page ──────────────────────────────────────────────────────────────
// Was a modal (modulesModal.ts) — moved to a routed page for back/forward
// history support and more vertical space. Just the module picker: clicking
// the analyzer pushes a real `{ view: 'sessions' }` route (see views/sessions.tsx),
// so back/forward properly step through module → analyzer → session.

export function ModulesView() {
  return (
    <div class="p-6">
      <h1 class="text-xl font-semibold text-primary mb-4">{t('modules.title')}</h1>

      <button
        class="w-full text-left p-4 rounded-lg border border-border bg-bg hover:border-accent/50 hover:bg-accent/5 transition-colors cursor-pointer flex items-center gap-3"
        onClick={() => navigate({ view: 'sessions' })}
      >
        <div class="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 text-accent">
          <WaveformIcon size={20} />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-primary mb-0.5 flex items-center gap-2">
            {t('sessions.moduleTitle')}
            {isSessionRecording() && <span class="w-2 h-2 rounded-full bg-danger animate-pulse inline-block" />}
          </div>
          <div class="text-xs text-muted">{t('sessions.moduleDesc')}</div>
        </div>
      </button>

      <button
        class="w-full text-left p-4 rounded-lg border border-border bg-bg hover:border-accent/50 hover:bg-accent/5 transition-colors cursor-pointer flex items-center gap-3 mt-3"
        onClick={() => navigate({ view: 'trending' })}
      >
        <div class="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 text-accent">
          <FlameIcon size={20} />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-primary mb-0.5">{t('trending.moduleTitle')}</div>
          <div class="text-xs text-muted">{t('trending.moduleDesc')}</div>
        </div>
      </button>
    </div>
  );
}
