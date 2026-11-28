import { signal } from '@preact/signals';
import { alertModal } from '../../components/modal';
import { t } from '../../services/i18nService';
import { needsAudioSniff, sniffAudioMime } from '../../services/audioSniff';
import { probeAudioDuration } from '../../session/audio/sources';
import type { TranscriptionSettings, TranscriptionSource } from '../model';
import { putPendingTake, getPendingTake, deletePendingTake } from '../audioDb';

// ── A transcription being set up ─────────────────────────────────────────────
// Between the recording chosen (or just made) and the transcription stored:
// the passage, the settings, the name. In a signal, as the analyser's import
// screen is (session/ui/sessionStore.ts): a recording is not something a route
// can carry. Nothing of it is stored until the transcription is done.

export interface SetupSource {
  audio: Blob;
  /** What the recording is called where it came from (a file's name). */
  label: string;
  source: TranscriptionSource;
  /** Seconds. */
  duration: number;
  mimeType: string;
}

export interface Setup {
  source: SetupSource;
  /** The passage, in seconds of the recording. */
  from: number;
  to: number;
  settings: TranscriptionSettings;
  name: string;
  /** Transcribing a stored transcription again (2026-11-28, the user: a
   *  button for it after all): which one — its draft replaced in place. */
  redo?: { id: string };
  /** The folder on screen when the recording was chosen: where the
   *  transcription is filed (null, the root). */
  folder?: string | null;
}

export const setup = signal<Setup | null>(null);

/** The recording's type: what it says, or what its head says when what it
 *  says is a guess (fileTransfer.ts's rule — audioSniff.ts). */
async function mimeTypeOf(audio: Blob): Promise<string> {
  if (!needsAudioSniff(audio.type)) return audio.type;
  try {
    return sniffAudioMime(new Uint8Array(await audio.slice(0, 4096).arrayBuffer())) ?? audio.type;
  } catch {
    return audio.type;
  }
}

/** The name a recording's file suggests, its extension left out. */
export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}

/** A recording chosen or made: on to its setup — the whole of it, nothing
 *  said of it yet. Says so and stops when it cannot be read here. */
export async function startSetup(audio: Blob, label: string, source: TranscriptionSource, folder: string | null = null): Promise<void> {
  const duration = await probeAudioDuration(audio);
  if (!duration || !(duration > 0)) {
    alertModal(t('transcribe.title'), t('transcription.unreadable'));
    return;
  }
  const mimeType = (await mimeTypeOf(audio)) || 'application/octet-stream';
  // a take exists nowhere else: kept at once (audioDb.ts, PendingTake)
  if (source === 'mic' || source === 'device') {
    try { await putPendingTake({ audio, label, source, duration, mimeType, folder }); } catch (e) { console.warn('[transcription] take not kept', e); }
  }
  setup.value = fresh({ audio, label, source, duration, mimeType }, folder);
}

function fresh(source: SetupSource, folder: string | null = null): Setup {
  return { source, from: 0, to: source.duration, settings: {}, name: baseName(source.label), folder };
}

/** The setup of a take kept and not transcribed (a tab closed, a phone that
 *  dropped the page), back — when no other setup is on. */
export async function resumePendingTake(): Promise<void> {
  if (setup.value) return;
  const take = await getPendingTake().catch(() => undefined);
  if (take && !setup.value) setup.value = fresh(take, take.folder ?? null);
}

/** The setup gone — transcribed, or abandoned: its take with it, when it is
 *  one. Another setup (a file, a transcription done again) has none of its
 *  own: a take kept meanwhile stays, and comes back next. */
export function endSetup(): void {
  const s = setup.value;
  const take = !!s && !s.redo && (s.source.source === 'mic' || s.source.source === 'device');
  setup.value = null;
  if (take) void deletePendingTake().catch(() => {});
}
