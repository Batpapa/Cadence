import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import type { ImportSession } from '../importSession';
import type { SessionAnnotation } from '../model';
import { AnnotationCard, type AnnotationCardOptions } from './AnnotationCard';
import { PitchShiftControl } from './PitchShiftControl';
import { useAutoFollowScroll } from './domInterop';
import {
  fmtLongTime, titleAndDeleteRow, editableDateRow, indexProgressText, fmtEta,
  appendBoundControls, appendClipControls, type ClipSessionRef,
} from './sessionUiShared';
import { importPlaybackWarn } from './sessionStore';

// ── Screen: file import ───────────────────────────────────────────────────────
// Turns an audio file into a full session: same recognition pipeline as live,
// faster than real time, with progress + ETA. The annotation feed reuses the
// live cards — watching them appear in accelerated time is the point.
//
// `imp.setCallbacks({...})` is a single-registration API (each call REPLACES
// the previous callbacks, not additive) — this component is the ONE place
// that calls it, fanning updates out to local state.
//
// Uses <AnnotationCard>/<PitchShiftControl> directly as JSX. Earlier
// versions of this component mounted them via a synchronous Preact render()
// call from inside a useMemo instead — reentrant (a render() call during
// another component's own render pass) and it corrupted Preact's hooks
// bookkeeping: crashed with "Cannot read properties of null (reading
// '__H')" the moment the next hook ran. Direct JSX has no such hazard —
// don't reintroduce a render()-in-render() shortcut here.

interface ImportAnalysisProps {
  imp: ImportSession;
  ctx: AppContext;
  onOpenCard: (cardId: string) => void;
}

export function ImportAnalysis({ imp, ctx, onOpenCard }: ImportAnalysisProps) {
  const titleRowRef = useRef<HTMLDivElement>(null);
  const dateRowRef = useRef<HTMLDivElement>(null);
  const titleControlsRef = useRef<{ refreshTitle: () => void; refreshDeckBtn: () => void } | null>(null);
  const feedAnchorRef = useRef<HTMLDivElement>(null);

  const [deckIdsTick, setDeckIdsTick] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [statusText, setStatusText] = useState(() => {
    const phase = imp.getPhase();
    if (phase === 'decoding') return t('sessions.decoding');
    if (phase === 'analyzing') return '';
    return t('sessions.initializing');
  });
  const [progress, setProgress] = useState<{ analyzedS: number; totalS: number; etaS: number | null }>({ analyzedS: 0, totalS: 0, etaS: null });
  const [annotations, setAnnotations] = useState<SessionAnnotation[]>(() => (imp.getPhase() === 'analyzing' ? imp.getAnnotations() : []));
  const [playingId, setPlayingId] = useState<string | null>(null);

  const ensureImpTargetDeckIds = () => { if (!imp.targetDeckIds) imp.targetDeckIds = new Set(); return imp.targetDeckIds; };

  useEffect(() => {
    if (titleRowRef.current) {
      titleControlsRef.current = titleAndDeleteRow(titleRowRef.current, {
        getName: () => imp.name,
        getDefaultName: () => imp.defaultName(),
        onRename: (val) => { imp.name = val; },
        onDelete: () => imp.cancel(),
        getTargetDeckIds: () => imp.targetDeckIds,
        ensureTargetDeckIds: ensureImpTargetDeckIds,
      });
    }
    if (dateRowRef.current) {
      editableDateRow(dateRowRef.current, {
        getDate: () => imp.dateOverride,
        setDate: (date) => { imp.dateOverride = date; },
      });
    }
    // eslint-disable-next-line
  }, []);

  // ── Slice playback straight from the original file, while analysis runs.
  const [audio] = useState(() => new Audio(URL.createObjectURL(imp.file)));
  useEffect(() => {
    const audioUrl = audio.src;
    const onTimeUpdate = () => { if (playingIdRef.current !== null && audio.currentTime >= sliceEndRef.current) audio.pause(); };
    const onPause = () => { if (playingIdRef.current !== null) { playingIdRef.current = null; setPlayingId(null); } };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('pause', onPause);
      audio.pause();
      URL.revokeObjectURL(audioUrl);
    };
    // eslint-disable-next-line
  }, []);
  // Refs mirroring playingId/sliceEnd for the audio event listeners above
  // (registered once on mount — they need the LATEST value, not a stale
  // closure over the mount-time one).
  const playingIdRef = useRef<string | null>(null);
  const sliceEndRef = useRef(0);
  playingIdRef.current = playingId;

  const playSlice = (ann: SessionAnnotation) => {
    if (playingId === ann.id) { audio.pause(); return; }
    sliceEndRef.current = ann.end ?? Number.POSITIVE_INFINITY;
    audio.currentTime = ann.start;
    void audio.play().catch(() => { playingIdRef.current = null; setPlayingId(null); });
    setPlayingId(ann.id);
  };

  // Latest known total duration, for the clip-filename fallback only — a
  // finalized annotation (the only ones offered clip extraction below)
  // always has a concrete `end`, so this is never actually load-bearing, just
  // satisfying ClipSessionRef's shape.
  const impRef = (): ClipSessionRef => ({ id: imp.sessionId, name: imp.name || imp.defaultName(), date: imp.dateOverride, duration: progress.totalS });

  useEffect(() => {
    imp.setCallbacks({
      onPhase: (phase) => {
        if (phase === 'initializing') setStatusText(t('sessions.initializing'));
        else if (phase === 'decoding') setStatusText(t('sessions.decoding'));
        else if (phase === 'analyzing') setStatusText('');
      },
      onIndexProgress: p => setStatusText(indexProgressText(p)),
      onProgress: (p) => setProgress(p),
      onAnnotations: (_events, all) => setAnnotations(all),
      onError: (message) => setStatusText(`⚠ ${message}`),
    });
    // First render happens just before start() (phase 'idle'), or as a
    // re-entry after the modal was closed and reopened mid-import — matches
    // the lazy useState initializers above, this just covers a genuine
    // re-entry racing with a phase change between mount and this effect.
    if (imp.getPhase() === 'analyzing') setAnnotations(imp.getAnnotations());
    // eslint-disable-next-line
  }, []);

  const cardOptsFor = (ann: SessionAnnotation): AnnotationCardOptions => ({
    ctx,
    onPlay: importPlaybackWarn.value ? undefined : playSlice,
    playingId,
    onOpenCard,
    onCardAdded: () => setAnnotations(imp.getAnnotations()),
    getTargetDeckIds: () => imp.targetDeckIds,
    ensureTargetDeckIds: ensureImpTargetDeckIds,
    onTargetDeckIdsChanged: () => { titleControlsRef.current?.refreshDeckBtn(); setDeckIdsTick(x => x + 1); },
    onToggleLike: (id) => { imp.toggleLike(id); setAnnotations(imp.getAnnotations()); },
    onSelectAlternate: (id, pick) => { imp.selectAlternate(id, pick); setAnnotations(imp.getAnnotations()); },
    getLatestAnnotation: (id) => imp.getAnnotations().find(a => a.id === id),
    // Clip extraction only once finalized: the full file is already sitting
    // right there in imp.file from the very first instant, unlike a live
    // recording — no reason to make the user wait for the whole import to
    // finish just to grab a proven-stable tune's clip. Provisional
    // (not-yet-finalized) annotations still don't get the buttons, since
    // their bounds/existence could still change.
    extraControls: ann.finalized ? (el) => {
      const controls = document.createElement('div');
      controls.className = 'flex items-center gap-2 flex-wrap pt-1 border-t border-border/50';
      appendBoundControls(controls, ann, () => progress.totalS, {
        refresh: () => setAnnotations([...imp.getAnnotations()]),
        previewBound: (tSec) => { audio.currentTime = Math.max(0, tSec); void audio.play().catch(() => { /* not loaded yet */ }); setTimeout(() => audio.pause(), 3000); },
      });
      appendClipControls(controls, ann, impRef(), true, async () => imp.file, ctx, () => setAnnotations([...imp.getAnnotations()]));
      el.appendChild(controls);
    } : undefined,
  });

  useAutoFollowScroll(feedAnchorRef, [annotations, playingId, deckIdsTick]);

  const pct = progress.totalS > 0 ? Math.min(100, (progress.analyzedS / progress.totalS) * 100) : 0;

  return (
    <>
      <div ref={titleRowRef} />
      <div ref={dateRowRef} />

      <div class="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg sticky top-0">
        <span class="text-xs font-mono text-muted shrink-0 tabular-nums">{fmtLongTime(progress.analyzedS)} / {fmtLongTime(progress.totalS)}</span>
        <div class="flex-1 h-1.5 rounded-full bg-elevated overflow-hidden">
          <div class="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
        <PitchShiftControl value={imp.pitchShift} onChange={(s) => imp.setPitchShift(s)} />
        <button
          class="btn-danger px-3 shrink-0 disabled:opacity-50"
          disabled={cancelling}
          onClick={() => { setCancelling(true); imp.cancel(); }}
        >
          {t('common.cancel')}
        </button>
      </div>

      <p class="text-[11px] text-dim mt-2 text-center">{progress.etaS !== null ? t('sessions.etaRemaining', { eta: fmtEta(progress.etaS) }) : ''}</p>
      <p class="text-xs text-dim mt-2 text-center">{statusText}</p>
      {importPlaybackWarn.value && <p class="text-xs text-amber-500 mt-2 text-center">{t('sessions.playbackUnsupported')}</p>}

      <div ref={feedAnchorRef} class="mt-3 space-y-2">
        {annotations.map(ann => <AnnotationCard key={ann.id} ann={ann} opts={cardOptsFor(ann)} />)}
      </div>
    </>
  );
}
