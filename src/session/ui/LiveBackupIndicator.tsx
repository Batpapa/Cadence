import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { isDriveConnected } from '../../services/driveService';
import { timeAgo } from '../../utils';
import { CloudUpIcon } from '../../components/icons';
import type { LiveSession } from '../liveSession';
import { backupLiveSession, liveBackupStatus } from '../liveBackup';

// ── "Last backup: 4 min ago" on the live screen (2026-09-17) ───────────────────
// Phase 1 of the live backup: the press IS the backup. Always offered while
// Drive is connected — the automatic backup of phase 2 will not replace it,
// only add to it.
//
// A press is a gesture, so it may raise Google's sign-in window when the
// hour-long token has run out. On Android that sends the app to the background
// for a few seconds, and the microphone records silence meanwhile — accepted
// (decided 2026-09-17) as the price of a copy off the device.

/** How often the "n min ago" is re-read. A minute is its resolution. */
const AGO_REFRESH_MS = 30_000;

export function LiveBackupIndicator({ live }: { live: LiveSession }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(x => x + 1), AGO_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  if (!isDriveConnected()) return null;

  const status = liveBackupStatus.value[live.sessionId];
  const busy = status?.busy ?? false;
  const error = status?.error ?? null;
  const lastAt = status?.lastAt ?? null;

  const label =
    busy ? t('sessions.liveBackup.sending') :
    lastAt !== null ? t('sessions.liveBackup.last', { ago: timeAgo(lastAt) }) :
    t('sessions.liveBackup.never');
  // Same colour code as the recording's own sync button in the summary: the
  // accent while it moves, red when the last attempt failed. A success keeps
  // the quiet colour, since "saved 40 min ago" is not an all-clear.
  const tone =
    busy ? 'text-accent animate-pulse cursor-default' :
    error ? 'text-danger cursor-pointer' :
    'text-dim hover:text-muted cursor-pointer';

  return (
    <div class="flex justify-end mt-1.5">
      <button
        class={`flex items-center gap-1.5 text-[11px] transition-colors ${tone}`}
        // An automatic round never opens a sign-in window, so the one failure
        // that is not really a failure is "no token". Saying so is what tells
        // the user that pressing solves it — pressing IS the gesture a token
        // needs (see driveService's getToken).
        title={
          error === null ? t('sessions.liveBackup.hint')
          : /needs_auth|auth_failed/.test(error) ? t('sessions.liveBackup.needsAuth')
          : t('sessions.liveBackup.failed', { error })
        }
        disabled={busy}
        // The outcome is in liveBackupStatus, which this renders — nothing
        // left for the rejection to say here.
        onClick={() => { void backupLiveSession(live, true).catch(() => {}); }}
      >
        <CloudUpIcon size={12} />
        <span>{label}</span>
      </button>
    </div>
  );
}
