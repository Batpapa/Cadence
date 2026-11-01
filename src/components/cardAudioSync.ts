import type { Attachment, FileAttachment } from '../types';
import type { AudioSyncBinding } from './fileViewer';

// ── A card's score, following one of its recordings ──────────────────────────
// The score viewer's "Audio sync" for a card's own ABC (2026-10-31, the user;
// out of developer mode 2026-11-01): any of its scores but a set's generated one, with
// the card's audio or video attachments. One recording: followed at once.
// Several: asked which, with a way to compare them all first
// (session/ui/cardRecordingSync.tsx, loaded only then). Nothing is
// remembered: another recording is the toggle off and on again. A score
// opened from a detection keeps the detection's recording alone
// (abcPreview.tsx), whatever its card holds.

/** Audio the follower cannot read, though the type says audio. */
const NOT_SOUND = /midi|avi|msvideo/i;

/** A file whose sound the score can follow: audio, or a video's — whatever
 *  the follower's demuxers take (clipExtract.ts openAudioInput), which AVI
 *  is not. */
function isFollowableRecording(a: Attachment): a is FileAttachment {
  if (a.type !== 'file') return false;
  const m = a.mimeType.toLowerCase();
  return (m.startsWith('audio/') || m.startsWith('video/')) && !NOT_SOUND.test(m) && !/\.(avi|midi?)$/i.test(a.name);
}

/** The audio sync of a score among `attachments`, or undefined when there is
 *  nothing to follow it with. */
export function cardAudioSync(attachments: Attachment[]): AudioSyncBinding | undefined {
  const recordings = attachments.filter(isFollowableRecording);
  if (recordings.length === 0) return undefined;
  let chosen: FileAttachment | null = null;
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
