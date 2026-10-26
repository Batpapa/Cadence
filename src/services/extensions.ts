import { appState } from '../store';
import type { User, UserExtensions } from '../types';

// ── Extensions (2026-10-26) ──────────────────────────────────────────────────
// Cadence is for anything worth remembering; what is only of use to one kind
// of learner comes as an extension, switched on per user in Settings →
// Extensions. One for now: Irish traditional music.
//
// An extension OFFERS things and owns nothing. Switched off, its entry points
// disappear — TheSession and irishtune.info from "New card", the analyser and
// Trending from Modules, a card's "Detected in" — and every card, analysis
// and setting it made stays as it is, ready for the day it is switched back
// on. So nothing here gates a route or a piece of data.
//
// Each extension has its own options, one per thing it offers, shown under its
// switch in Settings. An option counts only while its extension is on.
//
// The extension itself: absent = on, explicit false = off (see
// UserExtensions) — users from before extensions keep everything, a new user
// starts with them off. An option: absent = its declared default.

export type ExtensionId = keyof UserExtensions;

export interface ExtensionOption {
  id: string;
  labelKey: string;
  /** What an option nobody has set is. */
  defaultOn: boolean;
  /** Always on with its extension, shown ticked and locked: what the
   *  extension is FOR, offered so that the list says what comes with it. */
  forced?: boolean;
}

export interface Extension {
  id: ExtensionId;
  labelKey: string;
  descKey: string;
  options: ReadonlyArray<ExtensionOption>;
}

/** Every extension, in the order Settings lists them. */
export const EXTENSIONS: ReadonlyArray<Extension> = [
  {
    id: 'irishTrad',
    labelKey: 'extensions.irishTrad.title',
    descKey: 'extensions.irishTrad.desc',
    options: [
      { id: 'theSession', labelKey: 'extensions.irishTrad.theSession', defaultOn: true, forced: true },
      { id: 'irishTuneInfo', labelKey: 'extensions.irishTrad.irishTuneInfo', defaultOn: false },
      { id: 'tuneAnalyser', labelKey: 'extensions.irishTrad.tuneAnalyser', defaultOn: true },
      { id: 'trending', labelKey: 'extensions.irishTrad.trending', defaultOn: true },
    ],
  },
];

type UserLike = Pick<User, 'extensions' | 'extensionOptions'>;

/** Reads the open user unless given one. Through the signal, so a component
 *  calling it redraws when the setting changes. */
export function extensionEnabled(id: ExtensionId, user: UserLike = appState.value): boolean {
  return user.extensions?.[id] !== false;
}

/** Whether one of an extension's options is on — never while the extension
 *  itself is off. */
export function extensionOption(ext: ExtensionId, option: string, user: UserLike = appState.value): boolean {
  if (!extensionEnabled(ext, user)) return false;
  const def = EXTENSIONS.find(e => e.id === ext)?.options.find(o => o.id === option);
  if (!def) return false;
  if (def.forced) return true;
  return user.extensionOptions?.[ext]?.[option] ?? def.defaultOn;
}

export function irishTradEnabled(user?: UserLike): boolean {
  return extensionEnabled('irishTrad', user);
}

/** TheSession as a source of cards. */
export function theSessionOffered(user?: UserLike): boolean {
  return extensionOption('irishTrad', 'theSession', user);
}

/** irishtune.info as a source of cards. */
export function irishTuneInfoOffered(user?: UserLike): boolean {
  return extensionOption('irishTrad', 'irishTuneInfo', user);
}

/** The tune analyser module, and what it found shown on cards. */
export function tuneAnalyserOffered(user?: UserLike): boolean {
  return extensionOption('irishTrad', 'tuneAnalyser', user);
}

/** The Trending module. */
export function trendingOffered(user?: UserLike): boolean {
  return extensionOption('irishTrad', 'trending', user);
}

/** What a brand-new user starts with: every extension off. Written out
 *  rather than left absent, since absent means on. */
export function newUserExtensions(): UserExtensions {
  return Object.fromEntries(EXTENSIONS.map(e => [e.id, false])) as UserExtensions;
}
