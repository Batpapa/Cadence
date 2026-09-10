import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import type { Route } from '../types';
import { WaveformIcon, TrendIcon } from './icons';

// ── Pinning a module to the navigation ───────────────────────────────────────
// Answers a field request (2026-09-09) that asked for something else: "the
// home screen should be the recording screen". Refused as put — Cadence is
// generalist first, and a spaced-repetition app whose front door is an audio
// recorder is a different product — but the complaint underneath it was fair:
// someone who opens Cadence to record is three taps from recording, every
// time, forever.
//
// So the destination moves instead of the home page: one module can be pinned
// beside Home and Library, in the header on a desktop and in the bottom bar on
// a phone. It is a shortcut, not a home page — the app still opens where it
// always did, and the pin is removed exactly where it was placed.
//
// One at a time on purpose. The bar it lands in is the most contested space in
// the app (six items on a 360 px phone), and "which of my modules matter" is a
// question with one honest answer for almost everybody: the one they use.
//
// PER DEVICE, not per user (decided 2026-09-10): localStorage, not the synced
// blob. The analyser earns its place on the phone that goes to the session and
// not on the desktop where cards get made — same person, same account, two
// different answers. That is also why the bottom bar exists at all.

export interface PinnableModule {
  /** Stored in localStorage. An open string, like `Card.type`: a build that no
   *  longer knows an id degrades to "nothing pinned" rather than breaking the
   *  header. */
  id: string;
  labelKey: string;
  route: Route;
  Icon: (props: { size?: number }) => JSX.Element;
}

export const PINNABLE_MODULES: PinnableModule[] = [
  { id: 'sessions', labelKey: 'sessions.moduleTitle', route: { view: 'sessions' }, Icon: WaveformIcon },
  { id: 'trending', labelKey: 'trending.moduleTitle', route: { view: 'trending' }, Icon: TrendIcon },
];

const PIN_KEY = 'cadence_pinned_module';

function readPin(): string | null {
  // Throws outright in some privacy modes, so never let it reach a render.
  try { return localStorage.getItem(PIN_KEY); } catch { return null; }
}

/** The pinned id, as a signal so both bars redraw the moment it changes —
 *  they are in a different tree from the modules page that sets it. */
export const pinnedModuleId = signal<string | null>(readPin());

/** The pinned module, or undefined — which covers both "nothing pinned" (the
 *  default, and the only sensible one: a shortcut nobody asked for is clutter)
 *  and an id this build does not know. */
export function pinnedModule(): PinnableModule | undefined {
  const id = pinnedModuleId.value;
  return PINNABLE_MODULES.find(m => m.id === id);
}

/** Pinning is a radio, not a checkbox: pinning a second module replaces the
 *  first, and pinning the one already there removes it. */
export function togglePin(id: string): void {
  const next = pinnedModuleId.value === id ? null : id;
  pinnedModuleId.value = next;
  try {
    if (next === null) localStorage.removeItem(PIN_KEY);
    else localStorage.setItem(PIN_KEY, next);
  } catch { /* private mode: the pin lasts for this session only */ }
}

/** Whether the current route is the pinned module's — for the active state in
 *  the two bars. Compares the view alone: a session opened from the analyser
 *  is still "in" the analyser, and a shortcut that stops looking active the
 *  moment it is used would be lying about where the user is. */
export function isPinnedRouteActive(route: Route, mod: PinnableModule | undefined): boolean {
  if (!mod) return false;
  return route.view === mod.route.view;
}
