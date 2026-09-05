import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import type { AppContext } from '../../types';
import { TrashIcon, ResetIcon } from '../../components/icons';
import { playIcon, pauseIcon, stopIcon, downloadIcon } from '../../components/playbackIcons';
import { confirmModal } from '../../components/modal';
import { deleteSession, loadSessionAudio, saveSessionMeta, forgetSessionAudio } from '../db';
import type { RecordedSession, SessionAnnotation } from '../model';
import { alternatePickFields } from '../model';
import { AnnotationCard, type AnnotationCardOptions } from './AnnotationCard';
import { showShareSessionModal } from './ShareSessionModal';
import {
  fmtLongTime, defaultSessionName, TitleRow, DateRow,
  BoundControls, ClipControls,
} from './sessionUiShared';
import { lastImportDump, lastLiveDump } from './sessionStore';
import { headPosition, withGaps } from './timelineModel';

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

/** Diagonal hatching that LEANS THE OTHER WAY from one detection to the next.
 *
 *  Two neighbours of the same confidence would otherwise read as one long
 *  detection, and there is nothing to draw between them: 22 of 37 joins on a
 *  real session OVERLAP, so no boundary exists there to mark. A texture seam
 *  needs no geometry and costs no width — a hairline would have eaten a
 *  segment already down to its 2 px floor, and a second colour per level made
 *  the strip gaudy.
 *
 *  Reversing the ANGLE rather than shifting the phase: a phase break can
 *  vanish when a segment happens to be a whole number of periods wide, and it
 *  would vanish at the joins that need it most. Two stripes meeting nose to
 *  nose make a chevron the width cannot undo. */
//
// Beware the angle: it names the direction of the gradient's AXIS, clockwise
// from straight up, and the stripes run PERPENDICULAR to it. So `-45deg`
// draws rising stripes (/) and `45deg` falling ones (\) — the opposite of
// what the number reads like. The first detection of a session rises.
const hatch = (deg: number) =>
  `repeating-linear-gradient(${deg}deg, rgb(0 0 0 / 0.12) 0 3px, transparent 3px 6px)`;
const HATCH = [hatch(-45), hatch(45)];   // rising, then falling

/** Window for reading two clicks as one gesture. The platform's own dblclick
 *  threshold is not exposed, so this only has to be generous enough to cover
 *  the second click — it never decides anything on its own. */
const DOUBLE_CLICK_MS = 400;
interface SessionSummaryProps {
  session: RecordedSession;
  ctx: AppContext;
  onOpenCard: (cardId: string) => void;
  onReanalyze: () => void;
}

export function SessionSummary({ session, ctx, onOpenCard, onReanalyze }: SessionSummaryProps) {
  const listWrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timeLblRef = useRef<HTMLSpanElement>(null);
  const playingIdRef = useRef<string | null>(null);
  // The timeline IS the seek bar now — one axis, so there is nothing left to
  // keep aligned. Its head is moved by writing style.left straight from the
  // audio element's own events, never through a re-render.
  const barRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  // Where the user ASKED to be, while the player is still behind it.
  //
  // Setting `currentTime` is a request, not an assignment: the element seeks to
  // the nearest position it can decode — a cluster boundary in a webm — and the
  // `timeupdate` that follows can carry a time slightly BEFORE the one asked
  // for. Clicking the second of two tunes that abut exactly then reads back at
  // `B.start - ε`, which the previous tune still covers and the new one does
  // not: the wrong tune lights, alone. (The bounds themselves are exact —
  // multiples of the analysis hop — so nothing is being rounded here.)
  //
  // So the requested position stands until playback genuinely reaches it, and
  // then hands over. Paused, it stands for good, which is right: paused at the
  // start of a tune IS being at that tune.
  const seekFloorRef = useRef<number | null>(null);
  const dragRef = useRef<{ moved: boolean; annId: string | null } | null>(null);
  // When the previous click landed, so the second of a double can stand down
  // and leave the work to the dblclick handler.
  const lastClickRef = useRef(0);

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

  // Not a selection — a READING of where the play head stands. Every detection
  // covering that instant is lit, in the strip and in the list alike: none in a
  // silence, two across a join. Nothing is remembered, so nothing can go stale.
  const [lit, setLit] = useState<{ ids: string[]; gapFrom: number | null }>({ ids: [], gapFrom: null });
  // The last reading, as a key, so the list only re-renders when the answer
  // actually changes — a couple of times a tune, not four times a second.
  const litKeyRef = useRef('');

  /** Moves the head to `tSec` and re-reads what it covers. The single place
   *  the head is written, whether the audio drove it or a pointer did — with
   *  the audio forgotten there is no player to ask, and the strip still works
   *  as a map. */
  const applyHead = (tSec: number) => {
    if (headRef.current) headRef.current.style.left = `${Math.min(100, (tSec / (session.duration || 1)) * 100)}%`;
    const pos = headPosition(session.annotations, tSec, session.duration);
    const key = `${pos.ids.join('|')}#${pos.gapFrom ?? ''}`;
    if (key !== litKeyRef.current) { litKeyRef.current = key; setLit(pos); }
  };

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

  // Space toggles playback, the way it does in every player — the same rule as
  // the score viewer's, deliberately worded the same.
  //
  // Ignored while a field or a button has focus: a button already answers the
  // space bar by activating itself — including the play button, which reaches
  // the same result by its own route — and swallowing the key inside the
  // session's title field would make it impossible to type a name with spaces.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || active?.isContentEditable) return;
      const a = audioRef.current;
      if (!a || !a.src) return;
      e.preventDefault(); // or the page scrolls under it
      if (a.paused) void a.play().catch(() => {}); else a.pause();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Play head + time label (direct DOM writes on 'timeupdate' — high
  // frequency, not worth a Preact re-render) and per-annotation slice
  // playback: pauses at the slice's end bound, clears playingId when the
  // player stops for any reason.
  //
  // 'timeupdate' fires about four times a second, which sounds coarse for a
  // moving head and is not: on a 48 min session in a 700 px strip the head
  // travels a quarter of a pixel per second. No animation frame needed.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    // One number for the head, the label and the reading — they cannot
    // disagree about where we are.
    const headTime = () => {
      const floor = seekFloorRef.current;
      if (floor === null) return a.currentTime;
      if (a.currentTime >= floor) { seekFloorRef.current = null; return a.currentTime; }
      return floor;
    };
    const updateTime = () => {
      const t = headTime();
      if (timeLblRef.current) timeLblRef.current.textContent = `${fmtLongTime(t)} / ${fmtLongTime(a.duration || 0)}`;
      applyHead(t);
    };
    const onLoadedMeta = () => updateTime();
    const onTimeUpdate = () => {
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
    // Through seekTo, so this gesture gets the same floor: playing a slice
    // must light its own tune, not the one that ends where it begins.
    seekTo(ann.start);
    void a.play().catch(() => setPlayingId(null));
    setPlayingId(ann.id);
  };

  /** Seconds under a pointer x, from the strip's own box. */
  const timeAtX = (clientX: number): number => {
    const bar = barRef.current;
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * session.duration;
  };

  const seekTo = (tSec: number) => {
    const a = audioRef.current;
    if (a) { a.currentTime = tSec; seekFloorRef.current = tSec; }
    // Applied here too, not only from the audio events: with the audio
    // forgotten nothing would ever fire them, and the strip is still a map.
    applyHead(tSec);
  };

  /** Brings an annotation into view. It gets lit by the head landing on it,
   *  not by being pointed at — there is no selection to hold. */
  const scrollToAnn = (ann: SessionAnnotation) => {
    listWrapRef.current?.querySelector(`[data-ann-id="${ann.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // The list follows the head: whatever is lit stays in the middle of the
  // screen, so the reading is legible without chasing it.
  //
  // `lit` is a fresh object only when the reading actually changed (applyHead
  // compares a key first), so this runs a couple of times per tune rather than
  // four times a second. A silence is a place too — when the head stands in one
  // it is the gap row that gets centred.
  useEffect(() => {
    const wrap = listWrapRef.current;
    if (!wrap) return;
    const sel = lit.gapFrom !== null ? `[data-gap-from="${lit.gapFrom}"]`
      : lit.ids.length > 0 ? `[data-ann-id="${lit.ids[0]}"]`
      : null;
    if (sel) wrap.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [lit]);

  // One gesture, read at pointerup: a drag scrubs, a plain click on a segment
  // jumps to that tune's start and selects it, a plain click on the background
  // seeks where you pointed. Deciding at the end is what lets the same press
  // start either a scrub or a click without the two fighting.
  const onBarDown = (e: PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return;
    bar.setPointerCapture(e.pointerId);
    dragRef.current = { moved: false, annId: (e.target as HTMLElement).dataset?.seg ?? null };
  };
  const onBarMove = (e: PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current.moved = true;
    seekTo(timeAtX(e.clientX));
  };
  const onBarUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    barRef.current?.releasePointerCapture(e.pointerId);
    if (d.moved) return;                       // scrub: already where it should be
    // Second click of a double: stand down, onBarDoubleClick is about to place
    // the head exactly. Jumping to the tune's start twice would only make the
    // list restart its smooth scroll for nothing.
    const now = Date.now();
    const isSecond = now - lastClickRef.current < DOUBLE_CLICK_MS;
    lastClickRef.current = now;
    if (isSecond) return;
    const ann = d.annId ? session.annotations.find(x => x.id === d.annId) : undefined;
    if (ann) { seekTo(ann.start); scrollToAnn(ann); } else seekTo(timeAtX(e.clientX));
  };

  // Two readings of the same strip: a click means "this tune", a double-click
  // means "this instant". Deliberately NOT arbitrated by waiting to see whether
  // a second click follows — that would put nearly half a second of lag on
  // every single click, which is the common gesture. The head snaps to the
  // tune's start and then, if a second click comes, refines to the exact point.
  const onBarDoubleClick = (e: MouseEvent) => seekTo(timeAtX(e.clientX));

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
    // + persist() pattern as onToggleLike above, through the same
    // alternatePickFields both engines use, so a confirmation means exactly
    // the same thing here as it does on a live one.
    onSelectAlternate: (id, pick) => {
      const target = session.annotations.find(a => a.id === id);
      if (!target) return;
      Object.assign(target, alternatePickFields(target, pick));
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

      {/* Transport and timeline travel together, pinned to the top: the strip
          is the reference you navigate BY, and scrolling the list used to take
          it off the screen at the exact moment you had just clicked it. */}
      {/* Two layers on one line. The sticky one carries what you navigate BY
          and stays put; these three act on the RECORDING — downloading it,
          re-analysing it, forgetting it — and belong to the page, not to the
          bar. Absolutely positioned rather than sitting in the row, so they
          keep the place they have always had while scrolling away with
          everything else: a destructive action has no business riding along
          under the cursor for the whole visit. Above the bar in z-order, or
          its backdrop would hide them while the two are at rest. */}
      {/* Spans everything below, not just the bar: a sticky element can only
          travel within its own parent, so a wrapper cut to the bar's height
          would let it scroll away immediately — which is exactly what it did. */}
      <div class="relative">
        {audioUrl && (
          <div class="absolute top-3 right-0 z-20 h-7 flex items-center gap-3">
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
        {/* `top-0` rather than a negative offset that cancels the page's own
            padding: the bar then pins at the scrollport edge and its `pt-3`
            shows in both states, so the room above the controls is the same
            number pinned and at rest — it cannot drift apart. And `pt-3`
            matches the timeline's `mt-3` just below, so the bar sits in equal
            air top and bottom. Change one of the three and change all three. */}
        <div class="sticky top-0 z-10 bg-bg -mx-6 px-6 pt-3 pb-3">
          {audioUrl && (
            <div class="flex items-center gap-2 flex-wrap">
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
              <span ref={timeLblRef} class="text-[11px] font-mono text-dim tabular-nums">0:00 / 0:00</span>
            </div>
          )}

          <div
            ref={barRef}
            class="relative h-5 rounded bg-elevated mt-3 overflow-hidden cursor-pointer touch-none select-none"
            onPointerDown={onBarDown}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
            onPointerCancel={onBarUp}
            onDblClick={onBarDoubleClick}
          >
            {session.annotations.map((ann, i) => {
            const end = ann.end ?? session.duration;
            const isCurrent = lit.ids.includes(ann.id);
            return (
              <div
                key={ann.id}
                data-seg={ann.id}
                class={`absolute top-0 bottom-0 transition-[filter,box-shadow] ${isCurrent ? 'brightness-150 z-[1]' : 'hover:brightness-125'}`}
                style={{
                  left: `${(ann.start / session.duration) * 100}%`,
                  // Exact width, with a floor in PIXELS rather than in percent:
                  // a percentage floor widened short tunes into a lie, and a lie
                  // the play head is about to walk across and contradict. Two
                  // pixels keep a very short detection clickable without moving
                  // where it starts.
                  width: `${((end - ann.start) / session.duration) * 100}%`,
                  minWidth: '2px',
                  backgroundColor: BUCKET_SEGMENT[ann.bucket],
                  backgroundImage: HATCH[i % 2],
                  ...(isCurrent ? { boxShadow: 'inset 0 0 0 1.5px var(--color-primary)' } : {}),
                }}
                title={ann.displayName}
              />
            );
          })}
          {/* Above the segments, and deaf to pointers so a click lands on the
              segment underneath rather than on the head itself. */}
          <div
            ref={headRef}
            class="absolute top-0 bottom-0 w-0.5 bg-primary pointer-events-none z-[2]"
            style={{ left: '0%' }}
          />
          </div>
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
          {withGaps(session.annotations, session.duration).map(item => (
            item.kind === 'gap' ? (
              // What the timeline shows as a hole and the list used to swallow
              // whole: read end to end, the cards otherwise describe one
              // unbroken concert.
              <div
                key={`gap-${item.from}`}
                data-gap-from={item.from}
                // Lit like a card when the head stands in it: a silence is a
                // place in the recording too, and "you are here" has to be
                // answerable there as well.
                class={`flex items-center gap-3 py-1 text-[11px] transition-colors ${
                  lit.gapFrom === item.from ? 'text-accent' : 'text-dim'}`}
              >
                <span class={`h-px flex-1 ${lit.gapFrom === item.from ? 'bg-accent/50' : 'bg-border'}`} />
                <span class="shrink-0 tabular-nums">{t('sessions.gap', { d: fmtLongTime(item.len) })}</span>
                <span class={`h-px flex-1 ${lit.gapFrom === item.from ? 'bg-accent/50' : 'bg-border'}`} />
              </div>
            ) : (
              <div
                key={item.ann.id}
                data-ann-id={item.ann.id}
                // The answer to "which one did I just scroll to": the card is
                // ringed, not merely centred among identical neighbours.
                class={`rounded-lg transition-shadow ${lit.ids.includes(item.ann.id) ? 'ring-2 ring-accent' : ''}`}
              >
                <AnnotationCard ann={item.ann} opts={cardOptsFor(item.ann, item.i)} />
              </div>
            )
          ))}
        </div>
      </div>
    </>
  );
}
