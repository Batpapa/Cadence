import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import { isTouchPrimaryDevice } from '../../utils';
import { playIcon, pauseIcon } from '../../components/playbackIcons';
import type { LiveSession as LiveSessionEngine, LiveSessionPhase } from '../liveSession';
import { collectChunks } from '../db';
import fixWebmDuration from 'fix-webm-duration';
import { RECORDER_TIMESLICE_MS } from '../sessionConfig';
import type { SessionAnnotation } from '../model';
import { AnnotationCard, type AnnotationCardOptions } from './AnnotationCard';
import { PitchShiftControl } from './PitchShiftControl';
import { useAutoFollowScroll } from './domInterop';
import {
  fmtLongTime, defaultSessionName, indexProgressText, titleAndDeleteRow,
  appendBoundControls, appendClipControls, type ClipSessionRef,
} from './sessionUiShared';
import { setActiveLive, lastLiveDump } from './sessionStore';

// ── Screen: live recording ───────────────────────────────────────────────────
// Uses <AnnotationCard>/<PitchShiftControl> directly as JSX, never the
// annotationCard()/pitchShiftControl() bridges — see ImportAnalysis.tsx's
// header doc for why (reentrant render() during this component's own render
// pass corrupts Preact's hooks bookkeeping).
//
// The chrono and VU meter are updated by direct DOM writes to refs (rAF loop
// + 1s interval), not Preact state — mirrors the original imperative code's
// own choice: re-rendering the whole tree at 60fps for a width/text change
// would be wasted work.
//
// live.setCallbacks({...}) is a single-registration API (each call REPLACES
// the previous callbacks) — this component is the ONE place that calls it.

interface LiveSessionScreenProps {
  live: LiveSessionEngine;
  ctx: AppContext;
  onOpenCard: (cardId: string) => void;
}

export function LiveSessionScreen({ live, ctx, onOpenCard }: LiveSessionScreenProps) {
  const titleRowRef = useRef<HTMLDivElement>(null);
  const titleControlsRef = useRef<{ refreshTitle: () => void; refreshDeckBtn: () => void } | null>(null);
  const feedAnchorRef = useRef<HTMLDivElement>(null);
  const chronoRef = useRef<HTMLSpanElement>(null);
  const vuFillRef = useRef<HTMLDivElement>(null);

  const effectiveDate = () => new Date(live.startedAt || Date.now()).toISOString();

  const [phase, setPhase] = useState<LiveSessionPhase>(() => live.getPhase());
  const [dateText, setDateText] = useState(() => new Date(effectiveDate()).toLocaleString());
  const [initStatus, setInitStatus] = useState(() => (live.getPhase() === 'initializing' ? t('sessions.initializing') : ''));
  const [annotations, setAnnotations] = useState<SessionAnnotation[]>(() => live.getAnnotations());
  const [stateZoneText, setStateZoneText] = useState('');
  const [abcTickerText, setAbcTickerText] = useState('');
  const [bgWarningText, setBgWarningText] = useState<string | null>(null);
  const [deckIdsTick, setDeckIdsTick] = useState(0);
  const [stopping, setStopping] = useState(false);

  const ensureLiveTargetDeckIds = () => { if (!live.targetDeckIds) live.targetDeckIds = new Set(); return live.targetDeckIds; };

  useEffect(() => {
    if (titleRowRef.current) {
      titleControlsRef.current = titleAndDeleteRow(titleRowRef.current, {
        getName: () => live.name,
        getDefaultName: () => defaultSessionName(effectiveDate()),
        onRename: (val) => { live.name = val; },
        // No explicit "go back to the library" call needed: sessions.tsx
        // reads activeLive reactively, so clearing it alone switches the
        // screen on its own.
        onDelete: () => { void live.cancel().then(() => setActiveLive(null)); },
        getTargetDeckIds: () => live.targetDeckIds,
        ensureTargetDeckIds: ensureLiveTargetDeckIds,
      });
    }
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    live.setCallbacks({
      onPhase: (p) => {
        setPhase(p);
        if (p === 'recording') {
          setInitStatus('');
          setDateText(new Date(effectiveDate()).toLocaleString()); // startedAt is now the real value
        }
      },
      onIndexProgress: (p) => setInitStatus(indexProgressText(p)),
      onWindow: (result, abc) => {
        const hasOpen = live.getAnnotations().some(a => a.end === null);
        if (hasOpen) setStateZoneText('');
        else if (result.empty) setStateZoneText(t('sessions.listening'));
        else setStateZoneText(t('sessions.recognizing'));
        setAbcTickerText(abc ?? '');
      },
      onAnnotations: (_events, all) => setAnnotations(all),
      onError: (message) => setInitStatus(`⚠ ${message}`),
    });
    // Re-entry (modal closed and reopened, or navigated away and back) while
    // a phase-changing event happened between the lazy useState initializers
    // above and this effect committing.
    const p = live.getPhase();
    setPhase(p);
    if (p === 'recording' || p === 'paused') setAnnotations(live.getAnnotations());
    else if (p === 'initializing') setInitStatus(t('sessions.initializing'));
    // eslint-disable-next-line
  }, []);

  // Chrono + VU meter: direct DOM writes via refs, gated on `phase` alone —
  // idempotent by construction (effect re-runs and its own cleanup tears down
  // the previous loop first), matching the original startTimers/stopTimers
  // pair being safe to call again on resume without leaking a second one.
  useEffect(() => {
    if (chronoRef.current) chronoRef.current.textContent = fmtLongTime(live.getElapsedMs() / 1000);
    if (phase !== 'recording') {
      if (vuFillRef.current) vuFillRef.current.style.width = '0%';
      return;
    }
    let rafId = requestAnimationFrame(function vuLoop() {
      if (vuFillRef.current) vuFillRef.current.style.width = `${Math.round(live.getLevel() * 100)}%`;
      rafId = requestAnimationFrame(vuLoop);
    });
    const chronoId = window.setInterval(() => {
      if (chronoRef.current) chronoRef.current.textContent = fmtLongTime(live.getElapsedMs() / 1000);
    }, 1000);
    return () => { clearInterval(chronoId); cancelAnimationFrame(rafId); };
  }, [phase]);

  // #17: background warning, touch-primary devices only — see the original's
  // own doc (still true here) on why this is unfixable code-side and only a
  // reminder past a real threshold.
  const isTouchPrimary = isTouchPrimaryDevice();
  useEffect(() => {
    if (!isTouchPrimary) return;
    let hiddenAtMs: number | null = null;
    let timeoutId = 0;
    const onVisibility = () => {
      if (document.hidden) { hiddenAtMs = Date.now(); return; }
      if (hiddenAtMs !== null && live.getPhase() === 'recording') {
        const hiddenS = (Date.now() - hiddenAtMs) / 1000;
        if (hiddenS > 2) {
          setBgWarningText(t('sessions.bgWarning', { duration: fmtLongTime(hiddenS) }));
          clearTimeout(timeoutId);
          timeoutId = window.setTimeout(() => setBgWarningText(null), 8000);
        }
      }
      hiddenAtMs = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); clearTimeout(timeoutId); };
    // eslint-disable-next-line
  }, [isTouchPrimary]);

  const liveRef = (): ClipSessionRef => ({ id: live.sessionId, name: live.name, date: effectiveDate(), duration: live.getElapsedMs() / 1000 });
  // Assembles a Blob from whatever chunks the recorder has written to
  // IndexedDB so far (same technique recovery.ts trusts for a crashed
  // session), lazily — only pays this cost when the user actually clicks a
  // clip control, not on every feed render.
  const getLiveAudioBlob = async (): Promise<Blob | undefined> => {
    const chunks = await collectChunks(live.sessionId);
    if (chunks.length === 0) return undefined;
    const mimeType = live.mimeType || 'audio/webm';
    let blob = new Blob(chunks, { type: mimeType });
    if (mimeType.includes('webm')) {
      try { blob = await fixWebmDuration(blob, chunks.length * RECORDER_TIMESLICE_MS, { logger: false }); }
      catch { /* seeking degraded but audio intact */ }
    }
    return blob;
  };

  const cardOptsFor = (ann: SessionAnnotation): AnnotationCardOptions => ({
    ctx,
    onOpenCard,
    onCardAdded: () => setAnnotations(live.getAnnotations()),
    sessionStartMs: live.startedAt || undefined,
    getTargetDeckIds: () => live.targetDeckIds,
    ensureTargetDeckIds: ensureLiveTargetDeckIds,
    onTargetDeckIdsChanged: () => { titleControlsRef.current?.refreshDeckBtn(); setDeckIdsTick(x => x + 1); },
    onToggleLike: (id) => { live.toggleLike(id); setAnnotations(live.getAnnotations()); },
    onSelectAlternate: (id, pick) => { live.selectAlternate(id, pick); setAnnotations(live.getAnnotations()); },
    getLatestAnnotation: (id) => live.getAnnotations().find(a => a.id === id),
    // Clip extraction only once finalized (2026-08-21) — before that the
    // tune's own bounds/existence could still be revised.
    extraControls: ann.finalized ? (el) => {
      const controls = document.createElement('div');
      controls.className = 'flex items-center gap-2 flex-wrap pt-1 border-t border-border/50';
      // No previewBound here — a live recording has no seekable file to
      // preview from (raw mic capture), unlike summary/import.
      appendBoundControls(controls, ann, () => live.getElapsedMs() / 1000, {
        refresh: () => setAnnotations([...live.getAnnotations()]),
      });
      appendClipControls(controls, ann, liveRef(), true, getLiveAudioBlob, ctx, () => setAnnotations([...live.getAnnotations()]));
      el.appendChild(controls);
    } : undefined,
  });

  useAutoFollowScroll(feedAnchorRef, [annotations, deckIdsTick]);

  const paused = phase === 'paused';

  const onPauseClick = () => {
    if (phase === 'recording') void live.pause();
    else if (phase === 'paused') void live.resume();
  };

  const onStopClick = async () => {
    setStopping(true);
    try {
      const session = await live.stop();
      lastLiveDump.value = { sessionId: session.id, windows: [...live.windows] };
      setActiveLive(null);
      ctx.navigate({ view: 'sessions', sessionId: session.id });
    } catch (err) {
      setActiveLive(null);
      setInitStatus(`⚠ ${String(err)}`);
    }
  };

  return (
    <>
      <div ref={titleRowRef} />
      <p class="text-sm text-primary mt-2 mb-3">{dateText}</p>

      <div class="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg sticky top-0">
        <span class={`w-2.5 h-2.5 rounded-full shrink-0 ${paused ? 'bg-dim' : 'bg-danger animate-pulse'}`} />
        <span class="text-xs font-mono font-bold text-danger">{paused ? t('sessions.paused') : 'REC'}</span>
        <span ref={chronoRef} class="text-sm font-mono text-primary tabular-nums">0:00</span>
        <div class="flex-1 h-1.5 rounded-full bg-elevated overflow-hidden">
          <div ref={vuFillRef} class="h-full bg-accent transition-[width] duration-75" style={{ width: '0%' }} />
        </div>
        <button
          class="btn-ghost border border-border w-8 h-8 p-0 rounded-full flex items-center justify-center shrink-0"
          title={paused ? t('sessions.resume') : t('sessions.pause')}
          onClick={onPauseClick}
          dangerouslySetInnerHTML={{ __html: paused ? playIcon(12) : pauseIcon(12) }}
        />
        <PitchShiftControl value={live.pitchShift} onChange={(s) => live.setPitchShift(s)} />
        <button class="btn-danger px-3 shrink-0" disabled={stopping} onClick={() => { void onStopClick(); }}>
          {t('sessions.stop')}
        </button>
      </div>

      <p class="text-xs text-dim mt-2 text-center">{initStatus}</p>

      {isTouchPrimary && <p class="text-[11px] text-dim mt-2 text-center">{t('sessions.foregroundReminder')}</p>}
      {isTouchPrimary && bgWarningText && <p class="text-xs text-amber-500 mt-2 text-center">{bgWarningText}</p>}

      <div ref={feedAnchorRef} class="mt-3 space-y-2">
        {annotations.map(ann => <AnnotationCard key={ann.id} ann={ann} opts={cardOptsFor(ann)} />)}
      </div>

      <p class="text-xs text-dim mt-3 text-center min-h-[1rem]">{stateZoneText}</p>
      <p class="text-[10px] font-mono text-dim/60 text-center truncate mt-1">{abcTickerText}</p>
    </>
  );
}
