import { appState, mutate } from '../store';
import { companionAudio, audioExtensionFor } from '../session/companionAudio';
import { audioDownloads } from '../session/audioDownloads';
import { SYNC_AUDIO_BY_DEFAULT } from '../session/db';
import {
  getTranscriptionAudio, putTranscriptionAudio, deleteTranscriptionAudio,
  transcriptionAudioKeys, transcriptionDbUserId,
} from './audioDb';
import { editTranscriptionModule, transcriptionModuleOf } from './model';

// ── The recordings on Drive (2026-11-28) ─────────────────────────────────────
// "Comme l'analyse" (the user): a transcription's recording is copied to Drive
// as a file of its own, heard from there on the user's other devices, brought
// here, freed from here — by the analyser's own code (session/companionAudio.ts
// and audioDownloads.ts), with this module's records, database and names. Its
// choices are the module's: copied by default, as the analyser's
// (SYNC_AUDIO_BY_DEFAULT, the same reason — a recording only this device has
// is one the browser may wipe), each set in the module's settings.

/** The file a recording is on Drive: the transcription's id in its name, as an
 *  analysis's is (services/driveOrphans.ts reads it — never renamed). */
export function transcriptionFileName(id: string, mimeType: string): string {
  return `cadence-transcription-${id}.${audioExtensionFor(mimeType)}`;
}

export const transcriptionAudio = companionAudio({
  log: '[transcription]',
  userId: transcriptionDbUserId,
  local: {
    get: getTranscriptionAudio,
    put: putTranscriptionAudio,
    delete: deleteTranscriptionAudio,
    keys: transcriptionAudioKeys,
  },
  synced: (user) => transcriptionModuleOf(user)?.syncedAudio,
  record: (user, id, entry) => editTranscriptionModule(user, mod => {
    mod.syncedAudio ??= {};
    mod.syncedAudio[id] = entry;
  }),
  drop: (user, ids) => {
    const mod = transcriptionModuleOf(user);
    if (!mod?.syncedAudio) return;
    for (const id of ids) delete mod.syncedAudio[id];
    if (Object.keys(mod.syncedAudio).length === 0) delete mod.syncedAudio;
  },
  ids: (user) => Object.keys(transcriptionModuleOf(user)?.transcriptions ?? {}),
  // ISO, so that it sorts as the analyser's dates do
  recency: (user, id) => {
    const at = transcriptionModuleOf(user)?.transcriptions[id]?.createdAt;
    return at === undefined ? '' : new Date(at).toISOString();
  },
  mimeType: (id) => Promise.resolve(transcriptionModuleOf(appState.value)?.transcriptions[id]?.mimeType),
  syncByDefault: (user) => transcriptionModuleOf(user)?.syncAudioByDefault ?? SYNC_AUDIO_BY_DEFAULT,
  fileName: transcriptionFileName,
  keys: { wanted: 'transcriptionAudioUploadsWanted', freed: 'transcriptionAudioFreed', wifiOnly: 'transcriptionAudioUploadWifiOnly' },
});

/** Bringing them onto this device — this module's choices, on this device. */
export const transcriptionDownloads = audioDownloads({
  log: '[transcription]',
  userId: transcriptionDbUserId,
  driveOnly: transcriptionAudio.driveOnly,
  fetch: transcriptionAudio.fetch,
  freedIds: transcriptionAudio.freedIds,
  synced: () => transcriptionModuleOf(appState.value)?.syncedAudio,
  keys: { mode: 'transcriptionAudioDownloadMode', wifiOnly: 'transcriptionAudioDownloadWifiOnly' },
});

/** The module's choice — both values written, absence meaning yes (CLAUDE.md:
 *  a flag whose absence says yes). */
export async function setTranscriptionSyncByDefault(on: boolean): Promise<void> {
  await mutate(user => editTranscriptionModule(user, mod => { mod.syncAudioByDefault = on; }));
}
