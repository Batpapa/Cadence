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
// The extension itself: absent = its `absentOn`, explicit true/false = that
// (see UserExtensions) — users from before extensions keep the Irish one, and
// a new user starts with them all off. An option: absent = its declared
// default.
//
// Nested (2026-11-28, the user): Irish traditional music is a kind of music,
// so it sits under Music, and counts only while Music is on — its own flag
// kept meanwhile, as an option's is under its extension. Music came after the
// Irish one: its absence reads as the Irish one's own state, so whoever had
// the Irish extension has Music too, with nothing rewritten in their data.

export type ExtensionId = keyof UserExtensions;

/** The Transcription module ships with its recordings on Drive, as an
 *  analysis's are (the user, 2026-11-28: released together, and nobody using
 *  it before). Until then it lives in the dev server only: in a production
 *  build its option is not listed and nothing of it is offered, whatever a
 *  user's flags say. Webpack writes NODE_ENV in from its mode; under vitest it
 *  is 'test', the module there to be tested. */
const TRANSCRIPTION_RELEASED = process.env.NODE_ENV !== 'production';

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
  /** What the extension's flag means while it was never written — true or
   *  false, or another extension's own state (its flag, or its absence read
   *  the same way). Never changed once shipped: it is how a stored absence
   *  reads. */
  absentOn: boolean | ExtensionId;
  /** The extension this one is part of: it counts only while that one is on. */
  parent?: ExtensionId;
  options: ReadonlyArray<ExtensionOption>;
}

/** Every extension, in the order Settings lists them, each under its parent. */
export const EXTENSIONS: ReadonlyArray<Extension> = [
  {
    id: 'music',
    labelKey: 'extensions.music.title',
    descKey: 'extensions.music.desc',
    absentOn: 'irishTrad',
    options: [
      { id: 'cardTypes', labelKey: 'extensions.music.cardTypes', defaultOn: true, forced: true },
      ...(TRANSCRIPTION_RELEASED ? [{ id: 'transcription', labelKey: 'extensions.music.transcription', defaultOn: true }] : []),
    ],
  },
  {
    id: 'irishTrad',
    labelKey: 'extensions.irishTrad.title',
    descKey: 'extensions.irishTrad.desc',
    absentOn: true,
    parent: 'music',
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
  const parent = EXTENSIONS.find(e => e.id === id)?.parent;
  return ownState(id, user) && (!parent || extensionEnabled(parent, user));
}

/** The extension's own switch, its parent aside: its flag, or what its
 *  absence reads as. */
function ownState(id: ExtensionId, user: UserLike): boolean {
  const flag = user.extensions?.[id];
  if (flag !== undefined) return flag;
  const absent = EXTENSIONS.find(e => e.id === id)?.absentOn ?? false;
  return typeof absent === 'boolean' ? absent : ownState(absent, user);
}

/** The extension's own switch as Settings shows it — on or off whatever its
 *  parent is (a child greyed under a parent switched off keeps its own). */
export function extensionSwitch(id: ExtensionId, user: UserLike = appState.value): boolean {
  return ownState(id, user);
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

/** The tune and set card types. */
export function cardTypesOffered(user?: UserLike): boolean {
  return extensionOption('music', 'cardTypes', user);
}

/** The Transcription module. */
export function transcriptionOffered(user?: UserLike): boolean {
  return TRANSCRIPTION_RELEASED && extensionOption('music', 'transcription', user);
}

/** What a brand-new user starts with: every extension off. Written out
 *  rather than left absent, since absent means on. */
export function newUserExtensions(): UserExtensions {
  return Object.fromEntries(EXTENSIONS.map(e => [e.id, false])) as UserExtensions;
}
