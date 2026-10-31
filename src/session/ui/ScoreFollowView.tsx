import { signal, type Signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Detection } from '../model';
import {
  followDetection, followFrom, type SessionFollow, type FollowFailure, type FollowStatus, type FollowSamples, type FollowAudio,
} from '../scoreFollowClient';
import { AudioPlayer, stopCurrentAudio, type AudioPlayerHooks, type Region } from '../../components/audioPlayer';
import { scoreContour } from '../../components/syncedScore';
import { MATCH_GOOD, MATCH_USABLE } from '../scoreFollow';
import type { AudioSyncState, AudioSyncView } from '../../components/fileViewer';
import { t } from '../../services/i18nService';
import { stripForRender } from '../../services/abcService';
import { ExpandIcon, CollapseIcon } from '../../components/icons';
import { registerOverlay } from '../../components/overlayStack';

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
//   - the region: the detection's range, then the tune's own span.
// The score is the version on the viewer's screen, as written there — the
// one heard, or another, in the recognition index or not: the alignment reads
// its notes off the drawing (scoreContour). A version changed aligns anew
// under the SAME player (the user, 2026-10-29: the recording has not changed,
// so neither does its half). How the alignment goes is the viewer's toggle's
// to show (AudioSyncState).

type Phase =
  | { kind: 'aligning'; status: FollowStatus | null }
  | { kind: 'failed'; reason: FollowFailure | 'error' }
  | { kind: 'ready'; follow: SessionFollow };

/** Waveform bars: a tune is a few minutes, more detail than a short clip's 120. */
const WAVE_BARS = 240;

function failureText(reason: FollowFailure | 'error'): string {
  switch (reason) {
    case 'no_contour': return t('sessions.follow.failed.no_contour');
    case 'no_audio': return t('sessions.follow.failed.no_audio');
    case 'no_alignment': return t('sessions.follow.failed.no_alignment');
    default: return t('sessions.follow.failed.error');
  }
}

function stageText(status: FollowStatus | null): string {
  switch (status?.stage) {
    case 'listen': return t('sessions.follow.stage.listen');
    case 'tempo': return t('sessions.follow.stage.tempo');
    case 'align': return t('sessions.follow.stage.align');
    default: return t('sessions.follow.stage.decode');
  }
}

/** The score for this view: what the score viewer draws (stripForRender — no
 *  `Z:` transcriber under the last line, 2026-10-30), less what it only
 *  silences: the modal's header already names the tune, and the rhythm is on
 *  the detection — title and R: would only push the music down. */
function bareScore(abc: string): string {
  return stripForRender(abc).split('\n').filter(l => !/^(T|R):/.test(l)).join('\n');
}

/** The TheSession setting a version is, from its `S:` line
 *  ("…/tunes/1633#setting46304"): its index contour competes with the drawn
 *  score (the worker's header). */
function settingOfVersion(abc: string): string | undefined {
  return /^S:.*#setting(\d+)(?!\d)/m.exec(abc)?.[1];
}

/** The version's meter, as slotNotes wants it: "C" is 4/4, "C|" 2/2. */
function meterOf(abc: string): string {
  const m = /^M:\s*(\S+)/m.exec(abc)?.[1];
  return m === 'C' ? '4/4' : m === 'C|' ? '2/2' : m && /^\d+\/\d+$/.test(m) ? m : '4/4';
}

// How far the alignment can be trusted: scoreFollow.ts's MATCH_GOOD and
// MATCH_USABLE — below the latter no following at all (2026-10-29, the user):
// a cursor that may be anywhere is worse than none, and the score is left to
// scroll by hand.

/** The share of the detected passage the alignment must cover. The match is
 *  counted on what was aligned only: a version in another key had 13 quavers
 *  of 110 s aligned by chance, half of them "right", and showed amber
 *  (2026-10-29, the user). Below this it is no alignment. */
const USABLE_COVER = 0.5;

/** The share of the detection's span (`span` s) the alignment covers. */
function coverOf(f: SessionFollow, span: number): number {
  return span > 0 ? (f.end - f.times[0]!) / span : 1;
}

/** An alignment worth following, or null. `forced`: any there is (the
 *  viewer's hidden gesture). */
function usable(phase: Phase, span: number, forced: boolean): SessionFollow | null {
  if (phase.kind !== 'ready') return null;
  if (forced) return phase.follow;
  return phase.follow.match >= MATCH_USABLE && coverOf(phase.follow, span) >= USABLE_COVER ? phase.follow : null;
}

/** What the viewer's Audio sync toggle shows of the alignment (AudioSyncState):
 *  its colour, the words and figures in its tooltip — which, followed by
 *  force, says so: the colour stays the verdict. */
function stateOf(phase: Phase, span: number, forced: boolean): AudioSyncState {
  const s = verdictOf(phase, span);
  return forced && s.kind === 'none' && phase.kind === 'ready'
    ? { ...s, title: `${t('fileViewer.abc.audioSync.forced')} · ${s.title}` }
    : s;
}

function verdictOf(phase: Phase, span: number): AudioSyncState {
  if (phase.kind === 'aligning') {
    const ratio = phase.status?.ratio ?? 0;
    return { kind: 'aligning', ratio, title: `${stageText(phase.status)} · ${Math.round(ratio * 100)} %` };
  }
  if (phase.kind === 'failed') return { kind: 'none', title: failureText(phase.reason) };
  const f = phase.follow;
  const stats = t('sessions.follow.stats', { match: Math.round(f.match * 100), bpm: f.bpm });
  const cover = coverOf(f, span);
  // No figure for a part aligned by chance: its share of notes says nothing.
  if (cover < USABLE_COVER) return { kind: 'none', title: t('sessions.follow.quality.partial', { part: Math.round(cover * 100) }) };
  const percent = Math.round(f.match * 100);
  if (f.match < MATCH_USABLE) return { kind: 'none', title: `${t('sessions.follow.quality.poor')} · ${stats}`, percent };
  const word = f.match >= MATCH_GOOD ? t('sessions.follow.quality.good') : t('sessions.follow.quality.fair');
  return { kind: 'aligned', title: `${word} · ${stats}`, percent };
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

function ScoreFollowView({ ann, version, getAudio, expanded, face, onState, forced }: {
  ann: Detection;
  /** The version on the viewer's screen: its ABC. */
  version: Signal<string>;
  getAudio: () => Promise<FollowAudio | undefined>;
  expanded: Signal<boolean>;
  face: Signal<'sheet' | 'text'>;
  onState: (s: AudioSyncState) => void;
  /** Followed whatever the verdict (the viewer's hidden gesture). */
  forced: Signal<boolean>;
}) {
  const shown = version.value;
  const isForced = forced.value;
  const [phase, setPhase] = useState<Phase>({ kind: 'aligning', status: null });
  const [score, setScore] = useState<{ abc: string; meter: string } | null>(null);
  const samples = useMemo(() => deferred<FollowSamples>(), []);
  const span = (ann.end ?? ann.start + 60) - ann.start;
  const follow = usable(phase, span, isForced);
  const from = followFrom(ann.start);

  // The region the player opens on: the detection's range; then the tune's
  // own span once an alignment worth following knows it. Kept while another
  // version is aligned: the recording is the same, and so is the tune in it.
  // Back to the detection's range when no alignment is followed any more —
  // judged too poor, or no longer forced: a forced one may have held a few
  // seconds of it.
  const detectionRegion = (): Region => ({ start: ann.start - from, end: (ann.end ?? ann.start + 60) - from });
  const regionRef = useRef<Region>(detectionRegion());
  const region = useMemo<Region>(() => {
    if (follow) regionRef.current = { start: follow.times[0]!, end: follow.end };
    else if (phase.kind !== 'aligning') regionRef.current = detectionRegion();
    return regionRef.current;
  }, [follow, phase.kind]);

  const hooks = useMemo<AudioPlayerHooks>(() => ({
    load: async (engine) => {
      const s = await samples.promise;
      return engine.loadSamples([s.pcm], s.rate, WAVE_BARS);
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
        const [contour, audio] = await Promise.all([scoreContour(abc, meter), getAudio()]);
        if (cancelled) return;
        if (!audio) { samples.reject(new Error(failureText('no_audio'))); setPhase({ kind: 'failed', reason: 'no_audio' }); return; }
        if (!contour) { setPhase({ kind: 'failed', reason: 'no_contour' }); return; }
        const result = await followDetection(audio, contour, settingOfVersion(shown), ann.start, ann.end ?? ann.start + 60,
          status => { if (!cancelled) setPhase(p => (p.kind === 'aligning' ? { kind: 'aligning', status } : p)); },
          stopWork.signal,
          // Only the first time counts: the player has its samples already.
          s => samples.resolve(s));
        if (cancelled) return;
        if (typeof result === 'string') {
          if (result === 'no_audio') samples.reject(new Error(failureText('no_audio')));
          setPhase({ kind: 'failed', reason: result });
          return;
        }
        setPhase({ kind: 'ready', follow: result });
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

  useEffect(() => { onState(stateOf(phase, span, isForced)); }, [phase, isForced]);
  // No alignment followed: the whole waveform in its verdict's colour — the
  // share of notes when there is a fair one, red for a part aligned by
  // chance or none at all.
  const verdict = verdictOf(phase, span);
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

  // In the score's corner, as in the viewer: the way in, then the way out.
  const pageLabel = t(page ? 'fileViewer.abc.fullscreenExit' : 'fileViewer.abc.fullscreen');
  const tools = (
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
        score={score ? { abc: score.abc, meter: score.meter, follow, maxHeight, face: face.value, tools, tint } : undefined}
      />
    </div>
  );
}

/** `version` — a version of `ann`'s tune, its ABC — its cursor following
 *  `ann`'s recording, in `host`: the score viewer's audio sync (fileViewer.ts,
 *  PreviewModalOpts.audioSync). The paper is the viewer's setting, read live,
 *  and its gear changes it. */
export function mountScoreFollow(host: HTMLElement, opts: {
  ann: Detection;
  version: string;
  getAudio: () => Promise<FollowAudio | undefined>;
  face: 'sheet' | 'text';
  expanded: boolean;
  onState: (s: AudioSyncState) => void;
  forced: boolean;
}): AudioSyncView {
  const version = signal(opts.version);
  const face = signal(opts.face);
  const expanded = signal(opts.expanded);
  const forced = signal(opts.forced);
  render(
    <ScoreFollowView
      ann={opts.ann} version={version} getAudio={opts.getAudio} expanded={expanded} face={face}
      onState={opts.onState} forced={forced}
    />,
    host,
  );
  return {
    setVersion: (v) => { version.value = v; },
    setForced: (v) => { forced.value = v; },
    setFace: (f) => { face.value = f; },
    setExpanded: (v) => { expanded.value = v; },
    unmount: () => render(null, host),
  };
}
