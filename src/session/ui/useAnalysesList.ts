import { useEffect, useState } from 'preact/hooks';
import { listSessions } from '../db';
import { recoverOrphanedSessions } from '../recovery';
import { showRecoveryFailures } from './RecoveryFailureModal';
import { showLiveBackupOffers } from './LiveBackupOfferModal';
import { sweepLiveBackups } from '../liveBackup';
import { activeLive } from './sessionStore';
import type { Analysis } from '../model';

/** Every analysis, read once the recovery pass has run — for the two pages
 *  that list them: the analyses (SessionLibrary) and the detections
 *  (DetectionsLibrary), one page each since 2026-11-20 and two tabs of one
 *  screen before. Both ran this pass on arrival then, and both still do.
 *
 *  `loaded`: whether the list has been read at least once. The detections
 *  wait for it: their chips ignore any analysis they cannot find, and before
 *  the first read that is every one of them — the filter sections would open
 *  collapsed, as if the route had carried no filter at all.
 *
 *  `reload`: deleting a folder deletes the recordings it holds, the one action
 *  on these pages that changes what EXISTS rather than how it is arranged — so
 *  the list has to be re-read rather than re-derived. */
export function useAnalysesList(): { sessions: Analysis[]; loaded: boolean; reload: () => void } {
  const [sessions, setSessions] = useState<Analysis[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = () => { void listSessions().then(setSessions); };

  useEffect(() => {
    // The list loads whatever recovery did. It used to wait on recovery
    // succeeding outright, so a single orphan that threw left the library empty
    // on every visit, silently (2026-09-17). Recordings that could not be
    // recovered are put in front of the user instead, once the list is up.
    void recoverOrphanedSessions(activeLive.value?.sessionId)
      .catch((err: unknown) => {
        console.error('[sessions] recovery pass failed', err);
        return [];
      })
      .then(async failures => {
        setSessions(await listSessions());
        setLoaded(true);
        // Then the Drive backups, once the local failures have all been
        // decided — a recording this device lost entirely only exists there.
        showRecoveryFailures(failures, reload, () => {
          void sweepLiveBackups(activeLive.value?.sessionId).then(offers => showLiveBackupOffers(offers, reload));
        });
      });
    // eslint-disable-next-line
  }, []);

  return { sessions, loaded, reload };
}
