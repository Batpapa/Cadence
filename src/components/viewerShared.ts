import type { Attachment, FileEntry, ScoreFace } from '../types';
import { isAbcFile } from '../services/abcService';
import type { AudioPresetsBinding } from '../services/audioPresets';
import type { ScoreEditor } from './scoreEditor';

// ── What the file viewer and its formats share ────────────────────────────────
// The dialog itself is fileViewer.ts; the score, the PDF and the text are
// built in files of their own, handed the dialog as a ViewerContext.

/** What a format's builder is handed: the dialog's body to fill, and the
 *  dialog's life to hang its own on. */
export interface ViewerContext {
  entry: FileEntry;
  /** The dialog's body. */
  body: HTMLElement;
  opts: PreviewModalOpts | undefined;
  /** Writes the file's new text, when the caller passed a save callback:
   *  absent, the file is read-only here. The title follows a save made under
   *  another name (PreviewSaveResult). */
  save: ((text: string) => Promise<ViewerSaveOutcome>) | undefined;
  /** Whether the dialog has gone — for work that comes back after it. */
  closed: () => boolean;
  /** Runs `fn` as the dialog goes, whatever closes it — at once when it has
   *  gone already. In the order registered. */
  whenClosed: (fn: () => void) => void;
  /** Filled by the format, for the dialog's header and shell. */
  hooks: ViewerHooks;
  /** The height a picture, a film or a PDF gets in the dialog. */
  mediaMaxH: string;
}

/** What a format hands the dialog around it. Each is optional: the score is
 *  the only one with preferences, a syntax check and a way out to abcTools. */
export interface ViewerHooks {
  /** The preferences changed (the header's gear): the score re-primed. */
  reapplyPrefs?: () => void;
  /** The syntax check turned on or off there. */
  recheckSyntax?: () => void;
  /** The header's way out to abcTools: only the score knows which version is
   *  on screen. */
  openInAbcTools?: () => void;
  /** The dialog's own "Full page" toggled: what is sized against the room the
   *  dialog has follows it. */
  onExpanded?: (expanded: boolean) => void;
  /** Whether closing has to ask first — an edit not saved — and asks; true
   *  when it did, `dismiss` running once it is answered (see
   *  ModalOptions.guardDismiss). */
  guardClose?: (dismiss: () => void) => boolean;
}

/** What a save did: written; `refused` — the user backed out of a question
 *  the save had to ask, nothing written; `failed` — not written (a full
 *  device, typically). */
export type ViewerSaveOutcome = 'saved' | 'refused' | 'failed';

// ── MIME helpers ──────────────────────────────────────────────────────────────

export function isText(entry: FileEntry): boolean {
  return entry.mimeType.startsWith('text/') ||
    entry.name.endsWith('.md') || entry.name.endsWith('.txt');
}

// ── Preview modal ─────────────────────────────────────────────────────────────

export function modalWidth(entry: FileEntry): string {
  const m = entry.mimeType;
  if (m.startsWith('audio/') || (isText(entry) && !isAbcFile(entry))) return '560px';
  return '860px';
}

/** A score's dialog while it shows the stave and the ABC together (the "both"
 *  face): room for the two side by side, the stave keeping about the width it
 *  has alone. Still capped by the screen (modal.tsx's `modalMaxW`). */
export const BOTH_FACES_WIDTH = '1400px';

export interface PreviewModalOpts {
  /** Multi-tune ABC files: which splitAbcTunes() index to open at — the
   *  attachment's stored `preferredIndex`, if any. */
  initialIndex?: number;
  /** An ABC score opened already transposed, in semitones: a card's score
   *  opened from a detection, in the key it was played in (2026-11-07). The
   *  reader's own transposition from there, never stored either. */
  initialTranspose?: number;
  /** Called when the user stars a version as the new default. Independent of
   *  `onSave` — available in read-only contexts (study) too, since picking a
   *  favorite version isn't "editing" the card's content. */
  /** `undefined` clears the preference — see the star button for what that means. */
  onSetPreferredIndex?: (index: number | undefined) => void;
  /** Which version wears the ★, `undefined` meaning none does.
   *
   *  Separate from `initialIndex` because the two only coincide where the
   *  viewer opens a score AT its favourite. A session summary opens one at the
   *  version just PLAYED, while the star belongs wherever the card actually put
   *  it — possibly nowhere.
   *
   *  Deliberately NOT defaulted to `initialIndex`: that would make "no
   *  favourite" indistinguishable from "field omitted" and light the star on
   *  whatever version happened to be opened, which is exactly what a session
   *  preview showed on 2026-09-06. Every caller offering `onSetPreferredIndex`
   *  states it. */
  favoriteIndex?: number;
  /** Re-reads the file, for an entry whose content is DERIVED and can change
   *  while it is open. A set's fused score is rebuilt from its member tunes on
   *  every read, so a preference that changes how it is built — writing the
   *  repeats out, say — has to reach the score already on screen; the viewer
   *  otherwise redraws the text it decoded when it opened.
   *
   *  Called on every preference re-apply. Return null to keep what is shown. */
  reloadEntry?: () => FileEntry | null;
  /** Makes the title renamable (the extension stays as it is). Gets the full
   *  new name; the viewer shows it itself. */
  onRename?: (name: string) => void;
  /** An audio file's presets (audioPresets.ts). Absent: the player has no
   *  preset bar — there is nowhere to keep them. */
  audioPresets?: AudioPresetsBinding;
  /** A score with a recording of it: the viewer offers "Audio sync", which
   *  puts that recording's player in the score's place, the score following
   *  it (2026-10-28, the user). Today a detection's score, its recording the
   *  analysis's (session/ui/ScoreFollowView.tsx). */
  audioSync?: AudioSyncBinding;
  /** False: no source tabs (Synth, Audio sync, Play-along) over the transport
   *  — the synth alone. A set's score (the user, 2026-11-20). */
  sources?: boolean;
  /** Adds a recording to the card the score belongs to: the Play-along's
   *  take, kept (2026-11-01, the user). Absent — a score with no card, a
   *  detection's — the Play-along has no record button. */
  onKeepRecording?: (a: Attachment) => void;
  /** A score written elsewhere — TheSession's, which "Refresh" replaces whole
   *  (theSessionCopy.ts): the editor's tab is offered all the same, and
   *  pressing it hands over to this, with the version on screen, instead of
   *  opening the editor here. Without `onSave`. `carry`: its audio sync, when
   *  it is on, for the viewer opened next (`audioSyncCarry`). */
  editGate?: (version: number, carry?: AudioSyncCarry) => void;
  /** 'both': opens on the editor's face, a score opened to be written — the
   *  copy just made of TheSession's. Only with `onSave`. */
  initialFace?: 'both';
  /** An audio sync that was on in the viewer this one takes over from (the
   *  copy of TheSession's score, 2026-11-23): its binding in place of
   *  `audioSync`, turned on at opening. */
  audioSyncCarry?: AudioSyncCarry;
}

/** A viewer's audio sync, on, handed to the next viewer: the binding, its
 *  recording chosen already, and whether it was followed by force. */
export interface AudioSyncCarry { binding: AudioSyncBinding; forced: boolean }

/** What the viewer is handed to play a score along its recording. */
export interface AudioSyncBinding {
  /** The recording is only on Drive: the toggle wears the play button's cloud. */
  fromDrive: boolean;
  /** Whether this version — its ABC, as the viewer shows it — can be played
   *  along: the toggle is offered on those only. */
  plays: (version: string) => boolean;
  /** Asked each time the toggle is turned on, before `mount`: which of a
   *  card's recordings (cardAudioSync.ts). False: it stays off. */
  choose?: (version: string) => Promise<boolean>;
  /** Puts the audio sync of `version` in `host`, on the viewer's face (stave
   *  or text) and at its size, drawn in the viewer's key (`transpose`,
   *  semitones). `onState` hears how its alignment goes. `below`: the
   *  viewer's source tabs, to put between the score and the player.
   *  `editor`: its text box, written in on the editor's face (N3b). */
  mount: (
    host: HTMLElement, version: string, face: ScoreFace, expanded: boolean,
    onState: (s: AudioSyncState) => void, forced: boolean, transpose: number,
    below?: HTMLElement, editor?: ScoreEditor,
  ) => AudioSyncView;
}

/** Where an audio sync's alignment stands — what its toggle shows (2026-10-29,
 *  the user): filling up like a progress bar while it is made, then coloured
 *  by how well it fits, on followColour.ts's red-to-green scale — red when
 *  there is none to follow, too poor to be trusted or impossible. `percent`:
 *  the share of notes on the score, when there was an alignment. `title` says
 *  it in full, for the tooltip. */
export type AudioSyncState =
  | { kind: 'aligning'; ratio: number; title: string; again?: boolean }
  | { kind: 'aligned'; title: string; percent: number; keyGap?: number }
  | { kind: 'none'; title: string; percent?: number; keyGap?: number };
// `keyGap`: how many semitones above the score as shown the recording plays
// it (2026-11-07, the user: the gap is said wherever audio and score meet),
// -5 to +6; absent or 0 when they agree. `again`: aligned anew after an edit
// (N3b), which the toggle says.

/** An audio sync in place, as the viewer drives it: its versions, its tabs,
 *  its full page. */
export interface AudioSyncView {
  /** Another version on screen, one `plays` accepts: aligned anew, the
   *  player kept — the recording has not changed (2026-10-29, the user).
   *  `edited`: the version as it is being written, not saved (N3b). */
  setVersion: (version: string, edited?: boolean) => void;
  /** Followed even when the alignment is judged too poor to be (the hidden
   *  gesture on the toggle). */
  setForced: (forced: boolean) => void;
  setFace: (face: ScoreFace) => void;
  setExpanded: (expanded: boolean) => void;
  /** The viewer's transposition changed: the score drawn in that key, the
   *  gap to the recording measured from it. */
  setTranspose: (semitones: number) => void;
  unmount: () => void;
}

/** The Play-along in place (session/ui/PlayAlongView.tsx): the score
 *  following what the microphone hears, driven by the viewer's versions,
 *  tabs and full page as the audio sync is. */
export interface PlayAlongView {
  /** The version on screen now: its ABC, and its index in the file. */
  setVersion: (version: string, index: number) => void;
  setFace: (face: ScoreFace) => void;
  setExpanded: (expanded: boolean) => void;
  /** The viewer's transposition changed: the score is followed in that key. */
  setTranspose: (semitones: number) => void;
  /** A take recorded and neither kept nor discarded: asks first, and true
   *  when it did — `proceed` runs once it is answered. */
  settleTake: (proceed: () => void) => boolean;
  unmount: () => void;
}

/** What a save did. `false`: nothing was saved — the user backed out of a
 *  question the save had to ask — and the edit stays pending on screen. A
 *  string: saved, under that file name, which the viewer's title then shows. */
export type PreviewSaveResult = void | false | string;
