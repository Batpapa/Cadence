import { generateId } from '../utils';
import type { Detection } from '../session/model';
import { DetectionTracker, type DetectionConfirmation } from '../session/detectionState';
import type { SourceKind } from './tuneFinder';

// ── The list, kept through a crash (2026-10-31) ───────────────────────────────
// A frame killed mid-listening — out of memory, or the phone reclaiming a tab
// left in the background — took the whole evening's list with it: "lost
// everything each time it crashed" (a cellist's session, Pixel 6). The list is
// now written to the frame's own storage as it grows, and a page that died
// without leaving hands it to the next one. A page left normally takes it
// away: nothing stays on someone else's site from one visit to the next (the
// user's call — as the standalone analyser, TuneAnalyser/).
//
// The names only — the decoder's detections and the user's confirmations, what
// DetectionTracker needs to put the list back. Never the sound: 29 MB an hour
// is not for localStorage, and it would outlive the page that recorded it.
//
// One key per page, and one Web Lock held for the page's life. A key whose
// lock is free belongs to a page that is gone; a key whose lock is held is a
// page still open in another tab, listening perhaps, and is left alone.
//
// One way of leaving keeps it too (2026-11-01): a tune's name followed in the
// same tab (`links=same`, The Session's choice) — to read the tune, and come
// back with the back button. The list is then handed only to a page reached
// that way, which the frame's navigation entry says (`back_forward`, measured
// the same in Chromium, Firefox and WebKit for a frame whose page came back);
// any other visit drops it, as if the page had been left.

const KEY_PREFIX = 'cadence_finder_runs:';
const LOCK_PREFIX = 'cadence-finder-';
/** At most this late: a crash loses the last second of changes. */
const SAVE_DELAY_MS = 1000;

export interface SavedRun {
  kind: SourceKind;
  label: string;
  startedAt: number;
  /** How far into the recording it was heard — where a tune still open when
   *  the page died is closed. */
  heardS: number;
  decoder: Detection[];
  confirmations: DetectionConfirmation[];
}

/** A saved run's list, put back together and over: the decoder's detections
 *  fed back under the confirmations, as the analyser's recovery replays its
 *  windows under a draft's. A tune still open when the page died is closed
 *  where the decoder had got to, and nothing in it is settling any more. */
export function trackerOf(saved: SavedRun): DetectionTracker {
  const tracker = new DetectionTracker();
  tracker.restore(saved.confirmations);
  tracker.finish(saved.decoder.map(d => ({
    type: 'close' as const,
    detection: { ...d, end: d.end ?? Math.max(d.start, saved.heardS), finalized: true },
  })));
  return tracker;
}

/** What one page leaves under its key. */
interface SavedPage {
  runs: SavedRun[];
  /** Left by a tune's link, rather than dead: for a return by the back
   *  button only. */
  leftBy?: 'link';
}

/** Absent, or refused (storage blocked for a third-party frame): then nothing
 *  is kept, as before. */
function storage(): Storage | null {
  try { return localStorage; } catch { return null; }
}

/** Whether this page was reached by the back (or forward) button. */
function cameBack(): boolean {
  try {
    return (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'back_forward';
  } catch { return false; }
}

export class RunStore {
  private readonly id = generateId();
  private timer = 0;
  private collect: (() => SavedRun[]) | null = null;
  /** Between a pagehide and the pageshow that brings the page back, if any. */
  private left = false;
  /** A tune's link was just followed in this tab: the page is about to go. */
  private byLink = false;
  /** Whether this page holds its lock — without it, it cannot tell a dead
   *  page from a live one, and takes nothing. */
  private readonly locked: Promise<boolean>;

  constructor() {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    this.locked = locks
      ? new Promise<boolean>(granted => {
        locks.request(LOCK_PREFIX + this.id, () => {
          granted(true);
          return new Promise<void>(() => { /* held until the page goes */ });
        }).catch(() => granted(false));
      })
      : Promise.resolve(false);
  }

  /** The runs of pages that died without leaving — and, back from a tune's
   *  page, of the one that went there — oldest first, taken: they are this
   *  page's to keep now. `canTake` is asked once the locks are known, and a no
   *  leaves them for the next page. A page left by a link and not come back
   *  to is dropped. */
  async takeOrphans(canTake: () => boolean, back = cameBack()): Promise<SavedRun[]> {
    const store = storage();
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!store || !locks || !(await this.locked)) return [];
    const held = new Set((await locks.query()).held?.map(l => l.name));
    if (!canTake()) return [];
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(KEY_PREFIX) && !held.has(LOCK_PREFIX + key.slice(KEY_PREFIX.length))) keys.push(key);
    }
    const runs: SavedRun[] = [];
    for (const key of keys) {
      try {
        const saved = JSON.parse(store.getItem(key) ?? 'null') as SavedPage | null;
        if (Array.isArray(saved?.runs) && (saved.leftBy !== 'link' || back)) runs.push(...saved.runs);
      } catch { /* unreadable: dropped with its key */ }
      store.removeItem(key);
    }
    return runs.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** A tune's link is being followed in this tab: the coming leave keeps the
   *  list for a return by the back button. */
  leavingByLink(): void {
    this.byLink = true;
  }

  /** Saved a moment after the change, from what `collect` gives then — once a
   *  second at most, however often things change. */
  schedule(collect: () => SavedRun[]): void {
    this.collect = collect;
    if (this.left || this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = 0; this.write(); }, SAVE_DELAY_MS);
  }

  /** The page is left: what it heard goes with it — unless by a tune's link,
   *  when it stays, as it is now, for a return by the back button. */
  leave(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.byLink) {
      this.write('link');
    } else {
      try { storage()?.removeItem(KEY_PREFIX + this.id); } catch { /* nothing kept then */ }
    }
    this.left = true;
  }

  /** Back from the back/forward cache: still this page's list, in memory. */
  back(): void {
    this.left = false;
    this.byLink = false;
    this.write();
  }

  private write(leftBy?: SavedPage['leftBy']): void {
    const store = storage();
    if (!store || this.left) return;
    const runs = this.collect?.() ?? [];
    try {
      const page: SavedPage = leftBy ? { runs, leftBy } : { runs };
      if (runs.length === 0) store.removeItem(KEY_PREFIX + this.id);
      else store.setItem(KEY_PREFIX + this.id, JSON.stringify(page));
    } catch (err) {
      // Full, or refused: the list is only on screen, as it was before.
      console.warn('[thesession-embed] could not keep the list', err);
    }
  }
}
