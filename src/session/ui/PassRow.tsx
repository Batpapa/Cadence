import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon, CloudIcon } from '../../components/icons';
import { playIcon, pauseIcon, stopIcon } from '../../components/playbackIcons';
import { showModal, closeModal, alertModal } from '../../components/modal';
import { formatBytes } from '../../utils';
import { appState } from '../../store';
import { COMPANION_GONE, readCompanionRange } from '../../services/driveService';
import { loadSessionAudio, fetchSyncedAudio, audioDownloadProgress, audioArrivals } from '../db';
import { audioDownloadMode } from '../audioDownloads';
import { fetchRemotePassage } from '../audio/remotePassage';
import { TUNE_ANALYSER_MODULE_KEY, type Detection, type SyncedAudio, type TuneAnalyserModuleData } from '../model';
import { BUCKET_TEXT, ClipControls, fmtLongTime, type ClipSessionRef } from './sessionUiShared';
import { AbcPreview } from './abcPreview';

// ── One pass through a tune, wherever a list of them is shown ─────────────────
// The analyser's tunes tab and a card's "Detected in" panel list the same
// thing — every time a tune was heard, each its own place in a recording — so
// they list it the same way, with the same controls in the same order (decided
// with the user, 2026-09-13):
//
//   [play] [ABC] [time] [analysis ♥] [download clip] [add clip to card]
//
// Hearing and reading come first because both lists are for tunes being
// learnt; the time and the analysis are where the pass lives, and lead there;
// the clip controls close the line because they are what is done last.

/** Passages from several evenings, played through ONE audio element. */
export interface SlicePlayer {
  /** Render it once, anywhere in the list: it is hidden. */
  audio: VNode;
  playingId: string | null;
  /** The detection whose passage is on its way from Drive. */
  loadingId: string | null;
  /** Whether this analysis's recording is on this device — false until
   *  probed, true as soon as a download brings it. */
  isHere: (sessionId: string) => boolean;
  /** Looks up which of these analyses still have their recording on this
   *  device. Only ever for what is on screen — never a whole library. */
  probe: (sessionIds: string[]) => void;
  /** Plays a passage — from this device when its recording is here, else
   *  straight from Drive (remotePassage.ts), and only when its format allows
   *  neither by downloading the whole recording first, asking before that in
   *  the manual mode (audioDownloads.ts). */
  play: (sessionId: string, detection: Detection) => Promise<void>;
}

/** The Drive copy of this analysis's recording, read live off the state: it
 *  arrives with a sync from the device that recorded it. */
export function syncedAudioEntry(sessionId: string): SyncedAudio | null {
  const mod = appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  return mod?.syncedAudio?.[sessionId] ?? null;
}

/** The analysis's length, which a passage read from Drive needs: asking the
 *  file would mean reading all of it. */
function sessionDuration(sessionId: string): number {
  const mod = appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  return mod?.sessions[sessionId]?.duration ?? 0;
}

/** The manual mode's question. Resolves false on any way out of the dialog. */
function confirmDownload(bytes: number): Promise<boolean> {
  return new Promise(resolve => {
    const body = document.createElement('p');
    body.className = 'text-sm text-muted leading-relaxed';
    body.textContent = t('sessions.playFromDrive.message', { size: formatBytes(bytes) });
    showModal(t('sessions.playFromDrive.title'), body, [
      { label: t('common.cancel'), onClick: () => { closeModal(); resolve(false); } },
      { label: t('sessions.playFromDrive.ok'), primary: true, onClick: () => { closeModal(); resolve(true); } },
    ], { onDismiss: () => resolve(false) });
  });
}

function alertFailed(e: unknown): void {
  if (e instanceof Error && e.message === COMPANION_GONE) {
    alertModal(t('sessions.syncAudio.gone.title'), t('sessions.syncAudio.gone.message'));
    return;
  }
  alertModal(
    t('sessions.syncAudio.failed.title'),
    t('sessions.syncAudio.failed.message', { error: e instanceof Error ? e.message : String(e) }),
  );
}

/** Brings a whole recording that is only on Drive onto this device — now only
 *  for a format no passage can be read from (remotePassage.ts). Null when the
 *  user declined, or it could not be had — said in a dialog, since a button
 *  that does nothing explains nothing. */
async function fetchForPlayback(sessionId: string): Promise<Blob | null> {
  const entry = syncedAudioEntry(sessionId);
  if (!entry) return null;
  if (audioDownloadMode.value === 'manual' && !await confirmDownload(entry.bytes)) return null;
  try {
    // Interactive: a click led here, and in the browser a sign-in window may
    // be what stands between the user and the passage.
    const blob = await fetchSyncedAudio(sessionId);
    if (!blob) alertModal(t('sessions.syncAudio.gone.title'), t('sessions.syncAudio.gone.message'));
    return blob;
  } catch (e) {
    alertFailed(e);
    return null;
  }
}

/** How many passages fetched from Drive are kept, so that playing one again —
 *  the usual way to listen — costs nothing. They are under a megabyte or two. */
const PASSAGES_KEPT = 8;

/** The rows of one tune come from different evenings, so there is no single
 *  recording to hold open. The one that is playing is the one that is loaded;
 *  moving to another evening re-points the element. Native <audio>, never
 *  decodeAudioData: an analysis can run for hours.
 *
 *  A recording that is only on Drive is not loaded at all: its passage is,
 *  fetched on its own (lot 5 #13, 2026-10-10) — a small file of its own that
 *  plays from its start. */
export function useSlicePlayer(): SlicePlayer {
  const audioRef = useRef<HTMLAudioElement>(null);
  /** What the element holds: a whole recording (its URL is ours to revoke) or
   *  a passage (its URL belongs to the cache below). */
  const loadedRef = useRef<{ key: string; url: string; whole: boolean } | null>(null);
  const passagesRef = useRef(new Map<string, string>());
  const sliceEndRef = useRef<number>(Infinity);
  /** The latest play asked for: a passage that arrives after another one was
   *  asked for must not start playing. */
  const requestRef = useRef(0);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState<Record<string, boolean>>({});

  // The object URLs point at recordings and passages; leaving the screen is
  // the last chance to let them go.
  useEffect(() => () => {
    if (loadedRef.current?.whole) URL.revokeObjectURL(loadedRef.current.url);
    for (const url of passagesRef.current.values()) URL.revokeObjectURL(url);
  }, []);

  const probe = (sessionIds: string[]) => {
    const unknown = [...new Set(sessionIds)].filter(id => !(id in hasAudio));
    if (unknown.length === 0) return;
    void Promise.all(unknown.map(async id => [id, !!(await loadSessionAudio(id))] as const))
      .then(pairs => setHasAudio(prev => ({ ...prev, ...Object.fromEntries(pairs) })));
  };

  const load = (a: HTMLAudioElement, key: string, url: string, whole: boolean) => {
    if (loadedRef.current?.key === key) return;
    if (loadedRef.current?.whole) URL.revokeObjectURL(loadedRef.current.url);
    loadedRef.current = { key, url, whole };
    a.src = url;
  };

  /** The passage from Drive: cached, fetched, or — for a format that cannot
   *  be read in part — null, and the caller falls back on the whole file.
   *  Undefined when it failed, the user having been told. */
  const passageUrl = async (sessionId: string, entry: SyncedAudio, detection: Detection): Promise<string | null | undefined> => {
    const end = detection.end ?? sessionDuration(sessionId);
    const key = `${sessionId}:${detection.start}:${end}`;
    const cached = passagesRef.current.get(key);
    if (cached) return cached;
    try {
      const clip = await fetchRemotePassage(
        (s, e) => readCompanionRange(entry.fileId, s, e, true),
        { bytes: entry.bytes, duration: sessionDuration(sessionId) },
        Math.max(0, detection.start),
        end,
        entry.fileId,
      );
      if (!clip) return null;
      const url = URL.createObjectURL(clip.blob);
      passagesRef.current.set(key, url);
      while (passagesRef.current.size > PASSAGES_KEPT) {
        const [oldest, oldUrl] = passagesRef.current.entries().next().value!;
        passagesRef.current.delete(oldest);
        if (loadedRef.current?.url !== oldUrl) URL.revokeObjectURL(oldUrl);
      }
      return url;
    } catch (e) {
      alertFailed(e);
      return undefined;
    }
  };

  const play = async (sessionId: string, detection: Detection) => {
    const a = audioRef.current;
    if (!a) return;
    const request = ++requestRef.current;
    // STOP, not pause — the same call the incipit's button makes. A passage is
    // under a minute, so there is nothing to come back to in the middle of it,
    // and pressing it again plays it from its own start.
    if (playingId === detection.id) { a.pause(); setPlayingId(null); return; }

    let start = Math.max(0, detection.start);
    let end = detection.end ?? Infinity;
    const wholeKey = `whole:${sessionId}`;
    const local = loadedRef.current?.key === wholeKey ? null : await loadSessionAudio(sessionId);
    if (local) {
      load(a, wholeKey, URL.createObjectURL(local), true);
    } else if (loadedRef.current?.key !== wholeKey) {
      const entry = syncedAudioEntry(sessionId);
      if (!entry) return;
      a.pause();
      setLoadingId(detection.id);
      const url = await passageUrl(sessionId, entry, detection);
      setLoadingId(id => (id === detection.id ? null : id));
      if (url === undefined || request !== requestRef.current) return;
      if (url) {
        load(a, `passage:${url}`, url, false);
        // The passage is its own file: it starts at 0 and ends where it ends.
        start = 0;
        end = Infinity;
      } else {
        const blob = await fetchForPlayback(sessionId);
        if (!blob || request !== requestRef.current) return;
        setHasAudio(prev => ({ ...prev, [sessionId]: true }));
        load(a, wholeKey, URL.createObjectURL(blob), true);
      }
    }
    sliceEndRef.current = end;
    a.currentTime = start;
    try { await a.play(); } catch { setPlayingId(null); return; }
    setPlayingId(detection.id);
  };

  const audio = (
    <audio
      ref={audioRef}
      class="hidden"
      onPause={() => setPlayingId(null)}
      onEnded={() => setPlayingId(null)}
      onTimeUpdate={(e) => {
        const a = e.currentTarget;
        if (a.currentTime >= sliceEndRef.current) a.pause();
      }}
    />
  );

  const isHere = (sessionId: string) => !!hasAudio[sessionId] || audioArrivals.value.has(sessionId);

  return { audio, playingId, loadingId, isHere, probe, play };
}

/** The play button of a passage, wherever one is shown — the lists of passes
 *  here and the cards of an analysis (DetectionCard) — so that hearing a
 *  passage looks and behaves the same in all three places (user's call,
 *  2026-10-10). Its looks: playing or not; a small cloud when the recording is
 *  only on Drive, the passage then coming from there; a ring turning while it
 *  comes; a ring filling while a whole recording comes down. */
export function PlayDisc({ playing, fromDrive, loading, progress, stops, title, onClick }: {
  playing: boolean;
  fromDrive: boolean;
  loading?: boolean;
  /** 0–1 while a whole recording is downloading. */
  progress?: number;
  /** Stop (back to the passage's start) rather than pause. */
  stops?: boolean;
  title: string;
  onClick: () => void;
}) {
  const downloading = progress !== undefined;
  const ring = downloading || loading;
  const icon = playing ? (stops ? stopIcon(10) : pauseIcon(10)) : playIcon(10);
  return (
    <span class="relative w-6 h-6 rounded-full flex items-center justify-center shrink-0">
      {/* The ring: a sweep of the accent behind the button's own disc — filled
          to the download's progress, or a quarter turning while a passage
          comes. */}
      {ring && (
        <span
          class={`absolute inset-0 rounded-full ${loading && !downloading ? 'animate-spin' : ''}`}
          style={{ background: `conic-gradient(var(--color-accent) ${downloading ? progress! * 360 : 90}deg, transparent 0)` }}
        />
      )}
      <button
        class={`relative ${ring ? 'w-5 h-5 bg-surface text-accent cursor-default' : 'w-6 h-6 cursor-pointer'} p-0 rounded-full flex items-center justify-center shrink-0 transition-colors ${
          ring ? '' : playing ? 'bg-accent text-white' : 'bg-accent/10 text-accent hover:bg-accent/20'}`}
        title={title}
        aria-label={title}
        disabled={ring}
        dangerouslySetInnerHTML={{ __html: icon }}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      />
      {fromDrive && !ring && (
        <span class="absolute -right-1 -bottom-0.5 text-accent pointer-events-none drop-shadow-sm">
          <CloudIcon size={10} />
        </span>
      )}
    </span>
  );
}

/** Its title, in the one place the four states are worded. */
export function playDiscTitle(o: { playing: boolean; fromDrive: boolean; loading?: boolean; progress?: number; stopWord?: boolean }): string {
  if (o.progress !== undefined) return t('sessions.playFromDrive.downloading', { percent: Math.round(o.progress * 100) });
  if (o.loading) return t('sessions.playFromDrive.loading');
  if (o.playing) return t(o.stopWord ? 'sessions.stopSlice' : 'sessions.playSlice');
  return o.fromDrive ? t('sessions.playFromDrive.hint') : t('sessions.playSlice');
}

/** The play button of a pass. No button at all when the recording is neither
 *  here nor on Drive. */
function PlayPassButton({ sessionId, detection, player }: {
  sessionId: string; detection: Detection; player: SlicePlayer;
}) {
  const here = player.isHere(sessionId);
  const fromDrive = !here && !!syncedAudioEntry(sessionId);
  if (!here && !fromDrive) return null;
  const progress = audioDownloadProgress.value[sessionId];
  const state = {
    playing: player.playingId === detection.id,
    fromDrive,
    loading: player.loadingId === detection.id,
    progress,
  };
  return (
    <PlayDisc
      {...state}
      stops
      title={playDiscTitle({ ...state, stopWord: true })}
      onClick={() => { void player.play(sessionId, detection); }}
    />
  );
}

export function PassRow({ session, detection, cardId, ctx, player, interactive, onOpen, onAttached }: {
  session: ClipSessionRef;
  detection: Detection;
  /** The card this tune already has — lets the ABC preview offer its ★. */
  cardId?: string;
  ctx: AppContext;
  player: SlicePlayer;
  /** False while something else owns the clicks (the tunes tab's selection):
   *  the links stop looking like links, and `onOpen` decides what happens. */
  interactive: boolean;
  /** The time and the analysis name both lead to the pass inside its analysis. */
  onOpen: (e: MouseEvent) => void;
  onAttached?: () => void;
}) {
  return (
    // Never wraps. A pass is one line, and its glyphs are columns read
    // downwards — a row that folded would take its columns with it.
    <div class="flex items-center gap-2 min-w-0">
      {/* Fixed slots, filled or not: what can be done with a pass depends on
          the pass — an analysis whose audio was forgotten offers no listening
          and no clip — and without reserved room the glyphs of one row would
          sit under the wrong glyphs of the next. */}
      <div class="shrink-0 flex items-center gap-1.5">
        <span class="w-6 flex items-center justify-center shrink-0">
          <PlayPassButton sessionId={session.id} detection={detection} player={player} />
        </span>
        <AbcPreview settingId={detection.settingId} displayName={detection.displayName} cardId={cardId} ctx={ctx} />
      </div>

      <button
        class={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-border ${interactive ? 'cursor-pointer hover:border-accent' : ''} ${
          detection.userConfirmed ? 'text-success' : BUCKET_TEXT[detection.bucket]}`}
        title={t('sessions.openDetection')}
        onClick={onOpen}
      >
        {fmtLongTime(detection.start)}
      </button>

      <button
        class={`text-sm text-muted min-w-0 text-left flex-1 inline-flex items-center gap-1.5 ${interactive ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
        // The full name, since the visible one is cut.
        title={session.name}
        onClick={onOpen}
      >
        <span class="truncate min-w-0">{session.name}</span>
        {/* THIS pass, not the tune: a tune hearted once must not look hearted
            on every line. */}
        {detection.liked && (
          <span class="text-danger shrink-0 flex items-center"><HeartIcon size={10} filled /></span>
        )}
      </button>

      <div class="shrink-0 flex items-center gap-1.5">
        <ClipControls
          ann={detection}
          session={session}
          audioAvailable={player.isHere(session.id)}
          getAudio={() => loadSessionAudio(session.id)}
          ctx={ctx}
          onAttached={onAttached}
          aligned
        />
      </div>
    </div>
  );
}
