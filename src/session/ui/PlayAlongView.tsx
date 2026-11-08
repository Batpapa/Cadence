import { signal, type Signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { SyncedScore, scoreContour, bareScore, meterOf, type LiveClock } from '../../components/syncedScore';
import { startPlayAlong, playAlongOffset, setPlayAlongOffset, type PlayAlong, type PlayAlongStatus } from '../playAlongClient';
import { beatOfDance, type Beat } from '../liveFollow';
import { capturing } from '../../services/audioSession';
import { devMode } from '../../services/devMode';
import { qualityColour, LIVE_SCALE } from '../../components/followColour';
import { CrossIcon, MinusIcon, PlusIcon, ExpandIcon, CollapseIcon, SaveIcon } from '../../components/icons';
import { registerOverlay } from '../../components/overlayStack';
import type { PlayAlongView } from '../../components/fileViewer';
import type { Attachment, ScoreFace } from '../../types';
import { askRecordingName, recordingAttachment, stampedName, RecorderRow } from '../../components/recordMicModal';
import { askUnsavedChanges } from '../../components/modal';
import type { MemoryRecorder } from '../../thesessionEmbed/memoryRecorder';
import { t } from '../../services/i18nService';
import { downloadBlob } from '../../utils';

// ── Play-along: the score following what is being played ─────────────────────
// The score viewer's Play-along (2026-10-31, the user; out of developer mode
// 2026-11-01): what the microphone hears followed live (playAlongClient.ts),
// and the version on the viewer's screen drawn with its cursor on what is
// heard (SyncedScore's live clock). Under the score, the version of the file
// that fits what is played better, when it is not the one on screen (an
// option of the viewer, on by default); at the bottom, a bar: the follower's
// state, and the capture latency to correct the cursor's lead by — per device,
// for every user of it. Developer mode adds the take's download, to replay it
// in the bench (experiments/score-follow/live.mjs).

/** The microphone as it stands: opening, open, or refused. The only source
 *  (2026-11-01, the user): a tab's sound, offered in developer mode to try
 *  it on a video, is gone. */
type Source =
  | { kind: 'opening' }
  | { kind: 'open'; client: PlayAlong }
  | { kind: 'failed'; message: string };

/** How often the bar is read again. */
const STATUS_MS = 250;
/** How fast the tempo and the quality shown follow the follower's, seconds
 *  (time constants: about two thirds of a change shown after that long) —
 *  each already read over the last 3 s. */
const SMOOTH_TEMPO_S = 3;
const SMOOTH_MATCH_S = 4;
/** Beats a minute the tempo must move by before it is written again. */
const BPM_HYSTERESIS = 1.5;

interface Smoothed { rate: number | null; match: number | null; at: number }
/** The score's floor on its full page, as the audio sync's. */
const MIN_SCORE_PX = 128;
/** The pane's gap between the score and what is under it (gap-3). */
const BELOW_GAP_REM = 0.75;
/** What the dialog keeps around the pane — its header and padding, the
 *  viewer's row of tabs — taken from the score's height with what is
 *  under it (measured): expanded, and not. */
const AROUND_EXPANDED_REM = 13.5;
const AROUND_REM = 17.5;
/** One press of − or + on the latency. */
const OFFSET_STEP_MS = 10;

/** Each state's words — whole keys, which the i18n test can check. */
const STATE_TEXT = {
  search: 'fileViewer.abc.playAlong.state.search',
  follow: 'fileViewer.abc.playAlong.state.follow',
  lost: 'fileViewer.abc.playAlong.state.lost',
} as const;

/** The tempo's words, per beat (liveFollow.ts's beatOfDance) — whole keys. */
const TEMPO_TEXT: Record<Beat['unit'], 'fileViewer.abc.playAlong.tempo.minim' | 'fileViewer.abc.playAlong.tempo.dottedMinim' | 'fileViewer.abc.playAlong.tempo.crotchet' | 'fileViewer.abc.playAlong.tempo.dottedCrotchet' | 'fileViewer.abc.playAlong.tempo.quaver'> = {
  minim: 'fileViewer.abc.playAlong.tempo.minim',
  dottedMinim: 'fileViewer.abc.playAlong.tempo.dottedMinim',
  crotchet: 'fileViewer.abc.playAlong.tempo.crotchet',
  dottedCrotchet: 'fileViewer.abc.playAlong.tempo.dottedCrotchet',
  quaver: 'fileViewer.abc.playAlong.tempo.quaver',
};

/** Opens the microphone — from the tap that asked for it. Refused while a
 *  live recording holds it: the Play-along does not take it from under it. */
function open(into: Signal<Source>, onEnded: () => void): void {
  if (capturing()) {
    into.value = { kind: 'failed', message: t('fileViewer.abc.playAlong.error.busy') };
    return;
  }
  into.value = { kind: 'opening' };
  startPlayAlong(onEnded).then(
    (client) => {
      // Closed while it was opening.
      if (into.value.kind !== 'opening') { client.stop(); return; }
      into.value = { kind: 'open', client };
    },
    (err: unknown) => {
      if (into.value.kind !== 'opening') return;
      const message = err instanceof Error ? err.message || err.name : String(err);
      into.value = { kind: 'failed', message: t('fileViewer.abc.playAlong.error.source', { message }) };
    },
  );
}

// ── The take: what was played, kept on the card (2026-11-01, the user) ──────
// On a line of its own under the follower's: the microphone attachment's own
// recording row (RecorderRow, a little lower), for coherence. On demand:
// Start, Stop, then the save icon — which asks for the name — or Start
// again, which drops the take for a new one: no Discard button (the user's
// call). No listening
// back first, as the microphone's own attachment dialog (recordMicModal.tsx):
// kept, it plays from the card, and the audio sync follows it on the score.
// On the microphone the follower listens to (PlayAlong.recordTake). Leaving
// with a take not kept asks first (settle).

type TakePhase = 'idle' | 'recording' | 'stopping' | 'stopped' | 'keeping';

/** How long "added" shows once a take is kept. */
const KEPT_MS = 4000;

class PlayAlongTake {
  readonly phase = signal<TakePhase>('idle');
  /** A word after Keep: added, or why not. */
  readonly note = signal<{ kind: 'kept' | 'failed' } | null>(null);
  durationMs = 0;
  private recorder: MemoryRecorder | null = null;
  private startedAt = 0;
  private file: Blob | null = null;
  private noteTimer = 0;

  constructor(private readonly keep: (a: Attachment) => void) {}

  start(client: PlayAlong): void {
    this.drop();
    this.recorder = client.recordTake();
    this.startedAt = Date.now();
    this.phase.value = 'recording';
  }

  /** Stops the recording and holds the take. Twice is once. */
  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (this.phase.value !== 'recording' || !recorder) return;
    this.phase.value = 'stopping';
    this.durationMs = Date.now() - this.startedAt;
    await recorder.stop();
    const file = await recorder.file();
    if (this.recorder !== recorder) return;   // dropped meanwhile
    this.recorder = null;
    this.file = file;
    this.phase.value = 'stopped';
  }

  /** Adds the take to the card — stopping it first, then asking its name;
   *  whether it was. */
  async save(): Promise<boolean> {
    await this.stop();
    const file = this.file;
    if (this.phase.value !== 'stopped' || !file) return false;
    this.phase.value = 'keeping';
    const name = await askRecordingName(file, stampedName('fileViewer.abc.playAlong.take.fileName'));
    if (name === null) { this.phase.value = 'stopped'; return false; }
    try {
      this.keep(await recordingAttachment(file, name));
    } catch (err) {
      console.error('[play-along] take', err);
      this.phase.value = 'stopped';
      this.say('failed');
      return false;
    }
    this.file = null;
    this.phase.value = 'idle';
    this.say('kept');
    return true;
  }

  drop(): void {
    void this.recorder?.stop();
    this.recorder = null;
    this.file = null;
    this.phase.value = 'idle';
  }

  /** Whether leaving would lose something. */
  get holds(): boolean {
    const ph = this.phase.value;
    return ph === 'recording' || ph === 'stopping' || ph === 'stopped';
  }

  elapsedMs(): number {
    return this.phase.value === 'recording' ? Date.now() - this.startedAt : this.durationMs;
  }

  /** Leaving with a take in hand asks first, as the microphone's dialog
   *  does; true when it asked — `proceed` then runs once it is answered. */
  settle(proceed: () => void): boolean {
    if (!this.holds) return false;
    askUnsavedChanges({
      message: t('unsaved.message.recording'),
      saveLabel: t('common.add'),
      save: () => this.save(),
      discard: () => this.drop(),
      proceed,
    });
    return true;
  }

  private say(kind: 'kept' | 'failed'): void {
    window.clearTimeout(this.noteTimer);
    this.note.value = { kind };
    this.noteTimer = window.setTimeout(() => { this.note.value = null; }, KEPT_MS);
  }
}

interface PaneProps {
  version: Signal<string>;
  index: Signal<number>;
  /** Every version of the file, as they were when it was turned on. */
  versions: string[];
  /** Whether to offer the version being played (the viewer's option). */
  suggest: boolean;
  onShowVersion: (index: number) => void;
  face: Signal<ScoreFace>;
  expanded: Signal<boolean>;
  source: Signal<Source>;
  /** Null where there is no card to keep a take on: no record button. */
  take: PlayAlongTake | null;
  /** The viewer's transposition, in semitones: the score is drawn and
   *  followed in that key. Only that one (2026-11-07, the user): the follower
   *  never looks for the key itself — one note held would fit a score in any
   *  key somewhere; a player in another key transposes the score. */
  transpose: Signal<number>;
}

function PlayAlongPane({ version, index, versions, suggest, onShowVersion, face, expanded, source, take, transpose }: PaneProps) {
  const shown = version.value;
  const shift = transpose.value;
  const shownIndex = index.value;
  const src = source.value;
  const client = src.kind === 'open' ? src.client : null;
  const dev = devMode.value;
  const [score, setScore] = useState<{ abc: string; meter: string; dance?: string } | null>(null);
  const [clock, setClock] = useState<LiveClock | null>(null);
  const [noNotes, setNoNotes] = useState(false);
  const [status, setStatus] = useState<PlayAlongStatus | null>(null);
  const [offset, setOffset] = useState(playAlongOffset());
  /** The versions followed side by side: each one's index in the file, and
   *  how to tell the watch which is on screen. */
  const [watch, setWatch] = useState<{ slots: number[]; setShown: (slot: number) => void; mute: (slot: number) => void } | null>(null);
  /** The version offered, by its index in the file. */
  const [offer, setOffer] = useState<number | null>(null);
  /** The height of everything under the score — the messages, the offer,
   *  the bar and its take line — in layout pixels (offsetHeight: the space
   *  rem and the score's calc are in, whatever the app's zoom). The score
   *  gives it up: counted as a fixed allowance, the bar's second line (the
   *  take) pushed the pane out of the dialog (2026-11-01, the user). */
  const belowRef = useRef<HTMLDivElement>(null);
  const [belowPx, setBelowPx] = useState(0);
  useLayoutEffect(() => {
    const el = belowRef.current;
    if (!el) return;
    const measure = () => setBelowPx(prev => (prev === el.offsetHeight ? prev : el.offsetHeight));
    // At once, before the first paint; then at the next frame, not in the
    // observer: the score's height follows, a scrollbar may come or go with
    // it, the width and the lines under it with that — inside the observer
    // the browser reports a loop (2026-11-01, the user, resizing the window).
    measure();
    let raf = 0;
    const watch = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    watch.observe(el);
    return () => { watch.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // The version's notes, as drawn, given to the follower — again for another
  // version, or another source.
  useEffect(() => {
    let cancelled = false;
    const abc = bareScore(shown);
    const meter = meterOf(shown);
    // Off the version itself: bareScore takes R: out with T:.
    setScore({ abc, meter, dance: /^R:(.*)$/m.exec(shown)?.[1] });
    setClock(null);
    setNoNotes(false);
    void scoreContour(abc, meter).then((written) => {
      if (cancelled) return;
      if (!written) { setNoNotes(true); return; }
      if (!client) return;
      const pitches = shift === 0 ? written : written.map(p => p + shift);
      client.setScore(pitches);
      setClock({ pitches, position: () => client.position() });
    });
    return () => { cancelled = true; };
  }, [shown, client, shift]);

  // Every version of the file, to tell which one is played: their notes read
  // one after the other (each is engraved out of sight), then followed side
  // by side in a worker of their own. The versions with no notes stay out.
  useEffect(() => {
    if (!client || !suggest || versions.length < 2) return;
    let cancelled = false;
    let handle: ReturnType<PlayAlong['watchVersions']> | null = null;
    void (async () => {
      const slots: number[] = [], scores: number[][] = [];
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i]!;
        if (!/^K:/m.test(v)) continue;
        const pitches = await scoreContour(bareScore(v), meterOf(v));
        if (cancelled) return;
        if (pitches) { slots.push(i); scores.push(shift === 0 ? pitches : pitches.map(p => p + shift)); }
      }
      const at = slots.indexOf(index.peek());
      if (scores.length < 2 || at < 0) return;
      handle = client.watchVersions(scores, at, (slot) => setOffer(slot === null ? null : slots[slot]!));
      const h = handle;
      setWatch({ slots, setShown: (s) => h.setShown(s), mute: (s) => h.mute(s) });
    })();
    return () => {
      cancelled = true;
      handle?.stop();
      setWatch(null);
      setOffer(null);
    };
  }, [client, suggest, versions, shift]);

  // Another version on screen — offered, or chosen from the viewer's arrows.
  useEffect(() => {
    setOffer(null);
    if (!watch) return;
    const at = watch.slots.indexOf(shownIndex);
    if (at >= 0) watch.setShown(at);
  }, [shownIndex, watch]);

  // The tempo and the quality shown, smoothed over a few seconds: read raw
  // every quarter second they flickered (2026-11-01, the user). Held through
  // the moments the follow has no position, started afresh when it begins.
  const smooth = useRef<Smoothed>({ rate: null, match: null, at: 0 });
  useEffect(() => {
    if (!client) { setStatus(null); return; }
    smooth.current = { rate: null, match: null, at: 0 };
    const id = window.setInterval(() => {
      const s = client.status();
      const e = s.estimate;
      const sm = smooth.current;
      const now = performance.now() / 1000;
      if (e?.state !== 'follow') {
        smooth.current = { rate: null, match: null, at: now };
      } else if (e.quaver !== null) {
        const ease = (old: number | null, v: number, tau: number) => (old === null ? v : old + (1 - Math.exp(-(now - sm.at) / tau)) * (v - old));
        if (e.rate > 0) sm.rate = ease(sm.rate, e.rate, SMOOTH_TEMPO_S);
        if (e.match !== null) sm.match = ease(sm.match, e.match, SMOOTH_MATCH_S);
        sm.at = now;
      }
      setStatus(s);
    }, STATUS_MS);
    return () => window.clearInterval(id);
  }, [client]);
  /** The tempo written, moved only by a change of a beat and a half a
   *  minute: rounding alone made it hop between two neighbours. */
  const shownBpm = useRef<number | null>(null);

  // ── The score's own full page (2026-11-01, the user) ──
  // As the viewer and the audio sync have one (ScoreFollowView.tsx): the
  // score, the offer and the bar over everything. The view's container (the
  // viewer's host) is moved into an overlay and back, never the view itself:
  // the microphone and the follow go on as they were. Escape and the back
  // gesture leave it (overlayStack).
  const rootRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(false);
  const pageRef = useRef<{ overlay: HTMLElement; anchor: Comment; host: HTMLElement; hostStyle: string; unregister: () => void } | null>(null);
  const leavePage = (rerender = true) => {
    const p = pageRef.current;
    if (!p) return;
    pageRef.current = null;
    p.unregister();
    p.host.style.cssText = p.hostStyle;
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
    const anchor = document.createComment('play-along');
    // Laid over the viewer in the dialog (fileViewer.ts): in the overlay it
    // is a plain box, its place given back on the way out.
    const hostStyle = host.style.cssText;
    host.style.cssText = '';
    host.replaceWith(anchor);
    overlay.appendChild(host);
    document.body.appendChild(overlay);
    pageRef.current = { overlay, anchor, host, hostStyle, unregister: registerOverlay(() => leavePage()) };
    setPage(true);
  };
  // The view can go while on its full page — the dialog closed from
  // elsewhere — and an overlay nothing points at would stay on screen.
  useEffect(() => () => leavePage(false), []);

  // The score takes what is left — of the overlay on the full page, of the
  // place the viewer's own takes in the dialog (fileViewer.ts lays the
  // Play-along over it): its box as it is, plus the room to spare (or minus
  // what overflows). Measured at the next frame, not in the observer: the
  // height set resizes what is observed (ScoreFollowView's, 2026-10-29).
  const [fit, setFit] = useState<number | null>(null);
  const shownFace = face.value;
  useEffect(() => {
    setFit(null);
    const root = rootRef.current;
    const body = page ? pageRef.current?.overlay ?? null : root?.parentElement ?? null;
    if (!root || !body) return;
    const measure = () => {
      const box = root.querySelector<HTMLElement>(shownFace === 'text' ? '.score-follow-text' : '.score-follow-paper');
      if (!box) return;
      const cs = getComputedStyle(body);
      const space = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const used = Array.from(body.children).reduce((sum, c) => sum + (c as HTMLElement).offsetHeight, 0);
      const next = Math.max(MIN_SCORE_PX, box.clientHeight + space - used);
      setFit(prev => (prev !== null && Math.abs(prev - next) < 2 ? prev : next));
    };
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(body);
    ro.observe(root);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [page, shownFace, score]);

  const nudge = (by: number) => {
    const next = offset + by;
    setPlayAlongOffset(next);
    setOffset(next);
  };
  const dismiss = () => {
    if (offer === null || !watch) return;
    const at = watch.slots.indexOf(offer);
    if (at >= 0) watch.mute(at);
    setOffer(null);
  };

  const e = status?.estimate ?? null;
  const state = src.kind === 'opening' ? 'opening' : e?.state ?? 'search';
  const following = state === 'follow';
  const { rate, match } = smooth.current;
  // The dance's beat (R:), else the tempo field's or the metre's (beatOfDance).
  const beat = score ? beatOfDance(score.dance, score.meter, /^Q:(.*)$/m.exec(score.abc)?.[1]) : null;
  let tempo: { bpm: number; key: (typeof TEMPO_TEXT)[Beat['unit']] } | null = null;
  if (following && rate !== null && beat) {
    const exact = (rate * 60) / beat.quavers;
    if (shownBpm.current === null || Math.abs(exact - shownBpm.current) >= BPM_HYSTERESIS) shownBpm.current = Math.round(exact);
    tempo = { bpm: shownBpm.current, key: TEMPO_TEXT[beat.unit] };
  } else {
    shownBpm.current = null;
  }
  const dot = following && match !== null ? qualityColour(match, LIVE_SCALE) : 'var(--color-text-dim)';
  const takePhase = take?.phase.value ?? 'idle';
  const takeNote = take?.note.value ?? null;
  const chip = 'inline-flex items-center justify-center rounded-full border transition-colors cursor-pointer';
  const idle = `${chip} border-border text-muted hover:text-primary hover:border-accent/50`;
  const offering = offer !== null && offer !== shownIndex;
  // What is under the score takes its room from it (2026-11-01, the user):
  // its height as measured — the offer's words wrap on a narrow screen, the
  // take adds a line — and the gap above it. No loop: that height follows
  // the width alone, and the score gives up exactly what it takes.
  const room = ` - ${belowPx}px - ${BELOW_GAP_REM}rem`;
  // Full page: all the height the overlay has, measured (what is under the
  // score is counted in it); until it is in, a guess. Floor and cap alike
  // there (2026-11-01, the user): the paper fills the page, as the viewer's
  // full page does, however short the tune.
  const maxHeight = fit !== null ? `${fit}px`
    : page ? `calc(100dvh / var(--zoom-factor, 1) - 4.5rem${room})`
    : expanded.value
      ? `calc(100dvh / var(--zoom-factor, 1) - ${AROUND_EXPANDED_REM}rem${room})`
      : `min(60vh, calc(100dvh / var(--zoom-factor, 1) - ${AROUND_REM}rem${room}))`;

  // In the score's corner, as in the viewer and the audio sync: the way in,
  // then the way out — and, as in the viewer, none with the stave and the
  // text together (the user, 2026-11-04).
  const pageLabel = t(page ? 'fileViewer.abc.fullscreenExit' : 'fileViewer.abc.fullscreen');
  const tools = shownFace === 'both' && !page ? undefined : (
    <button
      class="abc-score-tool-small rounded transition-colors cursor-pointer flex items-center justify-center"
      title={pageLabel}
      aria-label={pageLabel}
      onClick={(ev) => { ev.currentTarget.blur(); if (page) leavePage(); else enterPage(); }}
    >
      {page ? <CollapseIcon size={13} /> : <ExpandIcon size={13} />}
    </button>
  );

  return (
    <div ref={rootRef} class={`flex flex-col gap-3${page ? ' p-3' : ''}`}>
      {score && (
        <SyncedScore
          abc={score.abc} meter={score.meter} follow={null} engine={null} region={null}
          transpose={shift} playing={false} maxHeight={maxHeight} minHeight={fit !== null ? maxHeight : undefined} face={face.value} clock={clock ?? undefined} tools={tools}
        />
      )}
      {/* Under the score, measured as one (belowRef). */}
      <div ref={belowRef} class="flex flex-col gap-3">
        {src.kind === 'failed' && src.message && <div class="text-xs text-danger text-center">{src.message}</div>}
        {noNotes && <div class="text-xs text-danger text-center">{t('fileViewer.abc.playAlong.noNotes')}</div>}
        {offering && offer !== null && (
          <div class="flex justify-center">
            <div class="inline-flex items-center gap-2 min-h-9 max-w-full rounded-2xl border border-accent/40 bg-accent/10 pl-3.5 pr-1 py-1 text-xs text-primary">
              <span class="min-w-0">{t('fileViewer.abc.playAlong.suggest', { n: offer + 1 })}</span>
              <button
                type="button"
                class="shrink-0 rounded-full bg-accent text-white px-3 min-h-[1.75rem] font-medium hover:opacity-90 transition-opacity cursor-pointer"
                onClick={() => onShowVersion(offer)}
              >
                {t('fileViewer.abc.playAlong.suggest.show')}
              </button>
              <button
                type="button"
                class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full text-muted hover:text-primary hover:bg-elevated transition-colors cursor-pointer"
                title={t('fileViewer.abc.playAlong.suggest.dismiss')}
                aria-label={t('fileViewer.abc.playAlong.suggest.dismiss')}
                onClick={dismiss}
              >
                <CrossIcon size={12} />
              </button>
            </div>
          </div>
        )}
        {/* One line: the state, cut short when too long, and the latency held
            at the right — its buttons never move under the finger between two
            presses (2026-11-01, the user). Developer mode adds the take's dump
            under it, and nothing else. */}
        <div class="flex flex-col gap-1.5 rounded-xl border border-border bg-bg px-3 py-2 text-xs">
          <div class="flex items-center gap-4">
            <div class="flex flex-1 items-center gap-2 min-w-0 font-medium text-primary">
              <span class="relative inline-flex shrink-0 w-2.5 h-2.5">
                {(state === 'search' || state === 'opening') && (
                  <span class="absolute inset-0 rounded-full animate-ping opacity-60" style={{ background: 'var(--color-accent)' }} />
                )}
                <span class="relative inline-block w-2.5 h-2.5 rounded-full transition-colors duration-700" style={{ background: state === 'search' ? 'var(--color-accent)' : dot }} />
              </span>
              <span class="min-w-0 truncate">
                {state === 'opening' ? t('fileViewer.abc.playAlong.opening') : t(STATE_TEXT[state])}
                {tempo && <span class="ml-2 font-normal text-muted tabular-nums">{t(tempo.key, { bpm: tempo.bpm })}</span>}
              </span>
            </div>
            <span class="shrink-0 inline-flex items-center gap-1.5 text-muted" title={t('fileViewer.abc.playAlong.offsetHint')}>
              {t('fileViewer.abc.playAlong.offset')}
              <button type="button" class={`${idle} w-7 h-7`} aria-label="−" onClick={() => nudge(-OFFSET_STEP_MS)}><MinusIcon size={12} /></button>
              <span class="tabular-nums w-14 text-center text-primary">{offset} ms</span>
              <button type="button" class={`${idle} w-7 h-7`} aria-label="+" onClick={() => nudge(OFFSET_STEP_MS)}><PlusIcon size={12} /></button>
            </span>
          </div>
          {/* The take, on a line of its own (2026-11-01, the user): Record —
              again, a new take in place of the last — or ■ while it records;
              then the take's length and Keep. */}
          {take && client && (
            <div class="flex flex-col gap-1 border-t border-border pt-2">
              <RecorderRow
                compact
                phase={takePhase === 'keeping' ? 'stopped' : takePhase}
                elapsedMs={() => take.elapsedMs()}
                level={() => client.level()}
                onStart={() => take.start(client)}
                onStop={() => void take.stop()}
                after={(takePhase === 'stopped' || takePhase === 'keeping') && (
                  // The save icon, as the card's notes have it (2026-11-01,
                  // the user), not a word.
                  <button
                    type="button"
                    class={`${chip} shrink-0 w-7 h-7 border-accent/60 text-accent bg-accent/10 hover:bg-accent/20 disabled:opacity-50 disabled:cursor-default`}
                    title={t('fileViewer.abc.playAlong.take.nameTitle')}
                    aria-label={t('fileViewer.abc.playAlong.take.nameTitle')}
                    disabled={takePhase !== 'stopped'}
                    onClick={() => void take.save()}
                  >
                    <SaveIcon size={13} />
                  </button>
                )}
              />
              {takePhase === 'idle' && takeNote && (
                <span class={`text-center ${takeNote.kind === 'failed' ? 'text-danger' : 'text-muted'}`}>
                  {t(takeNote.kind === 'failed' ? 'fileViewer.abc.playAlong.take.failed' : 'fileViewer.abc.playAlong.take.kept')}
                </span>
              )}
            </div>
          )}
          {dev && client && (
            <div class="flex justify-end">
              <button
                type="button"
                class="text-[11px] text-dim hover:text-primary hover:underline cursor-pointer"
                onClick={() => void client.dump().then(b => downloadBlob(b, `play-along-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`))}
              >
                {t('fileViewer.abc.playAlong.dump')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Play-along of the file's version `index` in `host`, on the viewer's
 *  face and at its size (fileViewer.ts). Call it from the tap that turns it
 *  on: the microphone is asked for at once. */
export function mountPlayAlong(host: HTMLElement, opts: {
  versions: string[];
  index: number;
  suggest: boolean;
  onShowVersion: (index: number) => void;
  face: ScoreFace;
  expanded: boolean;
  /** Adds a take to the card the score belongs to; absent, no record button. */
  onKeepRecording?: (a: Attachment) => void;
  /** The viewer's transposition (see PaneProps.transpose). */
  transpose: number;
}): PlayAlongView {
  const take = opts.onKeepRecording ? new PlayAlongTake(opts.onKeepRecording) : null;
  const version = signal(opts.versions[opts.index] ?? '');
  const index = signal(opts.index);
  const face = signal(opts.face);
  const expanded = signal(opts.expanded);
  const transpose = signal(opts.transpose);
  const source = signal<Source>({ kind: 'opening' });
  open(source, () => { source.value = { kind: 'failed', message: t('fileViewer.abc.playAlong.error.ended') }; });
  render(
    <PlayAlongPane
      version={version} index={index} versions={opts.versions} suggest={opts.suggest} onShowVersion={opts.onShowVersion}
      face={face} expanded={expanded} source={source} take={take} transpose={transpose}
    />,
    host,
  );
  return {
    setVersion: (v, i) => { version.value = v; index.value = i; },
    setFace: (f) => { face.value = f; },
    setExpanded: (v) => { expanded.value = v; },
    setTranspose: (t) => { transpose.value = t; },
    settleTake: (proceed) => take?.settle(proceed) ?? false,
    unmount: () => {
      take?.drop();
      // Opening still: it stops itself when it lands (`open`).
      const s = source.value;
      source.value = { kind: 'failed', message: '' };
      if (s.kind === 'open') s.client.stop();
      render(null, host);
    },
  };
}
