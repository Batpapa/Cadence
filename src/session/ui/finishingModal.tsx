import { render } from 'preact';
import { signal, type Signal } from '@preact/signals';
import { t } from '../../services/i18nService';
import { showModal, closeModalOf } from '../../components/modal';

// ── The end of an analysis, when it takes a while ────────────────────────────
// Stopping a recording or finishing an import saves it, and first waits for
// the bounds still being put on their passes (boundSuggest.ts) — a second or
// two each, more on a phone. Past FINISHING_DELAY_MS of that, a modal says so,
// with how many tunes are left, and closes on its own once it is done
// (2026-11-01, the user: "ça poussera les gens à attendre"). Under it,
// nothing: a stop that takes a second needs no announcement.

/** What the end of an analysis is doing: `aligning` tunes still to put on
 *  their passes — 0 once it is only saving. */
export interface FinishingState { aligning: number }

const FINISHING_DELAY_MS = 2000;

function FinishingBody({ state }: { state: Signal<FinishingState> }) {
  const n = state.value.aligning;
  return (
    <div class="flex items-center gap-3 text-sm text-muted">
      <span class="shrink-0 w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      <span>
        {n === 0 ? t('sessions.finishing.saving')
          : n === 1 ? t('sessions.finishing.aligningOne')
          : t('sessions.finishing.aligningMany', { n })}
      </span>
    </div>
  );
}

const trackers = new WeakMap<object, (state: FinishingState | null) => void>();

/** The tracker of one engine — a live recording, an import — the same
 *  however often its screen is mounted again (it re-registers its callbacks
 *  each time): the modal it opened is the one it closes. */
export function finishingTrackerFor(engine: object): (state: FinishingState | null) => void {
  let tracker = trackers.get(engine);
  if (!tracker) { tracker = finishingTracker(); trackers.set(engine, tracker); }
  return tracker;
}

/** Follows the end of one analysis: handed every state, then null when it is
 *  over — the modal opens only if it is still going FINISHING_DELAY_MS after
 *  the first, and closes with the null. */
function finishingTracker(): (state: FinishingState | null) => void {
  const state = signal<FinishingState>({ aligning: 0 });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let body: HTMLElement | null = null;
  return (next) => {
    if (next) {
      state.value = next;
      if (timer || body) return;
      timer = setTimeout(() => {
        timer = null;
        body = document.createElement('div');
        render(<FinishingBody state={state} />, body);
        // Not to be dismissed: there is nothing to go back to, and the
        // analysis is saved whatever the modal does.
        showModal(t('sessions.finishing.title'), body, [], { dismissable: false });
      }, FINISHING_DELAY_MS);
      return;
    }
    if (timer) { clearTimeout(timer); timer = null; }
    if (body) {
      closeModalOf(body);
      render(null, body);
      body = null;
    }
  };
}
