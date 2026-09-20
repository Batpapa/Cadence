import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import type { ImportSession, ImportProgress } from '../importSession';
import type { Detection } from '../model';
import { DetectionCard, type DetectionCardOptions } from './DetectionCard';
import { useAutoFollowScroll } from './domInterop';
import { fmtLongTime, TitleRow, DateRow, indexProgressText, fmtEta } from './sessionUiShared';
import { AnalysisFolderPicker } from './AnalysisFolderPicker';
import { importPlaybackWarn } from './sessionStore';
import { canPlayFile } from '../audio/sources';
import { useThrottled } from './throttle';

// ── Screen: file import ───────────────────────────────────────────────────────
// Turns an audio file into a full session: same recognition pipeline as live,
// faster than real time, with progress + ETA. The detection feed reuses the
// live cards — watching them appear in accelerated time is the point.
//
// `imp.setCallbacks({...})` is a single-registration API (each call REPLACES
// the previous callbacks, not additive) — this component is the ONE place
// that calls it, fanning updates out to local state.
//
// No pitch control here (2026-09-13): an import outruns anyone reaching for
// it, and changing it midway would analyse half the file at one pitch and half
// at another. The instruments' pitch is the module's setting, read when the
// import starts — see TuneAnalyserModuleData.pitchShift.
//
// Uses <DetectionCard> directly as JSX. Earlier
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
  const feedAnchorRef = useRef<HTMLDivElement>(null);

  const [cancelling, setCancelling] = useState(false);
  const [statusText, setStatusText] = useState(() => {
    const phase = imp.getPhase();
    if (phase === 'decoding') return t('sessions.decoding');
    if (phase === 'analyzing') return '';
    return t('sessions.initializing');
  });
  const [progress, setProgress] = useState<{ analyzedS: number; totalS: number; etaS: number | null }>({ analyzedS: 0, totalS: 0, etaS: null });
  const [annotations, setDetections] = useState<Detection[]>(() => (imp.getPhase() === 'analyzing' ? imp.getDetections() : []));

  // There was an <audio> here, playing a detection's slice straight from the
  // file while the analysis ran. It went on 2026-09-20 with the rest of the
  // acting-on-a-detection controls — see the note above cardOpts.
  //
  // `importPlaybackWarn` outlived it on purpose: whether the browser can open
  // this file at all is still worth saying early, because the summary is about
  // to need it.

  // Analysis emits a window roughly every 60ms — both feeds below would
  // otherwise re-render this screen a dozen-plus times a second. The session
  // itself still receives every event; only the redraw is coalesced.
  //
  // The progress bar reads smoothly at this rate rather than stepping, because
  // its `transition-[width] duration-200` very nearly bridges the 250ms between
  // updates. Change one and look at the other.
  const onProgress = useThrottled((p: ImportProgress) => setProgress(p));
  const onDetections = useThrottled((all: Detection[]) => setDetections(all));

  useEffect(() => {
    imp.setCallbacks({
      onPhase: (phase) => {
        if (phase === 'initializing') setStatusText(t('sessions.initializing'));
        else if (phase === 'decoding') setStatusText(t('sessions.decoding'));
        else if (phase === 'analyzing') setStatusText('');
        else if (phase === 'extracting') setStatusText(t('sessions.extractingAudio'));
      },
      onIndexProgress: p => setStatusText(indexProgressText(p)),
      // Runs before the analysis, so this is what the screen shows while
      // nothing else is happening yet. Its cost follows the size of the file,
      // so on a long video it is worth a number.
      onExtractProgress: (ratio) => setStatusText(t('sessions.extractingAudio') + ` ${Math.round(ratio * 100)}%`),
      // A video's audio, extracted. Nothing on this screen plays it any more,
      // but it settles the warning below — an m4a or a WAV opens where the
      // video it came from did not, and the summary is where that will matter.
      onPlaybackFile: (file) => { importPlaybackWarn.value = !canPlayFile(file); },
      onProgress,
      onDetections: (_events, all) => onDetections(all),
      onError: (message) => setStatusText(`⚠ ${message}`),
    });
    // First render happens just before start() (phase 'idle'), or as a
    // re-entry after the modal was closed and reopened mid-import — matches
    // the lazy useState initializers above, this just covers a genuine
    // re-entry racing with a phase change between mount and this effect.
    if (imp.getPhase() === 'analyzing') setDetections(imp.getDetections());
    // eslint-disable-next-line
  }, []);

  // ── An analysis in progress is watched, not worked on ─────────────────────
  // Listening to a detection, adjusting its bounds, cutting a clip from it,
  // attaching that clip to a card and deleting it all left this screen on
  // 2026-09-20, together with the same five on the live one. They live in the
  // summary, which opens as soon as the analysis is done.
  //
  // The rule came from live recording, where it is a physical fact: playing
  // the session back into the room while the room is being recorded feeds the
  // sound into the recogniser. It holds here for a plainer reason — these
  // actions all rest on bounds the user has had no chance to check, and a clip
  // of an unchecked span is a clip of the wrong thing. One rule for both
  // screens beats two screens that each allow something different.
  //
  // What stays is everything that describes rather than acts: the tune's name
  // and score, its sheet preview, adding it to the library, the heart, the
  // alternatives picker — and logging a practice, which claims only that the
  // tune was played and needs no listening back.

  const cardOpts: DetectionCardOptions = {
    ctx,
    onOpenCard,
    onCardAdded: () => setDetections(imp.getDetections()),
    getPinnedDeckIds: () => imp.pinnedDeckIds,
    onToggleLike: (id) => { imp.toggleLike(id); setDetections(imp.getDetections()); },
    onSelectAlternate: (id, pick) => { imp.selectAlternate(id, pick); setDetections(imp.getDetections()); },
    onAddManualAlternate: (id, tune) => { imp.addManualAlternate(id, tune); setDetections(imp.getDetections()); },
    onRemoveManualAlternate: (id, tuneId) => { imp.removeManualAlternate(id, tuneId); setDetections(imp.getDetections()); },
    getLatestDetection: (id) => imp.getDetections().find(a => a.id === id),
    // Logging a practice needs a date and a detection that has CLOSED — that
    // last part is DetectionCard's own gate, and it is deliberately the only
    // one: a tune still consolidating can be logged (2026-09-20, user
    // request). The date is the one the file's own modification time guessed,
    // editable in the row above.
    sessionStartMs: imp.dateOverride ? Date.parse(imp.dateOverride) : undefined,
  };

  useAutoFollowScroll(feedAnchorRef, [annotations]);

  const pct = progress.totalS > 0 ? Math.min(100, (progress.analyzedS / progress.totalS) * 100) : 0;

  return (
    <>
      <TitleRow
        getName={() => imp.name}
        getDefaultName={() => imp.defaultName()}
        onRename={(val) => { imp.name = val; }}
        onDelete={() => imp.cancel({ discard: true })}
      />
      {/* Same as the live screen: where it will be filed is decided while the
          analysis runs, not afterwards. */}
      <AnalysisFolderPicker ctx={ctx} sessionId={imp.sessionId} />
      <DateRow
        getDate={() => imp.dateOverride}
        setDate={(date) => { imp.dateOverride = date; }}
      />

      {/* Pinned like the live screen's bar and the finished analysis's
          transport — see LiveSession.tsx for the three classes that make it
          hold. */}
      <div class="sticky top-0 z-10 bg-bg -mx-6 px-6 pt-3 pb-3">
        <div class="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg">
          <span class="text-xs font-mono text-muted shrink-0 tabular-nums">{fmtLongTime(progress.analyzedS)} / {fmtLongTime(progress.totalS)}</span>
          <div class="flex-1 h-1.5 rounded-full bg-elevated overflow-hidden">
            <div class="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
          <button
            class="btn-danger px-3 shrink-0 disabled:opacity-50"
            disabled={cancelling}
            onClick={() => { setCancelling(true); imp.cancel(); }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>

      <p class="text-[11px] text-dim text-center">{progress.etaS !== null ? t('sessions.etaRemaining', { eta: fmtEta(progress.etaS) }) : ''}</p>
      <p class="text-xs text-dim mt-2 text-center">{statusText}</p>
      {importPlaybackWarn.value && <p class="text-xs text-amber-500 mt-2 text-center">{t('sessions.playbackUnsupported')}</p>}

      <div ref={feedAnchorRef} class="mt-3 space-y-2">
        {annotations.map(ann => <DetectionCard key={ann.id} ann={ann} opts={cardOpts} />)}
      </div>
    </>
  );
}
