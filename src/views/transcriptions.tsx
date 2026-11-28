import { useEffect } from 'preact/hooks';
import type { Route } from '../types';
import { setup, resumePendingTake } from '../transcription/ui/state';
import { SetupScreen } from '../transcription/ui/setup';
import { TranscriptionScreen } from '../transcription/ui/screen';
import { TranscriptionLibrary } from '../transcription/ui/library';

// ── The Transcription module (2026-11-27) ────────────────────────────────────
// `{ view: 'transcriptions' }`: the list — or, while one is being set up (a
// recording chosen, not transcribed yet: transcription/ui/state.ts), its setup.
// `{ view: 'transcriptions', id }`: one transcription, its score and recording.

export function TranscriptionsView(route: Extract<Route, { view: 'transcriptions' }>) {
  // A take kept and not transcribed (audioDb.ts, PendingTake): its setup back.
  useEffect(() => { void resumePendingTake(); }, []);
  if (route.id) return <TranscriptionScreen id={route.id} />;
  const s = setup.value;
  return (
    <div class="h-full overflow-y-auto view-enter">
      <div class="p-6">{s ? <SetupScreen s={s} /> : <TranscriptionLibrary initialSearch={route.search} folder={route.folder} />}</div>
    </div>
  );
}
