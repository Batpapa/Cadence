import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { AppContext } from '../../types';
import { t } from '../../services/i18nService';
import { HeartIcon, CloudIcon } from '../../components/icons';
import { playIcon, stopIcon } from '../../components/playbackIcons';
import { showModal, closeModal, alertModal } from '../../components/modal';
import { formatBytes } from '../../utils';
import { appState } from '../../store';
import { loadSessionAudio, fetchSyncedAudio, audioDownloadProgress, audioArrivals } from '../db';
import { audioDownloadMode } from '../audioDownloads';
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
  /** Whether this analysis's recording is on this device — false until
   *  probed, true as soon as a download brings it. */
  isHere: (sessionId: string) => boolean;
  /** Looks up which of these analyses still have their recording on this
   *  device. Only ever for what is on screen — never a whole library. */
  probe: (sessionIds: string[]) => void;
  /** Plays a passage — downloading its recording first if it is only on
   *  Drive, asking before that in the manual mode (audioDownloads.ts). */
  play: (sessionId: string, detection: Detection) => Promise<void>;
}

/** The Drive copy of this analysis's recording, read live off the state: it
 *  arrives with a sync from the device that recorded it. */
function syncedAudioEntry(sessionId: string): SyncedAudio | null {
  const mod = appState.value.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  return mod?.syncedAudio?.[sessionId] ?? null;
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

/** Brings a recording that is only on Drive onto this device, for a passage
 *  someone just asked to hear. Null when they declined, or it could not be
 *  had — said in a dialog, since a button that does nothing explains nothing. */
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
    alertModal(
      t('sessions.syncAudio.failed.title'),
      t('sessions.syncAudio.failed.message', { error: e instanceof Error ? e.message : String(e) }),
    );
    return null;
  }
}

/** The rows of one tune come from different evenings, so there is no single
 *  recording to hold open. The one that is playing is the one that is loaded;
 *  moving to another evening re-points the element. Native <audio>, never
 *  decodeAudioData: an analysis can run for hours. */
export function useSlicePlayer(): SlicePlayer {
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadedRef = useRef<{ sessionId: string; url: string } | null>(null);
  const sliceEndRef = useRef<number>(Infinity);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState<Record<string, boolean>>({});

  // The object URL points at a whole recording; leaving the screen is the
  // last chance to let it go.
  useEffect(() => () => {
    if (loadedRef.current) URL.revokeObjectURL(loadedRef.current.url);
  }, []);

  const probe = (sessionIds: string[]) => {
    const unknown = [...new Set(sessionIds)].filter(id => !(id in hasAudio));
    if (unknown.length === 0) return;
    void Promise.all(unknown.map(async id => [id, !!(await loadSessionAudio(id))] as const))
      .then(pairs => setHasAudio(prev => ({ ...prev, ...Object.fromEntries(pairs) })));
  };

  const play = async (sessionId: string, detection: Detection) => {
    const a = audioRef.current;
    if (!a) return;
    const start = Math.max(0, detection.start);
    // STOP, not pause — the same call the incipit's button makes. A passage is
    // under a minute, so there is nothing to come back to in the middle of it,
    // and pressing it again plays it from its own start.
    if (playingId === detection.id) { a.pause(); a.currentTime = start; setPlayingId(null); return; }

    if (loadedRef.current?.sessionId !== sessionId) {
      let blob = await loadSessionAudio(sessionId);
      if (!blob) {
        blob = await fetchForPlayback(sessionId) ?? undefined;
        if (!blob) return;
        setHasAudio(prev => ({ ...prev, [sessionId]: true }));
      }
      if (loadedRef.current) URL.revokeObjectURL(loadedRef.current.url);
      const url = URL.createObjectURL(blob);
      loadedRef.current = { sessionId, url };
      a.src = url;
    }
    sliceEndRef.current = detection.end ?? Infinity;
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

  return { audio, playingId, isHere, probe, play };
}

/** The play button of a passage. Three looks: the recording is here; it is
 *  only on Drive (a small cloud on the same button — playing it fetches it);
 *  it is coming down (a ring filling around the button). */
function PlayPassButton({ sessionId, detection, player }: {
  sessionId: string; detection: Detection; player: SlicePlayer;
}) {
  const here = player.isHere(sessionId);
  const onDrive = !here ? syncedAudioEntry(sessionId) : null;
  const progress = audioDownloadProgress.value[sessionId];
  if (!here && !onDrive) return null;
  const playing = player.playingId === detection.id;
  const downloading = progress !== undefined;
  const title = downloading
    ? t('sessions.playFromDrive.downloading', { percent: Math.round(progress * 100) })
    : onDrive
      ? t('sessions.playFromDrive.hint', { size: formatBytes(onDrive.bytes) })
      : t(playing ? 'sessions.stopSlice' : 'sessions.playSlice');
  return (
    <span
      class="relative w-6 h-6 rounded-full flex items-center justify-center shrink-0"
      // The ring: the button's own disc, drawn over a sweep of the accent.
      style={downloading ? { background: `conic-gradient(var(--color-accent) ${progress * 360}deg, transparent 0)` } : undefined}
    >
      <button
        class={`${downloading ? 'w-5 h-5 bg-surface text-accent cursor-default' : 'w-6 h-6 cursor-pointer'} p-0 rounded-full flex items-center justify-center shrink-0 transition-colors ${
          downloading ? '' : playing ? 'bg-accent text-white' : 'bg-accent/10 text-accent hover:bg-accent/20'}`}
        title={title}
        aria-label={title}
        disabled={downloading}
        dangerouslySetInnerHTML={{ __html: playing ? stopIcon(10) : playIcon(10) }}
        onClick={() => { void player.play(sessionId, detection); }}
      />
      {onDrive && !downloading && (
        <span class="absolute -right-1 -bottom-0.5 text-accent pointer-events-none drop-shadow-sm">
          <CloudIcon size={10} />
        </span>
      )}
    </span>
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
