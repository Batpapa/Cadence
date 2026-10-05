import { isNative } from './platform';
import { t } from '../services/i18nService';
import type { Detection } from '../session/model';
import type { LiveNotificationAction, LiveNotificationState } from './liveNotification';

/**
 * A live analysis's life in the Android app outside the screen: the
 * foreground service and its lock-screen notification (LiveRecordingService),
 * and the hold on the page that keeps Chromium from freezing it (LiveRenderer).
 * No-op in a browser.
 *
 * The recording engine knows none of this: it hands over a snapshot getter and
 * three handlers at start, calls refresh when something it shows has changed,
 * and stop at the end.
 */

export interface LiveSnapshot {
  elapsedMs: number;
  paused: boolean;
  detections: Detection[];
}

export interface LiveHandlers {
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

let snapshot: (() => LiveSnapshot) | null = null;
let actionListener: { remove: () => Promise<void> } | null = null;
/** What the notification shows now — a refresh that would change nothing
 *  (most detection events: a bound moving, a confidence rising) is skipped. */
let shown = '';

const notification = () => import('./liveNotification');

/** Chromium's page freezing announces itself (Page Lifecycle API): logged so a
 *  background test reads the freeze straight from logcat, with its time. */
let lifecycleLogged = false;
function logPageLifecycle(): void {
  if (lifecycleLogged) return;
  lifecycleLogged = true;
  document.addEventListener('freeze', () => console.warn(`[native] page frozen at ${new Date().toISOString()}`));
  document.addEventListener('resume', () => console.warn(`[native] page resumed at ${new Date().toISOString()}`));
}

/** The tune being heard: the most recent detection, named the way the live
 *  screen names it (the card's name first, TheSession's index next). */
async function currentTuneText(detections: Detection[]): Promise<string | null> {
  const last = detections.reduce<Detection | null>((a, d) => (!a || d.start >= a.start ? d : a), null);
  if (!last) return null;
  const { tuneName } = await import('../session/ui/sessionUiShared');
  return tuneName(last).text;
}

async function stateFrom(s: LiveSnapshot): Promise<LiveNotificationState> {
  const tune = await currentTuneText(s.detections);
  return {
    title: s.paused ? t('native.live.titlePaused') : t('native.live.title'),
    text: tune ?? t('native.live.listening'),
    elapsedMs: Math.round(s.elapsedMs),
    paused: s.paused,
    labels: { pause: t('native.live.pause'), resume: t('native.live.resume'), stop: t('native.live.stop') },
    channelName: t('native.live.channel'),
  };
}

export async function startLiveForeground(getSnapshot: () => LiveSnapshot, handlers: LiveHandlers): Promise<void> {
  if (!isNative()) return;
  logPageLifecycle();
  snapshot = getSnapshot;
  shown = '';
  // The service keeps the microphone; this keeps Chromium from freezing the
  // page — where the audio graph and the recognition actually run — about a
  // minute after the app leaves the screen.
  void import('./liveRenderer')
    .then(m => m.LiveRenderer.hold())
    .catch(err => console.warn('[native] renderer not held', err));
  try {
    const { LiveNotification } = await notification();
    // Android 13+: without POST_NOTIFICATIONS the service still runs, but its
    // notification — the lock-screen control — never shows. A refusal is the
    // user's call; record anyway.
    const perm = await LiveNotification.checkPermissions();
    if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') await LiveNotification.requestPermissions();
    await actionListener?.remove();
    actionListener = await LiveNotification.addListener('action', ({ action }: { action: LiveNotificationAction }) => {
      if (action === 'pause') handlers.onPause();
      else if (action === 'resume') handlers.onResume();
      else handlers.onStop();
    });
    await refreshLiveForeground();
  } catch (err) {
    // The recording itself does not depend on this: it simply stays
    // foreground-only, as in the browser.
    console.warn('[native] foreground service not started', err);
  }
}

/** Something the notification shows may have changed. Cheap when it did not. */
export async function refreshLiveForeground(): Promise<void> {
  if (!isNative() || !snapshot) return;
  try {
    const s = snapshot();
    const state = await stateFrom(s);
    // The chronometer runs on its own, so elapsed time alone is no reason to
    // repost — except across a pause, where the clock must be re-anchored.
    const key = `${state.title}|${state.text}|${state.paused}`;
    if (key === shown) return;
    shown = key;
    const { LiveNotification } = await notification();
    await LiveNotification.show(state);
  } catch (err) {
    console.warn('[native] notification not updated', err);
  }
}

export async function stopLiveForeground(): Promise<void> {
  if (!isNative()) return;
  snapshot = null;
  shown = '';
  void import('./liveRenderer')
    .then(m => m.LiveRenderer.release())
    .catch(err => console.warn('[native] renderer not released', err));
  try {
    await actionListener?.remove();
    actionListener = null;
    const { LiveNotification } = await notification();
    await LiveNotification.stop();
  } catch (err) {
    console.warn('[native] foreground service not stopped', err);
  }
}
