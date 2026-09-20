import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import { isTouchPrimaryDevice } from '../../utils';
import { playIcon, pauseIcon } from '../../components/playbackIcons';
import type { LiveSession as LiveSessionEngine, LiveSessionPhase } from '../liveSession';
import type { Detection } from '../model';
import { DetectionCard, type DetectionCardOptions } from './DetectionCard';
import { PitchShiftControl } from './PitchShiftControl';
import { useAutoFollowScroll } from './domInterop';
import { fmtLongTime, indexProgressText, TitleRow } from './sessionUiShared';
import { AnalysisFolderPicker } from './AnalysisFolderPicker';
import { LiveBackupIndicator } from './LiveBackupIndicator';
import { generatedSessionName } from '../sessionNaming';
import { setActiveLive, lastLiveDump } from './sessionStore';
import { setPitchShiftSetting } from './sessionModule';

// ── Screen: live recording ───────────────────────────────────────────────────
// Uses <DetectionCard>/<PitchShiftControl> directly as JSX, never the
// detectionCard()/pitchShiftControl() bridges — see ImportAnalysis.tsx's
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
  const feedAnchorRef = useRef<HTMLDivElement>(null);
  const chronoRef = useRef<HTMLSpanElement>(null);
  const vuFillRef = useRef<HTMLDivElement>(null);

  const effectiveDate = () => new Date(live.startedAt || Date.now()).toISOString();

  const [phase, setPhase] = useState<LiveSessionPhase>(() => live.getPhase());
  const [dateText, setDateText] = useState(() => new Date(effectiveDate()).toLocaleString());
  const [initStatus, setInitStatus] = useState(() => (live.getPhase() === 'initializing' ? t('sessions.initializing') : ''));
  const [annotations, setDetections] = useState<Detection[]>(() => live.getDetections());
  const [stateZoneText, setStateZoneText] = useState('');
  const [abcTickerText, setAbcTickerText] = useState('');
  const [bgWarningText, setBgWarningText] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);


  // Declared above the callback registration below, which needs it: the
  // browser's own "Stop sharing" button has to land on exactly the same path
  // as this screen's Stop button.
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
        const hasOpen = live.getDetections().some(a => a.end === null);
        if (hasOpen) setStateZoneText('');
        else if (result.empty) setStateZoneText(t('sessions.listening'));
        else setStateZoneText(t('sessions.recognizing'));
        setAbcTickerText(abc ?? '');
      },
      onDetections: (_events, all) => setDetections(all),
      onError: (message) => setInitStatus(`⚠ ${message}`),
      // The capture died under us — browser's own "Stop sharing", the shared
      // tab closed, a microphone unplugged. Save rather than discard: what was
      // recognised is real and the audio is already on disk, so this is a
      // Stop, not a Cancel. Nothing further can be captured, so there is no
      // decision left for the user to make and nothing to ask them.
      onSourceEnded: () => {
        setInitStatus(t('sessions.sourceEnded'));
        void onStopClick();
      },
    });
    // Re-entry (modal closed and reopened, or navigated away and back) while
    // a phase-changing event happened between the lazy useState initializers
    // above and this effect committing.
    const p = live.getPhase();
    setPhase(p);
    if (p === 'recording' || p === 'paused') setDetections(live.getDetections());
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

  // ── Nothing here acts on the recording while it is being made ─────────────
  // Adjusting a bound, cutting a clip, attaching one to a card and deleting a
  // detection all left this screen on 2026-09-20, and none of them is coming
  // back: they belong to the summary, which opens the moment the recording
  // stops.
  //
  // The reason is the microphone. Being sure of a bound means LISTENING around
  // it — and playing the session back into the room while the room is being
  // recorded feeds the sound straight into the recogniser. There is no version
  // of "listen to what you are recording" that does not corrupt the thing
  // being recorded. And a bound nobody could check is a bound nobody should be
  // cutting a clip on: the clip controls went with it, because a clip of an
  // unverified span is a clip of the wrong thing.
  //
  // Logging a review stays. It claims only that the tune was played, which
  // needs no listening back — see sessionStartMs below.

  // One object for the whole feed, not one per detection: with the four
  // recording-time controls gone, nothing left here differs from one card to
  // the next.
  const cardOpts: DetectionCardOptions = {
    ctx,
    onOpenCard,
    onCardAdded: () => setDetections(live.getDetections()),
    // Logging a practice needs a date and a detection that has CLOSED — that
    // last part is DetectionCard's own gate, and it is deliberately the only
    // one. A tune still consolidating can be logged (2026-09-20, user
    // request): by the time it closes it has been played, which is the whole
    // of what a review entry claims, and waiting for the decoder to converge
    // means the moment has passed.
    sessionStartMs: live.startedAt || undefined,
    getPinnedDeckIds: () => live.pinnedDeckIds,
    onToggleLike: (id) => { live.toggleLike(id); setDetections(live.getDetections()); },
    onSelectAlternate: (id, pick) => { live.selectAlternate(id, pick); setDetections(live.getDetections()); },
    onAddManualAlternate: (id, tune) => { live.addManualAlternate(id, tune); setDetections(live.getDetections()); },
    onRemoveManualAlternate: (id, tuneId) => { live.removeManualAlternate(id, tuneId); setDetections(live.getDetections()); },
    getLatestDetection: (id) => live.getDetections().find(a => a.id === id),
  };

  useAutoFollowScroll(feedAnchorRef, [annotations]);

  const paused = phase === 'paused';

  const onPauseClick = () => {
    if (phase === 'recording') void live.pause();
    else if (phase === 'paused') void live.resume();
  };

  return (
    <>
      <TitleRow
        getName={() => live.name}
        getDefaultName={() => generatedSessionName(live.sourceKind === 'device' ? 'device' : 'live', effectiveDate())}
        onRename={(val) => { live.name = val; }}
        // No explicit "go back to the library" call needed: sessions.tsx
        // reads activeLive reactively, so clearing it alone switches the
        // screen on its own.
        onDelete={() => { void live.cancel().then(() => setActiveLive(null)); }}
      />
      {/* Where it will be filed, decided while it records. The tree only holds
          the id, so pointing it at a recording that has not been saved yet is
          harmless: every read filters against the analyses that actually exist
          (sessionTree.ts), and the entry comes to life the moment this one is
          finalized. */}
      <AnalysisFolderPicker ctx={ctx} sessionId={live.sessionId} />
      <p class="text-sm text-primary mt-2">{dateText}</p>

      {/* Pinned the way the finished analysis pins its transport: full-bleed
          backdrop over the page's own padding, above the cards (`z-10`), and
          the same air above and below whether pinned or at rest (`pt-3`/`pb-3`).
          The bordered row alone used to carry `sticky`, with nothing to keep
          the feed from drawing over it. */}
      <div class="sticky top-0 z-10 bg-bg -mx-6 px-6 pt-3 pb-3">
        <div class="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg">
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
          {/* The same fork as on the module's screen, and the same value: it
              starts from the setting, and changing it mid-recording — from the
              next window on — is also the setting from now on. */}
          <PitchShiftControl value={live.pitchShift} onChange={(s) => { live.setPitchShift(s); setPitchShiftSetting(s); }} />
          <button class="btn-danger px-3 shrink-0" disabled={stopping} onClick={() => { void onStopClick(); }}>
            {t('sessions.stop')}
          </button>
        </div>
        {/* Only once something is being recorded: before that there is nothing
            to send, and no session to name in meta.json. */}
        {(phase === 'recording' || phase === 'paused') && <LiveBackupIndicator live={live} />}
      </div>

      <p class="text-xs text-dim text-center">{initStatus}</p>

      {isTouchPrimary && <p class="text-[11px] text-dim mt-2 text-center">{t('sessions.foregroundReminder')}</p>}
      {isTouchPrimary && bgWarningText && <p class="text-xs text-amber-500 mt-2 text-center">{bgWarningText}</p>}

      <div ref={feedAnchorRef} class="mt-3 space-y-2">
        {annotations.map(ann => <DetectionCard key={ann.id} ann={ann} opts={cardOpts} />)}
      </div>

      <p class="text-xs text-dim mt-3 text-center min-h-[1rem]">{stateZoneText}</p>
      <p class="text-[10px] font-mono text-dim/60 text-center truncate mt-1">{abcTickerText}</p>
    </>
  );
}
