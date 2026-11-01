import type { Attachment, EmbedEntry, FileAttachment } from '../types';
import type { AudioSyncBinding } from './fileViewer';
import { isFileEmbed } from '../services/embedService';
import { typeFromUrl } from '../services/remoteFile';

// ── A card's score, following one of its recordings ──────────────────────────
// The score viewer's "Audio sync" for a card's own ABC (2026-10-31, the user;
// out of developer mode 2026-11-01): any of its scores but a set's generated one, with
// the card's audio or video attachments — and its links to an audio file
// (2026-11-01), which Cadence reads as its own player does. One recording:
// followed at once. Several: asked which, with a way to compare them all first
// (session/ui/cardRecordingSync.tsx, loaded only then). Nothing is
// remembered: another recording is the toggle off and on again. A score
// opened from a detection keeps the detection's recording alone
// (abcPreview.tsx), whatever its card holds.

/** A recording the score can follow: an attached file, or a link to one. */
export type CardRecording =
  | { kind: 'file'; att: FileAttachment }
  | { kind: 'link'; entry: EmbedEntry };

/** Audio the follower cannot read, though the type says audio. */
const NOT_SOUND = /midi|avi|msvideo/i;
const NOT_SOUND_NAME = /\.(avi|midi?)$/i;

/** A type whose sound the score can follow: audio, or a video's — whatever
 *  the follower's demuxers take (clipExtract.ts openAudioInput), which AVI
 *  is not. */
function isSoundType(mime: string): boolean {
  const m = mime.toLowerCase();
  return (m.startsWith('audio/') || m.startsWith('video/')) && !NOT_SOUND.test(m);
}

/** A link Cadence reads itself (remoteFile.ts) — not a platform's player, not
 *  a page opened in a tab — whose URL does not say it is something else. Its
 *  type is only known once read: a URL with no telling extension is offered
 *  (the user), and fails at decoding if it is no sound after all. */
function isSoundLink(entry: EmbedEntry): boolean {
  if (!isFileEmbed(entry) || NOT_SOUND_NAME.test(entry.url.split(/[?#]/)[0]!)) return false;
  const guess = typeFromUrl(entry.url);
  return guess === '' || isSoundType(guess);
}

/** The recordings among `attachments`, in their order. */
export function cardRecordings(attachments: Attachment[]): CardRecording[] {
  const out: CardRecording[] = [];
  for (const a of attachments) {
    if (a.type === 'file' && isSoundType(a.mimeType) && !NOT_SOUND_NAME.test(a.name)) out.push({ kind: 'file', att: a });
    else if (a.type === 'embed' && isSoundLink(a)) out.push({ kind: 'link', entry: a });
  }
  return out;
}

/** The audio sync of a score among `attachments`, or undefined when there is
 *  nothing to follow it with. */
export function cardAudioSync(attachments: Attachment[]): AudioSyncBinding | undefined {
  const recordings = cardRecordings(attachments);
  if (recordings.length === 0) return undefined;
  let chosen: CardRecording | null = null;
  let ui: typeof import('../session/ui/cardRecordingSync') | null = null;
  return {
    fromDrive: false,
    // As a detection's: a version is a tune when it has a key.
    plays: (version) => /^K:/m.test(version),
    choose: async (version) => {
      ui ??= await import('../session/ui/cardRecordingSync');
      chosen = recordings.length === 1 ? recordings[0]! : await ui.chooseRecording(recordings, version);
      return chosen !== null;
    },
    mount: (host, version, face, expanded, onState, forced) =>
      ui!.mountRecordingFollow(host, chosen!, { version, face, expanded, onState, forced }),
  };
}
