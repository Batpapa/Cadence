import type { Metre, Mode } from '../session/recognition/transcription';
import type { SessionFolder } from '../session/model';
import { treeOfFields, writeTreeFields, type SessionTree } from '../session/sessionTree';

// ── The Transcription module's data (2026-11-27) ─────────────────────────────
// A recording written out as an ABC draft (session/recognition/transcribeAudio.ts),
// kept with the recording it came from, to be listened to, corrected, and
// turned into a card or added to one. What is here is synced with the rest
// of the user's blob (Drive, IndexedDB) under `modules.transcription`; the
// recordings themselves are not — they live in the module's own local
// database (audioDb.ts), as the analyser's do.
//
// ⚠️ Every name below is in users' data from the first release on: never
// renamed (CLAUDE.md, "Un champ sérialisé ne se renomme pas"). Optional
// fields may be added.

export const TRANSCRIPTION_MODULE_KEY = 'transcription';

export interface TranscriptionModuleData {
  /** ⚠️ NAME FROZEN. Every transcription, by id. The FIRST key of the slice:
   *  the Drive comparison counts a module's records in its first key
   *  (stateDiff.ts's modulesDiff). */
  transcriptions: Record<string, TranscriptionRecord>;
  /** Folders, as the analyser's (session/sessionTree.ts) and in the same shape,
   *  so that the same code arranges both — a folder's `sessionIds` holding
   *  transcriptions here. Absent until the first folder is made; the list of
   *  transcriptions is the truth, the tree only an arrangement (one in no
   *  folder shows at the root). */
  folders?: Record<string, SessionFolder>;
  rootFolderIds?: string[];
  rootSessionIds?: string[];
}

/** Where a recording came from — the analyser's ways in. */
export type TranscriptionSource = 'mic' | 'device' | 'file' | 'link';

/** What the user said of the recording before it was transcribed. Each one
 *  absent was told from the recording (transcribeAudio.ts, TranscribeSettings). */
export interface TranscriptionSettings {
  /** The dance chosen — an open string, as `Card.type` is (DANCES in
   *  settings.ts): a build that no longer knows one shows it as none. */
  dance?: string;
  /** The metre, as M: writes it (parseMetre): the dance's, set with it, or
   *  typed — kept as typed, read only if it parses (transcribeSettingsOf). */
  metre?: Metre;
  /** The key: its tonic's pitch class (0 = C) and its mode. */
  key?: { tonic: number; mode?: Mode };
  // No tempo (2026-11-28, the user: of no use — the transcriber finds it).
  // The engine still takes one (TranscribeSettings.bpm).
}

export interface TranscriptionRecord {
  id: string;
  name: string;
  /** When it was transcribed (ms). */
  createdAt: number;
  source: TranscriptionSource;
  /** The recording as it came — a file's name, a link — shown, never opened. */
  origin?: string;
  /** The recording's length (seconds) and the type its bytes are stored as. */
  duration: number;
  mimeType: string;
  /** The passage transcribed, in seconds of the recording. */
  from: number;
  to: number;
  settings: TranscriptionSettings;
  /** The ABC as the transcriber wrote it (with its X: and T: lines): kept as
   *  it was whatever is done to `abc` after — to go back to, and one day, with
   *  the user's say-so, the truth the transcriber learns from (the user,
   *  2026-11-27). */
  draft: string;
  /** The ABC as corrected. Absent: the draft, untouched. */
  abc?: string;
}

/** Anything that carries the modules — AppState, or a plain blob read back. */
type WithModules = { modules?: Record<string, unknown> };

/** The module's slice of `user`, as stored: undefined for someone who never
 *  transcribed anything. The one cast of `modules.transcription`. */
export function transcriptionModuleOf(user: WithModules): TranscriptionModuleData | undefined {
  return user.modules?.[TRANSCRIPTION_MODULE_KEY] as TranscriptionModuleData | undefined;
}

/** Edits the module's slice of `user` — a draft inside mutate() — creating it
 *  when absent and attaching it back. */
export function editTranscriptionModule(user: WithModules, fn: (mod: TranscriptionModuleData) => void): void {
  user.modules ??= {};
  const mod = transcriptionModuleOf(user) ?? { transcriptions: {} };
  fn(mod);
  user.modules[TRANSCRIPTION_MODULE_KEY] = mod;
}

/** The folders' tree (session/sessionTree.ts, the analyser's code), detached. */
export function transcriptionTreeOf(user: WithModules): SessionTree {
  return treeOfFields(transcriptionModuleOf(user));
}

/** Applies `fn` to the tree and writes it back — inside a mutate, as
 *  editSessionTree. */
export function editTranscriptionTree(user: WithModules, fn: (tree: SessionTree) => void): void {
  const tree = transcriptionTreeOf(user);
  fn(tree);
  editTranscriptionModule(user, m => writeTreeFields(m, tree));
}

/** Every transcription, the latest first. */
export function transcriptionsOf(user: WithModules): TranscriptionRecord[] {
  return Object.values(transcriptionModuleOf(user)?.transcriptions ?? {}).sort((a, b) => b.createdAt - a.createdAt);
}

/** The ABC a transcription reads as now: its correction, else its draft. */
export function currentAbc(record: TranscriptionRecord): string {
  return record.abc ?? record.draft;
}

/** `abc` with its first title moved from `from` to `to` — only when it still
 *  reads `from`: a title the user wrote in is theirs. The name and the score's
 *  T: line kept together through a renaming, a card named otherwise, a tune
 *  transcribed again under another name (the review of 2026-11-28). */
export function retitled(abc: string, from: string, to: string): string {
  const m = /^T:[ \t]*(.*)$/m.exec(abc);
  if (!m || m[1]!.trim() !== from.trim()) return abc;
  return abc.slice(0, m.index) + `T: ${to}` + abc.slice(m.index + m[0].length);
}
