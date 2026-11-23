import { t } from '../../services/i18nService';
import { appState, replaceSibling } from '../../store';
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/icons';
import { sessionsOf } from '../detections';
import { generatedSessionName } from '../sessionNaming';
import { sessionTreeOf, siblingSessions } from '../sessionTree';
import { useArrowKeys } from './FocusView';

// ── From one analysis to the next, in its folder (2026-11-23) ────────────────
// The first step of the swipe the user asked for: going through a folder of
// evenings without climbing back to the list each time.
//
// A thin line above the title, each neighbour by its name. Two tries before
// it, the same day: the Focus view's big worded buttons, a row of their own
// ("ça prend énormément de place", the user — and stepping through analyses
// is rarer than through tunes, which keep theirs); then two chevrons either
// side of the folder's line, which changed what that line is and moved with
// the title above it as its name wrapped. Above the title nothing moves it.
// Chevrons, not ← →: those are back and forward in the header.
//
// In the folder's order read backwards (siblingSessions): "next" is the more
// recent. Each step REPLACES the page rather than adding one (replaceSibling):
// back goes to the folder, its row of the last analysis seen flashing — what
// a tester asked of the list, "se souvenir dans quel enregistrement j'étais".

/** `keys`: whether the keyboard's ← and → step through the analyses — not in
 *  the Focus view, where they step through its tunes and stop at the first
 *  and last (the user's call, 2026-11-23: going on to the next analysis from
 *  there was tried, and dropped). */
export function AnalysisNav({ sessionId, keys }: { sessionId: string; keys: boolean }) {
  const user = appState.value;
  // A name left empty is shown as the generated one (db.ts, migrateSession):
  // the same here, without writing it into the state being read.
  const sessions = Object.values(sessionsOf(user)).map(s => ({
    id: s.id,
    date: s.date,
    name: s.name || generatedSessionName(s.source ?? 'live', s.date),
  }));
  const { prev, next } = siblingSessions(sessionTreeOf(user), sessions, sessionId);
  const go = (to: typeof prev) => to && (() => {
    replaceSibling({ view: 'sessions', sessionId: to.id }, `analysis:${sessionId}`, `analysis:${to.id}`);
  });
  useArrowKeys(keys, go(prev), go(next));
  // Alone in its folder: nothing to say, no line.
  if (!prev && !next) return null;

  /** One neighbour: its name, cut short to half the line — the whole line
   *  when it is the only one (the user, 2026-11-23) — the whole of it on
   *  hover, and to a screen reader with which way it is. */
  const link = (to: typeof prev, dir: 'prev' | 'next') => {
    if (!to) return <span />;
    const word = t(dir === 'prev' ? 'sessions.nav.prev' : 'sessions.nav.next');
    return (
      <button
        type="button"
        class={`min-h-8 min-w-0 ${prev && next ? 'max-w-[48%]' : 'max-w-full'} inline-flex items-center gap-1 text-xs text-dim hover:text-accent cursor-pointer transition-colors ${dir === 'next' ? 'flex-row-reverse' : ''}`}
        title={`${word} · ${to.name}`}
        aria-label={`${word} · ${to.name}`}
        onClick={go(to)}
      >
        <span class="shrink-0 flex items-center">{dir === 'prev' ? <ChevronLeftIcon size={12} /> : <ChevronRightIcon size={12} />}</span>
        <span class="truncate">{to.name}</span>
      </button>
    );
  };
  return (
    <div class="flex items-center justify-between gap-2 -mt-2 mb-1">
      {link(prev, 'prev')}
      {link(next, 'next')}
    </div>
  );
}
