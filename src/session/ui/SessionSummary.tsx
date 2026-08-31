import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import { TrashIcon, ResetIcon } from '../../components/icons';
import { playIcon, pauseIcon, stopIcon, downloadIcon } from '../../components/playbackIcons';
import { confirmModal } from '../../components/modal';
import { deleteSession, loadSessionAudio, saveSessionMeta, forgetSessionAudio } from '../db';
import type { RecordedSession, SessionAnnotation } from '../model';
import { AnnotationCard, type AnnotationCardOptions } from './AnnotationCard';
import { showShareSessionModal } from './ShareSessionModal';
import {
  fmtLongTime, defaultSessionName, TitleRow, DateRow,
  BoundControls, ClipControls, viterbiPickOf,
} from './sessionUiShared';
import { lastImportDump, lastLiveDump } from './sessionStore';

// ── Screen: summary ───────────────────────────────────────────────────────────
// A finished session: audio player, clickable segment timeline, annotation
// list with per-tune edit controls. Uses <AnnotationCard> directly as JSX,
// never the annotationCard() bridge — see ImportAnalysis.tsx's header doc for
// why (reentrant render() during this component's own render pass corrupts
// Preact's hooks bookkeeping).
//
// `session` is a mutable RecordedSession, edited in place (same object
// db.ts/saveSessionMeta persists) — merge/delete/bound-adjust/like all mutate
// it directly and then `bump()` a tick counter to force a re-render, rather
// than mirroring it into Preact state; matches the original's own
// renderList()/renderBar() re-invocation after each mutation.

const BUCKET_SEGMENT: Record<SessionAnnotation['bucket'], string> = {
  high: 'rgb(34 197 94 / 0.75)',
  medium: 'rgb(245 158 11 / 0.75)',
  low: 'rgb(120 120 120 / 0.55)',
};

interface SessionSummaryProps {
  session: RecordedSession;
  ctx: AppContext;
  onOpenCard: (cardId: string) => void;
  onReanalyze: () => void;
}

export function SessionSummary({ session, ctx, onOpenCard, onReanalyze }: SessionSummaryProps) {
  const listWrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const seekInpRef = useRef<HTMLInputElement>(null);
  const timeLblRef = useRef<HTMLSpanElement>(null);
  const seekingRef = useRef(false);
  const playingIdRef = useRef<string | null>(null);

  const [, setTick] = useState(0);
  const bump = () => setTick(x => x + 1);

  // Not persisted — resets each time the summary is opened, on purpose.
  const targetDeckIdsRef = useRef<Set<string> | undefined>(undefined);
  const ensureSummaryTargetDeckIds = () => {
    if (!targetDeckIdsRef.current) targetDeckIdsRef.current = new Set();
    return targetDeckIdsRef.current;
  };

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  playingIdRef.current = playingId;
  const sliceEndRef = useRef(0);

  const persist = () => { void saveSessionMeta(session); };

  // ── Audio load: streamed via a native <audio> element (no
  // decodeAudioData/waveform — sessions can run for hours). Revokes the
  // object URL whenever it's replaced (forgotten) or on unmount.
  useEffect(() => {
    let cancelled = false;
    void loadSessionAudio(session.id).then(blob => {
      if (!blob || cancelled) return;
      setAudioUrl(URL.createObjectURL(blob));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, []);
  useEffect(() => {
    if (!audioUrl) return;
    return () => URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  // Play/pause icon toggle.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    return () => { a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause); };
    // eslint-disable-next-line
  }, []);

  // Seek bar + time label (direct DOM writes on 'timeupdate' — high
  // frequency, not worth a Preact re-render) and per-annotation slice
  // playback: pauses at the slice's end bound, clears playingId when the
  // player stops for any reason.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const updateTime = () => {
      if (timeLblRef.current) timeLblRef.current.textContent = `${fmtLongTime(a.currentTime)} / ${fmtLongTime(a.duration || 0)}`;
    };
    const onLoadedMeta = () => { if (seekInpRef.current) seekInpRef.current.max = String(a.duration || 0); updateTime(); };
    const onTimeUpdate = () => {
      if (!seekingRef.current && seekInpRef.current) seekInpRef.current.value = String(a.currentTime);
      updateTime();
      if (playingIdRef.current !== null && a.currentTime >= sliceEndRef.current) a.pause();
    };
    const onPause = () => { if (playingIdRef.current !== null) setPlayingId(null); };
    a.addEventListener('loadedmetadata', onLoadedMeta);
    a.addEventListener('timeupdate', onTimeUpdate);
    a.addEventListener('pause', onPause);
    return () => {
      a.removeEventListener('loadedmetadata', onLoadedMeta);
      a.removeEventListener('timeupdate', onTimeUpdate);
      a.removeEventListener('pause', onPause);
    };
    // eslint-disable-next-line
  }, []);

  const playSlice = (ann: SessionAnnotation) => {
    const a = audioRef.current;
    if (!a) return;
    if (playingIdRef.current === ann.id) { a.pause(); return; }
    sliceEndRef.current = ann.end ?? session.duration;
    a.currentTime = ann.start;
    void a.play().catch(() => setPlayingId(null));
    setPlayingId(ann.id);
  };

  const previewBound = (tSec: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, tSec);
    void a.play().catch(() => { /* not loaded yet */ });
    setTimeout(() => a.pause(), 3000);
  };

  const dump = lastImportDump.value?.sessionId === session.id ? lastImportDump.value
    : lastLiveDump.value?.sessionId === session.id ? lastLiveDump.value
    : null;

  const cardOptsFor = (ann: SessionAnnotation, i: number): AnnotationCardOptions => ({
    ctx,
    onPlay: audioUrl ? playSlice : undefined,
    playingId,
    sessionStartMs: session.date === null ? undefined : Date.parse(session.date),
    onOpenCard,
    onCardAdded: bump,
    getTargetDeckIds: () => targetDeckIdsRef.current,
    ensureTargetDeckIds: ensureSummaryTargetDeckIds,
    onTargetDeckIdsChanged: bump,
    onToggleLike: (id) => {
      const target = session.annotations.find(a => a.id === id);
      if (!target) return;
      target.liked = !target.liked;
      persist();
      bump();
    },
    // No engine to delegate to for a finished session — same mutate-in-place
    // + persist() pattern as onToggleLike above, direct application of
    // LiveSession.selectAlternate()'s own doc (never applicable here since
    // nothing will ever re-run the segmenter on this annotation again, but
    // the userConfirmed/identity fields stay consistent with a live session's).
    onSelectAlternate: (id, pick) => {
      const target = session.annotations.find(a => a.id === id);
      if (!target) return;
      target.tuneId = pick.tuneId;
      target.settingId = pick.settingId;
      target.displayName = pick.displayName;
      target.dance = pick.dance;
      target.meter = pick.meter;
      target.userConfirmed = pick.tuneId !== viterbiPickOf(target).tuneId;
      persist();
      bump();
    },
    extraControls: () => {
      // Merge with previous annotation of the same tune (false set change).
      const prev = session.annotations[i - 1];
      return (
        <div class="flex items-center gap-2 flex-wrap pt-1 border-t border-border/50">
          {/* Bound adjustment: ±5 s with a 3 s audio preview at the new bound. */}
          <BoundControls ann={ann} getDuration={() => session.duration} persist={persist} refresh={bump} previewBound={previewBound} />

          {/* Download/attach clip — hidden (download) or reduced to just the
             "already attached" label (attach) once the session's audio has
             been forgotten (nothing left to extract from). */}
          <ClipControls ann={ann} session={session} audioAvailable={!!audioUrl} getAudio={() => loadSessionAudio(session.id)} ctx={ctx} onAttached={bump} />

          {prev && prev.tuneId === ann.tuneId && (
            <button
              class="text-[11px] text-accent hover:underline cursor-pointer"
              onClick={() => {
                prev.end = ann.end;
                prev.evidence = [...prev.evidence, ...ann.evidence];
                prev.confidence = Math.max(prev.confidence, ann.confidence);
                prev.bucket = prev.confidence >= 0.7 ? 'high' : prev.confidence >= 0.5 ? 'medium' : 'low';
                session.annotations.splice(i, 1);
                persist();
                bump();
              }}
            >
              {t('sessions.merge')}
            </button>
          )}

          {/* Confirmed: the row carries hand-made work (bound adjustments,
              alternate picks, attached clips) and there is no undo. */}
          <button
            class="text-dim hover:text-danger transition-colors cursor-pointer ml-auto"
            title={t('common.delete')}
            onClick={() => confirmModal(
              t('sessions.annotation.delete.title'),
              t('sessions.annotation.delete.message', { name: ann.displayName }),
              t('common.delete'),
              () => {
                session.annotations.splice(i, 1);
                persist();
                bump();
              },
            )}
          >
            <TrashIcon size={11} />
          </button>
        </div>
      );
    },
  });

  const downloadName = `${(session.name || defaultSessionName(session.date)).replace(/[^\w-]+/g, '_')}.${(session.mimeType.split('/')[1] || 'webm').split(';')[0]}`;

  return (
    <>
      <TitleRow
        getName={() => session.name}
        getDefaultName={() => defaultSessionName(session.date)}
        onRename={(val) => { session.name = val; persist(); }}
        onDelete={() => { void deleteSession(session.id).then(() => ctx.navigate({ view: 'sessions' })); }}
        onShare={() => showShareSessionModal(session)}
        getTargetDeckIds={() => targetDeckIdsRef.current}
        ensureTargetDeckIds={ensureSummaryTargetDeckIds}
      />
      <DateRow
        getDate={() => session.date}
        setDate={(date) => { session.date = date; persist(); }}
        onChange={bump}
      />

      <audio ref={audioRef} class="hidden" src={audioUrl ?? undefined} />

      {audioUrl && (
        <div class="flex items-center gap-2 mt-3 flex-wrap">
          <button
            class="w-7 h-7 p-0 rounded-full flex items-center justify-center shrink-0 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            onClick={() => { const a = audioRef.current; if (!a) return; if (a.paused) void a.play(); else a.pause(); }}
            dangerouslySetInnerHTML={{ __html: playing ? pauseIcon(12) : playIcon(12) }}
          />
          <button
            class="w-7 h-7 p-0 rounded-full flex items-center justify-center shrink-0 text-dim hover:text-primary transition-colors"
            onClick={() => { const a = audioRef.current; if (!a) return; a.pause(); a.currentTime = 0; }}
            dangerouslySetInnerHTML={{ __html: stopIcon(12) }}
          />
          <input
            ref={seekInpRef}
            type="range"
            min="0"
            max="0"
            step="0.1"
            defaultValue="0"
            class="flex-1 min-w-[80px] accent-accent cursor-pointer"
            onInput={() => {
              seekingRef.current = true;
              const a = audioRef.current;
              if (a && seekInpRef.current) a.currentTime = parseFloat(seekInpRef.current.value);
            }}
            onChange={() => { seekingRef.current = false; }}
          />
          <span ref={timeLblRef} class="text-[11px] font-mono text-dim shrink-0 tabular-nums">0:00 / 0:00</span>
          <a
            class="text-dim hover:text-accent transition-colors cursor-pointer shrink-0 flex items-center"
            title={t('sessions.downloadAudio')}
            href={audioUrl}
            download={downloadName}
            dangerouslySetInnerHTML={{ __html: downloadIcon(14) }}
          />
          <button
            class="text-dim hover:text-accent transition-colors cursor-pointer shrink-0"
            title={t('sessions.reanalyze.hint')}
            onClick={() => confirmModal(t('sessions.reanalyze.title'), t('sessions.reanalyze.message'), t('sessions.reanalyze.confirm'), onReanalyze)}
          >
            <ResetIcon size={14} />
          </button>
          <button
            class="text-dim hover:text-danger transition-colors cursor-pointer shrink-0"
            title={t('sessions.forgetAudio.hint')}
            onClick={() => confirmModal(t('sessions.forgetAudio.title'), t('sessions.forgetAudio.message'), t('sessions.forgetAudio'), () => {
              void forgetSessionAudio(session.id).then(() => setAudioUrl(null));
            })}
          >
            <TrashIcon size={14} />
          </button>
        </div>
      )}

      <div
        class="relative h-5 rounded bg-elevated mt-3 overflow-hidden cursor-pointer"
        onClick={(e) => {
          const a = audioRef.current;
          if (!a) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          a.currentTime = ((e.clientX - rect.left) / rect.width) * session.duration;
        }}
      >
        {session.annotations.map(ann => {
          const end = ann.end ?? session.duration;
          return (
            <div
              key={ann.id}
              class="absolute top-0 bottom-0 hover:brightness-125 transition-[filter]"
              style={{
                left: `${(ann.start / session.duration) * 100}%`,
                width: `${Math.max(0.5, ((end - ann.start) / session.duration) * 100)}%`,
                background: BUCKET_SEGMENT[ann.bucket],
              }}
              title={ann.displayName}
              onClick={(e) => {
                e.stopPropagation();
                const a = audioRef.current;
                if (a) a.currentTime = ann.start;
                listWrapRef.current?.querySelector(`[data-ann-id="${ann.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
            />
          );
        })}
      </div>

      <div class="flex items-center gap-2 mt-3">
        {dump && (
          <button
            class="text-[11px] text-dim hover:text-primary hover:underline cursor-pointer ml-auto"
            onClick={() => {
              const blob = new Blob([JSON.stringify(dump.windows, null, 1)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${(session.name || 'session').replace(/[^\w-]+/g, '_')}-windows.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 5000);
            }}
          >
            {t('sessions.dumpWindows')}
          </button>
        )}
      </div>

      <div ref={listWrapRef} class="mt-3 space-y-2">
        {session.annotations.map((ann, i) => (
          <div key={ann.id} data-ann-id={ann.id}>
            <AnnotationCard ann={ann} opts={cardOptsFor(ann, i)} />
          </div>
        ))}
      </div>
    </>
  );
}
