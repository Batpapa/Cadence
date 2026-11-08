import { signal, type Signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  followAudio, followFrom, type SessionFollow, type FollowFailure, type FollowStatus, type FollowSamples, type FollowAudio,
} from '../scoreFollowClient';
import { AudioPlayer, stopCurrentAudio, type AudioPlayerHooks, type Region } from '../../components/audioPlayer';
import { scoreContour, bareScore, meterOf } from '../../components/syncedScore';
import { MATCH_GOOD, MATCH_USABLE, withPickup } from '../scoreFollow';
import { signedKeyOffset } from '../model';
import { keyGapText } from '../keyName';
import type { AudioSyncState, AudioSyncView } from '../../components/fileViewer';
import { t } from '../../services/i18nService';
import { formatBytes } from '../../utils';
import { ExpandIcon, CollapseIcon } from '../../components/icons';
import { registerOverlay } from '../../components/overlayStack';
import type { ScoreFace } from '../../types';

// ── A detection's score, following its recording ─────────────────────────────
// The score viewer's "Audio sync" (2026-10-28, the user: one way in, the
// score, rather than a button of its own beside it): the file viewer's audio
// player (waveform, A-B region, tempo, transposition, fine pitch — no presets)
// with a setting's score drawn above it and following what is heard — on the
// stave, or in the ABC text, as the viewer's tabs say. The player does the
// score (`score`, syncedScore.tsx); this view feeds it:
//   - the stretch of the recording the detection covers, decoded by the
//     score-follow worker and handed over the moment it is — the player plays
//     the very samples the alignment is made on, one clock to the sample;
//   - the setting's ABC, at once, and the alignment when it lands — the wait
//     is spent listening, the cursor joins in;
//   - the region: the detection's range — a card's recording, its whole, then
//     the tune's own span.
// The score is the version on the viewer's screen, as written there — the
// one heard, or another, in the recognition index or not: the alignment reads
// its notes off the drawing (scoreContour). A version changed aligns anew
// under the SAME player (the user, 2026-10-29: the recording has not changed,
// so neither does its half). How the alignment goes is the viewer's toggle's
// to show (AudioSyncState).
//
// A card's recording too (2026-10-31, the user; for everyone since 11-01): its
// ABC with one of its audio or video attachments (cardAudioSync.ts). No
// detection says where the tune is: the whole recording is aligned, a long
// one searched first (scoreFollowWorker) — the player then gets what was
// aligned, and opens on the whole of it.

/** What is followed: the passage a detection heard the tune in, in session
 *  time; or a recording the tune is anywhere in. */
export type FollowTarget =
  | { kind: 'passage'; start: number; end: number }
  | { kind: 'recording' };

type Phase =
  | { kind: 'aligning'; status: FollowStatus | null }
  | { kind: 'failed'; reason: FollowFailure | 'error' }
  | { kind: 'ready'; follow: SessionFollow };

/** Waveform bars: a tune is a few minutes, more detail than a short clip's 120. */
const WAVE_BARS = 240;

export function failureText(reason: FollowFailure | 'error'): string {
  switch (reason) {
    case 'no_contour': return t('sessions.follow.failed.no_contour');
    case 'no_audio': return t('sessions.follow.failed.no_audio');
    case 'no_alignment': return t('sessions.follow.failed.no_alignment');
    default: return t('sessions.follow.failed.error');
  }
}

export function stageText(status: FollowStatus | null): string {
  switch (status?.stage) {
    // With what has come down when the size is not told: no ratio to show.
    case 'download': return sizeUnknown(status)
      ? `${t('sessions.follow.stage.download')} ${formatBytes(status.received ?? 0)}`
      : t('sessions.follow.stage.download');
    case 'scan': return t('sessions.follow.stage.scan');
    case 'locate': return t('sessions.follow.stage.locate');
    case 'listen': return t('sessions.follow.stage.listen');
    case 'tempo': return t('sessions.follow.stage.tempo');
    case 'align': return t('sessions.follow.stage.align');
    default: return t('sessions.follow.stage.decode');
  }
}

/** A download whose size its server did not tell: bytes, not a ratio. */
export function sizeUnknown(status: FollowStatus | null): boolean {
  return status?.stage === 'download' && status.received !== undefined;
}

/** The TheSession setting a version is, from its `S:` line
 *  ("…/tunes/1633#setting46304"): its index contour competes with the drawn
 *  score (the worker's header). */
export function settingOfVersion(abc: string): string | undefined {
  return /^S:.*#setting(\d+)(?!\d)/m.exec(abc)?.[1];
}

// How far the alignment can be trusted: scoreFollow.ts's MATCH_GOOD and
// MATCH_USABLE — below the latter no following at all (2026-10-29, the user):
// a cursor that may be anywhere is worse than none, and the score is left to
// scroll by hand.

/** The share of the detected passage the alignment must cover. The match is
 *  counted on what was aligned only: a version in another key had 13 quavers
 *  of 110 s aligned by chance, half of them "right", and showed amber
 *  (2026-10-29, the user). Below this it is no alignment. In a card's
 *  recording, which holds whatever else around the tune, the share of ONE
 *  PASS of the tune at the tempo found — or of the recording, if shorter. */
const USABLE_COVER = 0.5;

/** The share the alignment covers of what it must (USABLE_COVER). */
function coverOf(f: SessionFollow, target: FollowTarget): number {
  const span = target.kind === 'passage' ? target.end - target.start
    : Math.min(f.seconds, (f.quavers * 30) / f.bpm);
  return span > 0 ? (f.end - f.times[0]!) / span : 1;
}

/** Whether an alignment is worth following, short of being forced. */
function followable(f: SessionFollow, target: FollowTarget): boolean {
  return f.match >= MATCH_USABLE && coverOf(f, target) >= USABLE_COVER;
}

/** An alignment worth following, or null. `forced`: any there is (the
 *  viewer's hidden gesture). */
function usable(phase: Phase, target: FollowTarget, forced: boolean): SessionFollow | null {
  if (phase.kind !== 'ready') return null;
  if (forced) return phase.follow;
  return followable(phase.follow, target) ? phase.follow : null;
}

/** What the viewer's Audio sync toggle shows of the alignment (AudioSyncState):
 *  its colour, the words and figures in its tooltip — which, followed by
 *  force, says so: the colour stays the verdict. */
function stateOf(phase: Phase, target: FollowTarget, forced: boolean, shown: number): AudioSyncState {
  const s = verdictOf(phase, target, shown);
  return forced && s.kind === 'none' && phase.kind === 'ready'
    ? { ...s, title: `${t('fileViewer.abc.audioSync.forced')} · ${s.title}` }
    : s;
}

function verdictOf(phase: Phase, target: FollowTarget, shown = 0): AudioSyncState {
  if (phase.kind === 'aligning') {
    const ratio = phase.status?.ratio ?? 0;
    const title = sizeUnknown(phase.status) ? stageText(phase.status) : `${stageText(phase.status)} · ${Math.round(ratio * 100)} %`;
    return { kind: 'aligning', ratio, title };
  }
  if (phase.kind === 'failed') return { kind: 'none', title: failureText(phase.reason) };
  return alignedVerdict(phase.follow, target, shown);
}

/** The verdict on an alignment made: the toggle's, and each recording's in a
 *  card's chooser (RecordingChooser). */
export function alignedVerdict(f: SessionFollow, target: FollowTarget, shown = 0): AudioSyncState {
  // The key the recording plays the score in, against the key it is drawn in.
  const keyGap = signedKeyOffset(f.transpose - shown);
  const stats = t('sessions.follow.stats', { match: Math.round(f.match * 100), bpm: f.bpm })
    + (keyGap !== 0 ? ` · ${t('sessions.follow.keyGap', { shift: keyGapText(keyGap) })}` : '');
  const cover = coverOf(f, target);
  // No figure for a part aligned by chance: its share of notes says nothing.
  if (cover < USABLE_COVER) {
    const part = Math.round(cover * 100);
    return {
      kind: 'none',
      title: target.kind === 'passage' ? t('sessions.follow.quality.partial', { part }) : t('sessions.follow.quality.partialPass', { part }),
    };
  }
  const percent = Math.round(f.match * 100);
  if (f.match < MATCH_USABLE) return { kind: 'none', title: `${t('sessions.follow.quality.poor')} · ${stats}`, percent, keyGap };
  const word = f.match >= MATCH_GOOD ? t('sessions.follow.quality.good') : t('sessions.follow.quality.fair');
  return { kind: 'aligned', title: `${word} · ${stats}`, percent, keyGap };
}

/** The score box's floor, as SyncedScore sets it (8rem). */
const MIN_SCORE_PX = 128;

/** The nearest ancestor that scrolls: the dialog's body. */
function scrollingParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

/** A promise settled from outside: the player asks for its samples at once,
 *  and they come when the worker has decoded them. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The whole of what was loaded: the player brings the end within it. */
const WHOLE: Region = { start: 0, end: Number.POSITIVE_INFINITY };

/** The recording, or undefined having said why. A card's may have to come
 *  down first: how far, through `onStatus` ('download'); `signal`, the view
 *  closed meanwhile. */
type GetAudio = (onStatus: (s: FollowStatus) => void, signal: AbortSignal) => Promise<FollowAudio | undefined>;

function ScoreFollowView({ target, version, getAudio, expanded, face, onState, forced, transpose }: {
  target: FollowTarget;
  /** The version on the viewer's screen: its ABC. */
  version: Signal<string>;
  getAudio: GetAudio;
  expanded: Signal<boolean>;
  face: Signal<ScoreFace>;
  onState: (s: AudioSyncState) => void;
  /** Followed whatever the verdict (the viewer's hidden gesture). */
  forced: Signal<boolean>;
  /** The viewer's transposition: the score is drawn in that key, and the gap
   *  to the recording's key (FollowResult.transpose) told from it. */
  transpose: Signal<number>;
}) {
  const shown = version.value;
  const shift = transpose.value;
  const isForced = forced.value;
  const [phase, setPhase] = useState<Phase>({ kind: 'aligning', status: null });
  const [score, setScore] = useState<{ abc: string; meter: string } | null>(null);
  const samples = useMemo(() => deferred<FollowSamples>(), []);
  const follow = usable(phase, target, isForced);

  // The region the player opens on. A detection's: its range, always — not
  // the span the alignment found, which it used to switch to (2026-11-01, the
  // user): with the bounds now put on the tune's passes (boundSuggest.ts), the
  // two came from two alignments of two stretches — this one reads 3 s round
  // the bounds, and cannot enter the tune before them — and the player opened
  // seconds away from where the card says the tune is. The cursor starts with
  // the first note aligned; the sound, with the bound. A recording's: its
  // whole, then the tune's own span once an alignment worth following knows
  // it — no bounds to go by there. Kept while another version is aligned: the
  // recording is the same, and so is the tune in it. Back to the whole when
  // no alignment is followed any more — judged too poor, or no longer forced.
  const firstRegion = (): Region => {
    if (target.kind === 'recording') return WHOLE;
    const from = followFrom(target.start);
    return { start: target.start - from, end: target.end - from };
  };
  const regionRef = useRef<Region>(firstRegion());
  const region = useMemo<Region>(() => {
    if (target.kind === 'passage') return regionRef.current;
    if (follow) regionRef.current = { start: follow.times[0]!, end: follow.end };
    else if (phase.kind !== 'aligning') regionRef.current = firstRegion();
    return regionRef.current;
  }, [follow, phase.kind]);

  const hooks = useMemo<AudioPlayerHooks>(() => ({
    load: async (engine) => {
      const s = await samples.promise;
      return { ...(await engine.loadSamples([s.pcm], s.rate, WAVE_BARS)), origin: s.from };
    },
    autoplay: true,
  }), []);

  // The score's text, the samples, then the alignment — again for each
  // version, the player left as it is.
  useEffect(() => {
    let cancelled = false;
    const stopWork = new AbortController();
    setPhase({ kind: 'aligning', status: null });
    const abc = bareScore(shown);
    const meter = meterOf(shown);
    setScore({ abc, meter });
    void (async () => {
      try {
        const setStatus = (status: FollowStatus) => { if (!cancelled) setPhase(p => (p.kind === 'aligning' ? { kind: 'aligning', status } : p)); };
        const [contour, audio] = await Promise.all([scoreContour(abc, meter), getAudio(setStatus, stopWork.signal)]);
        if (cancelled) return;
        if (!audio) { samples.reject(new Error(failureText('no_audio'))); setPhase({ kind: 'failed', reason: 'no_audio' }); return; }
        if (!contour) { setPhase({ kind: 'failed', reason: 'no_contour' }); return; }
        const result = await followAudio(audio, contour, settingOfVersion(shown),
          target.kind === 'passage' ? { start: target.start, end: target.end } : null,
          setStatus,
          stopWork.signal,
          // Only the first time counts: the player has its samples already.
          s => samples.resolve(s));
        if (cancelled) return;
        if (typeof result === 'string') {
          // Nothing to play when nothing was decoded — the recording
          // unreadable, or the tune not found in it — and the player would
          // wait for it for ever. A no-op once it has its samples.
          samples.reject(new Error(failureText(result)));
          setPhase({ kind: 'failed', reason: result });
          return;
        }
        setPhase({ kind: 'ready', follow: withPickup(result, meter) });
      } catch (err) {
        console.error('[score-follow]', err);
        samples.reject(err);
        if (!cancelled) setPhase({ kind: 'failed', reason: 'error' });
      }
    })();
    return () => {
      cancelled = true;
      stopWork.abort();
    };
  }, [shown]);

  // The player's sound goes with the view, as the file viewer's does — not
  // with a version, which keeps the player.
  useEffect(() => () => stopCurrentAudio(), []);

  useEffect(() => { onState(stateOf(phase, target, isForced, shift)); }, [phase, isForced, shift]);
  // No alignment followed: the whole waveform in its verdict's colour — the
  // share of notes when there is a fair one, red for a part aligned by
  // chance or none at all.
  const verdict = verdictOf(phase, target, shift);
  const tint = follow || phase.kind === 'aligning' ? undefined
    : verdict.kind !== 'aligning' && verdict.percent !== undefined ? verdict.percent / 100 : 0;

  const rootRef = useRef<HTMLDivElement>(null);

  // ── The score's own full page (2026-10-29, the user) ──
  // As the score viewer has one, over everything — the score, the waveform
  // and the player's controls, nothing of the viewer around them. The view's
  // container (the viewer's host) is moved into an overlay and back, never the
  // view itself: the player and its sound go on as they were. Escape and the
  // back gesture leave it (overlayStack), as the viewer's own does.
  const [page, setPage] = useState(false);
  const pageRef = useRef<{ overlay: HTMLElement; anchor: Comment; host: HTMLElement; unregister: () => void } | null>(null);
  const leavePage = (rerender = true) => {
    const p = pageRef.current;
    if (!p) return;
    pageRef.current = null;
    p.unregister();
    p.anchor.replaceWith(p.host);
    p.overlay.remove();
    if (rerender) setPage(false);
  };
  const enterPage = () => {
    const host = rootRef.current?.parentElement;
    if (!host || pageRef.current) return;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex flex-col overflow-hidden safe-area-pad';
    overlay.style.background = 'var(--color-elevated)';
    const anchor = document.createComment('score-follow');
    host.replaceWith(anchor);
    overlay.appendChild(host);
    document.body.appendChild(overlay);
    pageRef.current = { overlay, anchor, host, unregister: registerOverlay(() => leavePage()) };
    setPage(true);
  };
  // The view can go while on its full page — the dialog closed from
  // elsewhere — and an overlay nothing points at would stay on screen.
  useEffect(() => () => leavePage(false), []);

  // The dialog's full page, and the score's own: all the height there is
  // (the user, 2026-10-29) — measured, not guessed: the score's box as it is,
  // plus whatever its container has to spare (or minus what overflows it).
  // Again whenever the container or the view changes size.
  const [fit, setFit] = useState<number | null>(null);
  const isExpanded = expanded.value;
  const shownFace = face.value;
  useEffect(() => {
    setFit(null);
    const root = rootRef.current;
    const body = !root ? null : page ? pageRef.current?.overlay ?? null : isExpanded ? scrollingParent(root) : null;
    if (!root || !body) return;
    const measure = () => {
      const box = root.querySelector<HTMLElement>(shownFace === 'text' ? '.score-follow-text' : '.score-follow-paper');
      if (!box) return;
      // The body's room against what its content takes — not its
      // scrollHeight, which never drops below its own height: the room to
      // spare read as none, and the score stayed small over an empty half page.
      const cs = getComputedStyle(body);
      const room = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const used = Array.from(body.children).reduce((sum, c) => sum + (c as HTMLElement).offsetHeight, 0);
      const next = Math.max(MIN_SCORE_PX, box.clientHeight + room - used);
      setFit(prev => (prev !== null && Math.abs(prev - next) < 2 ? prev : next));
    };
    // At the next frame, not in the observer: the height set resizes what it
    // observes, which the browser reports as a loop (2026-10-29, the user).
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(body);
    ro.observe(root);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [isExpanded, shownFace, page]);

  // In the dialog: what it leaves for the score once the player under it, and
  // the viewer's row of tabs above it, are counted — so the player is never
  // pushed below the fold. In layout pixels: the app zooms <html>, dvh does
  // not know. Full page, the measure above; this until it is in.
  const maxHeight = page || isExpanded
    ? (fit !== null ? `${fit}px` : 'calc(100dvh / var(--zoom-factor, 1) - 28rem)')
    : 'min(46vh, calc(100dvh / var(--zoom-factor, 1) - 32rem))';

  // Full page, floor and cap alike (2026-11-01, the user): the paper fills
  // the page, as the viewer's full page does, however short the tune.

  // In the score's corner, as in the viewer: the way in, then the way out —
  // and, as in the viewer, none with the stave and the text together (the
  // user, 2026-11-04).
  const pageLabel = t(page ? 'fileViewer.abc.fullscreenExit' : 'fileViewer.abc.fullscreen');
  const tools = shownFace === 'both' && !page ? undefined : (
    <button
      class="abc-score-tool-small rounded transition-colors cursor-pointer flex items-center justify-center"
      title={pageLabel}
      aria-label={pageLabel}
      onClick={(e) => { e.currentTarget.blur(); if (page) leavePage(); else enterPage(); }}
    >
      {page ? <CollapseIcon size={13} /> : <ExpandIcon size={13} />}
    </button>
  );

  return (
    // The player's own padding taken back, so it sits flush in the dialog —
    // not on the full page, which has none.
    <div ref={rootRef} class={page ? '' : '-mx-4 -mt-1'}>
      <AudioPlayer
        hooks={{ ...hooks, region }}
        score={score ? { abc: score.abc, meter: score.meter, follow, maxHeight, minHeight: page ? maxHeight : undefined, face: face.value, tools, tint, keyShift: shift } : undefined}
      />
    </div>
  );
}

/** `version` — a version of the tune, its ABC — its cursor following
 *  `target` of the recording `getAudio` gives, in `host`: the score viewer's
 *  audio sync (fileViewer.ts, PreviewModalOpts.audioSync). The paper is the
 *  viewer's setting, read live, and its gear changes it. */
export function mountScoreFollow(host: HTMLElement, opts: {
  target: FollowTarget;
  version: string;
  getAudio: GetAudio;
  face: ScoreFace;
  expanded: boolean;
  onState: (s: AudioSyncState) => void;
  forced: boolean;
  /** The viewer's transposition (ScoreFollowView's `transpose`). */
  transpose: number;
}): AudioSyncView {
  const version = signal(opts.version);
  const face = signal(opts.face);
  const expanded = signal(opts.expanded);
  const forced = signal(opts.forced);
  const transpose = signal(opts.transpose);
  render(
    <ScoreFollowView
      target={opts.target} version={version} getAudio={opts.getAudio} expanded={expanded} face={face}
      onState={opts.onState} forced={forced} transpose={transpose}
    />,
    host,
  );
  return {
    setVersion: (v) => { version.value = v; },
    setForced: (v) => { forced.value = v; },
    setFace: (f) => { face.value = f; },
    setExpanded: (v) => { expanded.value = v; },
    setTranspose: (v) => { transpose.value = v; },
    unmount: () => render(null, host),
  };
}
