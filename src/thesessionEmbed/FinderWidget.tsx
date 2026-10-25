import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { tIn, type Lang } from '../services/i18nService';
import { titleCaseTuneName, copyText, downloadTextFile } from '../utils';
import { analysisTextReport } from '../services/analysisExport';
import { TUNESET_NAME_SEPARATOR } from '../services/stateNormalise';
import { DETECTION_TEMPORAL_CONFIG } from '../session/recognition/detectionTemporalConfig';
import { provisionalEnd } from '../session/detectionState';
import { withChains } from '../session/ui/timelineModel';
import { viterbiPickOf, type Analysis, type Detection, type DetectionAlternate } from '../session/model';
import { TuneFinder, canOfferCapture, type FinderStatus, type Run, type SourceKind } from './tuneFinder';

// ── The widget ────────────────────────────────────────────────────────────────
// The analyser's feed, pared down: the tunes in the order they were played,
// one line each — play, when, what, how sure — and behind the confidence badge
// the same alternatives picker, where picking a tune confirms it. Sets only
// when asked for (a box, off by default, as the analyser's option once was);
// no cards, no ratings: nothing here belongs to anyone. Each run exports as
// the analyser's short text setlist.
//
// Above the feed, a strip: the source tabs, the one button, and what is going
// on. A 92 px frame — what The Session gives a widget today — shows the strip
// alone, the latest tune in it; a taller one shows the feed under it
// (embed.css, by the frame's height).
//
// The sources are the analyser's four — microphone, capture, file, link — as
// tabs rather than a menu: a menu opening downwards would be cut off by the
// bottom of a 92 px frame.
//
// What it answers that the forum asked for (thesession.org/discussions/51384):
// a name that does not flip to another tune when the playing stops — the
// decoder closes the detection, it does not re-guess it — every match kept in
// the list, and the other candidates one click away.

export interface WidgetOptions {
  lang: Lang;
  /** `links=same`: tune links open in the embedding page, not a new tab. */
  sameTab: boolean;
  /** `sources=`: the tabs offered, in this order — all four by default. */
  sources: SourceKind[];
  /** `sets=on`: every analysis's sets box ticked from the start. */
  sets: boolean;
}

const CADENCE_URL = 'https://batpapa.github.io/Cadence/';

/** The widget's own strings. */
function tr(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = tIn(lang, `thesessionEmbed.${key}`);
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** The analyser's own, where the widget says the same thing: the confidence
 *  words, the picker's instructions. One wording for one meaning. */
const app = (lang: Lang, key: string) => tIn(lang, key);

function fmtTime(s: number): string {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

/** The setting that matched, not just the tune: the index is per setting. */
function tuneUrl(d: { tuneId: string; settingId: string }): string {
  return `https://thesession.org/tunes/${d.tuneId}#setting${d.settingId}`;
}

/** viterbiSegmenter.ts's bucketOf, for an alternative's mean score: the
 *  segmenter itself is not worth loading into this page for two comparisons. */
function bucketOf(score: number): Detection['bucket'] {
  const cfg = DETECTION_TEMPORAL_CONFIG;
  return score >= cfg.bucketHighConfidence ? 'high' : score >= cfg.bucketMediumConfidence ? 'medium' : 'low';
}

const isLive = (kind: SourceKind) => kind === 'mic' || kind === 'device';

const nameOf = (d: { displayName: string }) => titleCaseTuneName(d.displayName);

/** How far a run reaches: its last detection's end, an open one's last window. */
const runDuration = (run: Run) => run.detections.reduce((m, d) => Math.max(m, provisionalEnd(d)), 0);

const startTime = (run: Run, lang: Lang) =>
  new Date(run.startedAt).toLocaleTimeString(lang === 'fr' ? 'fr-FR' : 'en-IE', { hour: '2-digit', minute: '2-digit' });

/** "Microphone 21:40", or the file's name. */
function runTitle(run: Run, lang: Lang): string {
  return isLive(run.kind) ? `${tr(lang, `source.${run.kind}`)} ${startTime(run, lang)}` : run.label;
}

/** A run as the analyser's export reads it — the same short setlist,
 *  "- Morrison's (jig)", a blank line between sets when they are shown. */
function runReport(run: Run, lang: Lang, sets: boolean): string {
  const analysis: Analysis = {
    id: `run-${run.index}`,
    name: runTitle(run, lang),
    date: new Date(run.startedAt).toISOString(),
    duration: runDuration(run),
    mimeType: '',
    source: run.kind === 'mic' ? 'live' : run.kind === 'device' ? 'device' : 'import',
    annotations: run.detections,
  };
  return analysisTextReport(analysis, { nameOf, setBreaks: sets });
}

type TuneRef = { tuneId: string; settingId: string; displayName: string };

function TuneLink({ d, opts, className }: { d: TuneRef; opts: WidgetOptions; className?: string }) {
  return (
    <a
      class={className}
      href={tuneUrl(d)}
      target={opts.sameTab ? '_top' : '_blank'}
      rel={opts.sameTab ? undefined : 'noopener'}
    >{nameOf(d)}</a>
  );
}

function TuneHeadline({ d, opts }: { d: Detection; opts: WidgetOptions }) {
  return <><TuneLink d={d} opts={opts} className="tune" />{d.dance && <span class="detail">{d.dance}</span>}</>;
}

function Names({ items, opts }: { items: TuneRef[]; opts: WidgetOptions }) {
  return (
    <>
      {items.map((d, i) => (
        <span key={`${d.tuneId}-${i}`}>{i > 0 && ', '}<TuneLink d={d} opts={opts} /></span>
      ))}
    </>
  );
}

/** Errors whose hint is the detail itself — a refusal already in words. */
const DETAIL_IS_HINT = new Set(['link', 'failed']);

function buttonLabel(status: FinderStatus, tab: SourceKind, editingLink: boolean, lang: Lang): string {
  switch (status.kind) {
    case 'opening':
    case 'downloading':
    case 'checking':
    case 'loading':   return tr(lang, 'cancel');
    case 'listening':
    case 'analysing':
    case 'stopping':  return tr(lang, 'stop');
  }
  if (tab === 'file') return tr(lang, 'open');
  if (tab === 'link') return editingLink ? tr(lang, 'analyse') : tr(lang, 'newLink');
  return tr(lang, 'listen');
}

function loadingText(status: Extract<FinderStatus, { kind: 'loading' }>, lang: Lang): string {
  const p = status.progress;
  // Same reason as the analyser for showing no total: the only one on offer is
  // the compressed size, on another scale than the bytes counted here.
  if (p?.phase === 'downloading') return tr(lang, 'downloading', { mb: mb(p.loadedBytes) });
  return tr(lang, 'preparing');
}

// ── The instruments' pitch ──
// The analyser's control (PitchShiftControl.tsx), its sign and its words: the
// value is how the instruments SOUND against the written tune, negative =
// lower, and the engine takes the opposite. Inline, in place of the strip's
// text: a dialog would not fit in a 92 px frame.

const flip = (semitones: number) => -semitones;
const signed = (heard: number) => (heard > 0 ? `+${heard}` : String(heard));

function pitchDescription(lang: Lang, heard: number): string {
  if (heard === 0) return app(lang, 'sessions.pitchShift.asWritten');
  const dir = heard < 0 ? 'lower' : 'higher';
  const n = Math.abs(heard);
  if (n === 1) return app(lang, `sessions.pitchShift.semitone.${dir}`);
  if (n === 2) return app(lang, `sessions.pitchShift.tone.${dir}`);
  return app(lang, `sessions.pitchShift.semitones.${dir}`).replace('{n}', String(n));
}

// ── Playing a detection ──

/** One player for the whole widget, as the analyser's summary has one: a
 *  detection plays from its start to its end, and pressing it again pauses.
 *  The file is the run's sound — for a live run, everything recorded until
 *  then, rebuilt only when it has grown. */
function usePlayer(finder: TuneFinder) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<number, { blob: Blob; url: string }>());
  const endRef = useRef(Infinity);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;
    const onTime = () => { if (audio.currentTime >= endRef.current) audio.pause(); };
    const onStop = () => setPlaying(null);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('pause', onStop);
    audio.addEventListener('ended', onStop);
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      for (const { url } of urls.current.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const toggle = async (run: Run, d: Detection) => {
    const audio = audioRef.current;
    const key = `${run.index}:${d.id}`;
    if (!audio) return;
    if (playing === key) { audio.pause(); return; }
    const sound = finder.sound(run.index);
    if (!sound) return;
    setLoading(key);
    try {
      const blob = await sound;
      let entry = urls.current.get(run.index);
      if (entry?.blob !== blob) {
        if (entry) URL.revokeObjectURL(entry.url);
        entry = { blob, url: URL.createObjectURL(blob) };
        urls.current.set(run.index, entry);
      }
      if (audio.src !== entry.url) {
        audio.src = entry.url;
        await new Promise<void>((resolve, reject) => {
          audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
          audio.addEventListener('error', () => reject(audio.error), { once: true });
        });
      }
      endRef.current = d.end ?? Infinity;
      audio.currentTime = d.start;
      await audio.play();
      setPlaying(key);
    } catch (err) {
      console.warn('[thesession-embed] could not play the detection', err);
      setPlaying(null);
    } finally {
      setLoading(null);
    }
  };

  return { playing, loading, toggle };
}

// ── One line of the feed ──

/** The analyser's picker (AlternatesPopover.tsx), inline: the decoder's pick
 *  first, marked recommended, then the other candidates by mean score. Nothing
 *  is ticked until the user picks; picking the ticked one again hands the
 *  detection back to the decoder. */
function Alternatives({ d, opts, onPick }: { d: Detection; opts: WidgetOptions; onPick: (pick: DetectionAlternate | null) => void }) {
  const { lang } = opts;
  const recommended = viterbiPickOf(d);
  const options = [recommended, ...d.alternates];
  // Never drop what is ticked, should it have left the candidates since.
  if (!options.some(o => o.tuneId === d.tuneId)) {
    options.push({ tuneId: d.tuneId, settingId: d.settingId, displayName: d.displayName, dance: d.dance, meter: d.meter, meanScore: d.meanScore });
  }
  return (
    <div class="alternatives">
      <p class="howto">{app(lang, 'sessions.alternates.howToPick')}</p>
      <ul>
        {options.map(opt => {
          const selected = !!d.userConfirmed && opt.tuneId === d.tuneId;
          return (
            <li key={opt.tuneId} class={`option${selected ? ' selected' : ''}`}>
              <button
                type="button"
                class="pick"
                aria-pressed={selected}
                onClick={() => onPick(selected ? null : opt)}
              >
                <span class="check" aria-hidden="true">{selected ? '✓' : ''}</span>
                <span class="name">{nameOf(opt)}</span>
                {opt.dance && <span class="detail">{opt.dance}</span>}
                {opt.tuneId === recommended.tuneId && (
                  <span class="recommended" title={app(lang, 'sessions.alternates.viterbiHint')}>
                    {app(lang, 'sessions.alternates.viterbiBadge')}
                  </span>
                )}
                <span class={`pct ${bucketOf(opt.meanScore)}`}>{Math.round(opt.meanScore * 100)}%</span>
              </button>
              <a
                class="open"
                href={tuneUrl(opt)}
                target={opts.sameTab ? '_top' : '_blank'}
                rel={opts.sameTab ? undefined : 'noopener'}
                title={tr(lang, 'onTheSession')}
                aria-label={`${nameOf(opt)} — ${tr(lang, 'onTheSession')}`}
              >↗</a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface RowControls {
  opts: WidgetOptions;
  /** Its run is still going — listened to or analysed — so the open
   *  detection is the one being heard. Marked in both cases, as the
   *  analyser's cards mark theirs. */
  live: boolean;
  /** Why the play button is off, or null when it can play. */
  playOff: string | null;
  playing: boolean;
  loading: boolean;
  onPlay: () => void;
  expanded: boolean;
  onToggle: () => void;
  onPick: (pick: DetectionAlternate | null) => void;
  latest: boolean;
}

function DetectionRow({ d, c }: { d: Detection; c: RowControls }) {
  const { lang } = c.opts;
  const open = d.end === null;
  // Closed, but the decoder may still move it: the analyser's hourglass.
  const pending = !open && !d.finalized;
  const word = app(lang, `sessions.confidence.${d.bucket}`);
  const pct = `${Math.round(d.confidence * 100)}%`;
  return (
    <li class={`detection${open && c.live ? ' open' : ''}`} data-latest={c.latest ? '' : undefined}>
      <div class="row">
        <button
          type="button"
          class={`play${c.playing ? ' playing' : ''}`}
          disabled={!!c.playOff}
          title={c.playOff ?? tr(lang, c.playing ? 'pause' : 'play')}
          aria-label={tr(lang, c.playing ? 'pause' : 'play')}
          onClick={c.onPlay}
        >{c.loading ? '…' : c.playing ? '❚❚' : '▶'}</button>
        {/* No times: the order says when, and ▶ plays it — the analyser's
            ranges are for editing bounds, which nobody does here. */}
        <span class="what">
          {/* One place for the line's state, before the name, as on the
              analyser's cards: playing now, or still being settled. */}
          {open && c.live && <span class="dot" aria-hidden="true" />}
          {pending && <span class="pending" title={app(lang, 'sessions.consolidating')}>⧗</span>}
          <TuneLink d={d} opts={c.opts} className="manifest-item-title" />
          {d.dance && <span class="detail">{d.dance}</span>}
        </span>
        <button
          type="button"
          class={`badge ${d.userConfirmed ? 'confirmed' : d.bucket}`}
          aria-expanded={c.expanded}
          title={app(lang, d.userConfirmed ? 'sessions.alternates.confirmed' : 'sessions.alternates.trigger')}
          aria-label={d.userConfirmed ? app(lang, 'sessions.alternates.confirmed') : `${word} ${pct}`}
          onClick={c.onToggle}
        >
          {d.userConfirmed ? '✓' : <><span class="word">{word}</span> {pct}</>}
          <span class="chevron" aria-hidden="true">{c.expanded ? '▴' : '▾'}</span>
        </button>
      </div>
      {c.expanded && <Alternatives d={d} opts={c.opts} onPick={c.onPick} />}
    </li>
  );
}

/** A run's copy and download, as the analyser's export offers both. */
function RunExport({ run, lang, sets }: { run: Run; lang: Lang; sets: boolean }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  if (run.detections.length === 0) return null;
  return (
    <span class="export">
      <button
        type="button"
        class="link"
        onClick={() => {
          // copyText falls back to execCommand: a cross-origin frame is
          // refused the async clipboard unless its iframe allows it.
          void copyText(runReport(run, lang, sets)).then(ok => {
            setCopied(ok ? 'yes' : 'failed');
            setTimeout(() => setCopied('no'), 1500);
          });
        }}
      >{copied === 'no' ? tr(lang, 'copy') : app(lang, copied === 'yes' ? 'common.copied' : 'common.copyFailed')}</button>
      <button
        type="button"
        class="link"
        onClick={() => downloadTextFile(runReport(run, lang, sets), `${runTitle(run, lang).replace(/[^\w-]+/g, '_')}-tunes.txt`, 'text/plain;charset=utf-8')}
      >{tr(lang, 'download')}</button>
    </span>
  );
}

// ── The widget ──

export function FinderWidget({ opts }: { opts: WidgetOptions }) {
  const { lang } = opts;
  const [, setTick] = useState(0);
  const rerender = () => setTick(n => n + 1);
  const finderRef = useRef<TuneFinder | null>(null);
  finderRef.current ??= new TuneFinder(rerender);
  const finder = finderRef.current;
  const meterRef = useRef<HTMLSpanElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  /** The analyses, which scroll together. */
  const runsRef = useRef<HTMLDivElement>(null);
  /** Whether the newest line of the run in progress was in view at the last
   *  look — the feed follows new tunes only then, as the analyser's does:
   *  someone scrolled away to read an earlier one is not dragged back. The
   *  state copy shows the button that brings it back to following. */
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const player = usePlayer(finder);

  const [tabs] = useState(() => opts.sources.filter(k => k !== 'device' || canOfferCapture()));
  const [tab, setTab] = useState<SourceKind>(tabs[0] ?? 'mic');
  /** The tab's own invitation (and the link's field) rather than the last
   *  run's result — true from a tab change until the next run starts. */
  const [fresh, setFresh] = useState(true);
  const [url, setUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  /** The detection whose alternatives are shown, as `${run}:${id}`. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Per analysis, as an analysis is where a set is: the box in its title. */
  /** The pitch control open in the strip. */
  const [pitchOpen, setPitchOpen] = useState(false);
  const [heard, setHeard] = useState(0);
  const [setsShown, setSetsShown] = useState<ReadonlyMap<number, boolean>>(new Map());
  const showsSets = (run: Run) => setsShown.get(run.index) ?? opts.sets;
  /** The runs folded down to their title. A new run folds the ones before it,
   *  so that it has the room; any can be opened again. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());

  const status = finder.status;
  const listening = status.kind === 'listening';
  const busy = finder.running !== null;
  const editingLink = tab === 'link' && fresh && !busy;

  const runs = finder.runs();
  const last = runs[runs.length - 1];
  const activeRun = busy ? last : undefined;
  const latestId = activeRun?.detections[activeRun.detections.length - 1]?.id;

  // The elapsed time, once a second, only while listening.
  useEffect(() => {
    if (!listening) return;
    const id = setInterval(rerender, 1000);
    return () => clearInterval(id);
  }, [listening]);

  // The level meter, written straight to the DOM: a render per frame for one
  // CSS variable would be absurd. Reads the finder through its ref only.
  useEffect(() => {
    if (!listening) return;
    let raf = 0;
    const tick = () => {
      meterRef.current?.style.setProperty('--level', String(finderRef.current?.level() ?? 0));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      meterRef.current?.style.setProperty('--level', '0');
    };
  }, [listening]);

  // Leaving the page: give the microphone back at once rather than whenever
  // the browser gets round to it.
  useEffect(() => {
    const onHide = () => { void finderRef.current?.stop(); };
    addEventListener('pagehide', onHide);
    return () => removeEventListener('pagehide', onHide);
  }, []);

  // The field, ready to paste into once the link tab is chosen. Not scrolled
  // to: the frame is the strip, there is nothing to scroll.
  useEffect(() => {
    if (editingLink) urlRef.current?.focus({ preventScroll: true });
  }, [editingLink]);

  /** Whether the newest line is entirely in view. Measured against .runs,
   *  its offsetParent (embed.css). */
  const latestInView = (): boolean => {
    const box = runsRef.current;
    const el = box?.querySelector<HTMLElement>('[data-latest]');
    if (!box || !el) return true;
    return el.offsetTop >= box.scrollTop - 4
      && el.offsetTop + el.offsetHeight <= box.scrollTop + box.clientHeight + 4;
  };

  const setFollow = (on: boolean) => {
    followingRef.current = on;
    setFollowing(on);
  };

  /** Brings the newest line into view, by the feed's own scroll only:
   *  scrollIntoView would also scroll The Session's page around the frame. */
  const showLatest = () => {
    const box = runsRef.current;
    const el = box?.querySelector<HTMLElement>('[data-latest]');
    if (!box || !el) return;
    const bottom = el.offsetTop + el.offsetHeight;
    if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    else if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
  };

  // A new tune in the run in progress is brought into view — if the one
  // before it was.
  useLayoutEffect(() => {
    if (followingRef.current) showLatest();
  }, [latestId]);

  const onRunsScroll = () => {
    const inView = latestInView();
    if (inView !== followingRef.current) setFollow(inView);
  };

  const followLive = () => {
    setFollow(true);
    showLatest();
  };

  const toggleRun = (index: number) => setCollapsed(prev => {
    const next = new Set(prev);
    if (!next.delete(index)) next.add(index);
    return next;
  });

  const chooseTab = (k: SourceKind) => {
    if (busy) return;
    finder.dismissError();
    setTab(k);
    setFresh(true);
  };

  const startRun = () => {
    setFresh(false);
    setFollow(true);
    // The new run goes on top, open; the ones before fold away under it.
    setCollapsed(new Set(runs.map(r => r.index)));
  };

  const analyseFile = (file: File) => {
    startRun();
    finder.analyseFile(file);
  };

  const submitLink = () => {
    if (!url.trim()) return;
    startRun();
    finder.analyseLink(url);
  };

  const onButton = () => {
    if (busy) { void finder.stop(); return; }
    // Each branch reaches its prompt or picker synchronously: both need the
    // click's own activation.
    if (tab === 'file') { fileRef.current?.click(); return; }
    if (tab === 'link') {
      if (editingLink) submitLink();
      else setFresh(true);
      return;
    }
    startRun();
    finder.startLive(tab);
  };

  // ── The strip: what is going on, and in a 92 px frame the latest answer ──

  /** The latest tune of a run, and the ones before it — which only a frame
   *  too short for the feed shows (`.compact-only`). */
  const latestOf = (run: Run, state: ComponentChildren) => {
    const tunes = run.detections;
    const latest = tunes[tunes.length - 1];
    if (!latest) return null;
    const before: TuneRef[] = [];
    for (let i = tunes.length - 2; i >= 0 && before.length < 3; i--) {
      if (tunes[i]!.tuneId !== latest.tuneId && !before.some(b => b.tuneId === tunes[i]!.tuneId)) before.push(tunes[i]!);
    }
    return {
      headline: <TuneHeadline d={latest} opts={opts} />,
      sub: <>
        {state}
        {before.length > 0 && <span class="compact-only">{state && ' · '}{tr(lang, 'earlier')} <Names items={before} opts={opts} /></span>}
      </>,
    };
  };

  let headline: ComponentChildren;
  let sub: ComponentChildren;

  // A file takes the pitch it starts with: the control waits for the end.
  const pitchLocked = busy && !!activeRun && !isLive(activeRun.kind);
  const stepPitch = (delta: number) => {
    const next = Math.max(-12, Math.min(12, heard + delta));
    if (next === heard) return;
    setHeard(next);
    finder.setPitchShift(flip(next));
  };

  if (pitchOpen && !pitchLocked) {
    headline = (
      <span class="pitch">
        <button type="button" class="step" disabled={heard <= -12} onClick={() => stepPitch(-1)} aria-label="−1">−</button>
        <span class={`value${heard === 0 ? '' : ' set'}`}>{heard === 0 ? '0' : signed(heard)}</span>
        <button type="button" class="step" disabled={heard >= 12} onClick={() => stepPitch(1)} aria-label="+1">+</button>
        <button type="button" class="link done" onClick={() => setPitchOpen(false)}>{tr(lang, 'pitch.done')}</button>
      </span>
    );
    sub = <>{app(lang, 'sessions.pitchShift.question')} <strong>{pitchDescription(lang, heard)}</strong></>;
  } else if (status.kind === 'error') {
    headline = <span class="status">{tr(lang, `error.${status.error}`)}</span>;
    sub = DETAIL_IS_HINT.has(status.error) ? status.detail : tr(lang, `error.${status.error}.hint`, { n: status.detail });
  } else if (status.kind === 'opening') {
    const device = finder.running === 'device';
    headline = <span class="status">{tr(lang, device ? 'opening.device' : 'opening')}</span>;
    sub = tr(lang, device ? 'opening.device.hint' : 'opening.hint');
  } else if (status.kind === 'downloading') {
    headline = <span class="status">{status.total
      ? tr(lang, 'downloadingLinkOf', { mb: mb(status.received), total: mb(status.total) })
      : tr(lang, 'downloadingLink', { mb: mb(status.received) })}</span>;
    sub = last?.label;
  } else if (status.kind === 'checking') {
    headline = <span class="status">{tr(lang, 'checking')}</span>;
    sub = last?.label;
  } else if (status.kind === 'loading') {
    headline = <span class="status">{loadingText(status, lang)}</span>;
    sub = tr(lang, 'loading.hint');
  } else if (activeRun && !isLive(activeRun.kind)) {
    // Analysing a recording, or finishing it.
    const pct = status.kind === 'analysing' && status.totalS > 0 ? Math.min(100, Math.round(status.analyzedS / status.totalS * 100)) : 100;
    const progress = tr(lang, 'analysingProgress', { pct, name: activeRun.label });
    const shown = latestOf(activeRun, progress);
    headline = shown?.headline ?? <span class="status">{tr(lang, 'analysing')}</span>;
    sub = shown?.sub ?? progress;
  } else if (activeRun) {
    // Listening, or stopping.
    const time = fmtTime((Date.now() - finder.listeningSince) / 1000);
    const state = listening ? tr(lang, 'listeningFor', { time }) : tr(lang, 'stopping');
    const shown = latestOf(activeRun, state);
    headline = shown?.headline ?? <span class="status">{tr(lang, listening ? 'listening' : 'stopping')}</span>;
    sub = shown?.sub ?? (listening ? tr(lang, 'listening.hint', { time }) : null);
  } else if (last && !fresh) {
    // A run just over: its answer, until another tab is chosen.
    const n = new Set(last.detections.map(d => d.tuneId)).size;
    if (isLive(last.kind) && n > 0) {
      const shown = latestOf(last, null)!;
      headline = shown.headline;
      sub = <>{tr(lang, 'tunesHeard', { n })}{shown.sub}</>;
    } else {
      headline = <span class="status">{n === 0 ? tr(lang, 'noneFound') : tr(lang, n === 1 ? 'tuneFound' : 'tunesFound', { n })}</span>;
      sub = last.label || null;
    }
  } else if (editingLink) {
    headline = (
      <input
        ref={urlRef}
        class="url"
        type="url"
        inputMode="url"
        enterKeyHint="go"
        placeholder={tr(lang, 'link.placeholder')}
        aria-label={tr(lang, 'link.label')}
        value={url}
        onInput={e => setUrl((e.target as HTMLInputElement).value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitLink(); } }}
      />
    );
    sub = tr(lang, 'link.hint');
  } else {
    headline = <span class="status">{tr(lang, `idle.${tab}`)}</span>;
    sub = tr(lang, `idle.${tab}.hint`);
  }

  const canDrop = tabs.includes('file');

  const rowControls = (run: Run, d: Detection, inProgress: boolean): RowControls => {
    const key = `${run.index}:${d.id}`;
    const playable = finder.canPlay(run.index);
    return {
      opts,
      live: inProgress,
      playOff: playable ? null
        : finder.sound(run.index) ? tr(lang, 'playAfterStop') : tr(lang, 'cantPlay'),
      playing: player.playing === key,
      loading: player.loading === key,
      onPlay: () => { void player.toggle(run, d); },
      expanded: expanded === key,
      onToggle: () => setExpanded(expanded === key ? null : key),
      onPick: pick => finder.confirm(run.index, d.id, pick),
      latest: inProgress && d.id === latestId,
    };
  };

  /** A run's lines — or, with the sets shown, its sets: the analyser's own
   *  grouping (timelineModel's withChains), a silence of GAP_MIN_S or more
   *  between two tunes opening a new one. */
  const runRows = (run: Run, inProgress: boolean) => {
    const row = (d: Detection) => <DetectionRow key={d.id} d={d} c={rowControls(run, d, inProgress)} />;
    if (!showsSets(run)) return run.detections.map(row);
    return withChains(run.detections, runDuration(run)).map(item => {
      if (item.kind === 'gap') return null;
      if (item.kind === 'ann') return row(item.ann);
      const members = item.members.map(m => m.ann);
      return (
        <li key={`set-${members[0]!.id}`} class="set">
          <div class="set-head">
            <span class="set-label">{app(lang, 'sessions.set.label')}</span>
            <span class="set-names">{members.map(nameOf).join(TUNESET_NAME_SEPARATOR)}</span>
          </div>
          <ol>{members.map(row)}</ol>
        </li>
      );
    });
  };

  return (
    <div
      class={`finder${dragOver ? ' drag' : ''}`}
      onDragOver={e => {
        if (!canDrop || busy || !e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={e => {
        setDragOver(false);
        const file = e.dataTransfer?.files[0];
        if (!canDrop || busy || !file) return;
        e.preventDefault();
        setTab('file');
        analyseFile(file);
      }}
    >
      <div class="top">
        {tabs.length > 1 && (
          <div class="sources" role="tablist" aria-label={tr(lang, 'sources')}>
            {tabs.map(k => (
              <button
                key={k}
                type="button"
                role="tab"
                class="source"
                aria-selected={k === tab}
                disabled={busy && k !== tab}
                onClick={() => chooseTab(k)}
              >{tr(lang, `source.${k}`)}</button>
            ))}
          </div>
        )}
        <button
          type="button"
          class={`source pitch-toggle${heard === 0 ? '' : ' set'}`}
          aria-pressed={pitchOpen}
          disabled={pitchLocked}
          title={pitchLocked ? tr(lang, 'pitch.locked') : app(lang, 'sessions.pitchShift.hint')}
          onClick={() => setPitchOpen(!pitchOpen)}
        >{tr(lang, 'pitch')}{heard !== 0 && ` ${signed(heard)}`}</button>
        <a class="credit" href={CADENCE_URL} target="_blank" rel="noopener">{tr(lang, 'credit')}</a>
      </div>
      <div class="strip">
        <span class={`meter${listening ? ' live' : ''}`} ref={meterRef}>
          <button
            type="button"
            class="button"
            onClick={onButton}
            disabled={status.kind === 'stopping' || (editingLink && !url.trim())}
            aria-pressed={listening}
          >{buttonLabel(status, tab, editingLink, lang)}</button>
        </span>
        <div class="text">
          <div class="headline" aria-live="polite">{headline}</div>
          <div class="sub">{sub}</div>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/*"
        hidden
        onChange={e => {
          const input = e.target as HTMLInputElement;
          const file = input.files?.[0];
          input.value = ''; // the same file again is a new analysis
          if (file) analyseFile(file);
        }}
      />
      {runs.length > 0 && (
        <section class="feed" aria-label={tr(lang, 'heard')}>
          {/* Newest first: a new analysis goes on top of those already made. */}
          <div class="runs" ref={runsRef} onScroll={onRunsScroll}>
            {[...runs].reverse().map(run => {
              const inProgress = run === activeRun;
              const open = !collapsed.has(run.index);
              const n = new Set(run.detections.map(d => d.tuneId)).size;
              return (
                <div key={run.index} class={`run${open ? ' expanded' : ''}`}>
                  <h2>
                    <button type="button" class="fold" aria-expanded={open} onClick={() => toggleRun(run.index)}>
                      <span class="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
                      <span class="title">{isLive(run.kind) ? tr(lang, `source.${run.kind}`) : run.label}</span>
                      {isLive(run.kind) && <span class="started">{startTime(run, lang)}</span>}
                      <span class="count">{n}</span>
                    </button>
                    <label class="sets">
                      <input
                        type="checkbox"
                        checked={showsSets(run)}
                        onChange={e => {
                          const on = (e.target as HTMLInputElement).checked;
                          setSetsShown(prev => new Map(prev).set(run.index, on));
                        }}
                      />
                      {tr(lang, 'showSets')}
                    </label>
                    {!inProgress && <RunExport run={run} lang={lang} sets={showsSets(run)} />}
                  </h2>
                  {open && (run.detections.length === 0 && !inProgress
                    ? <p class="none">{tr(lang, 'noneFound')}</p>
                    : (
                      <ol class="run-list">{runRows(run, inProgress)}</ol>
                    ))}
                </div>
              );
            })}
          </div>
          {busy && !following && latestId && (
            <button type="button" class="follow" onClick={followLive}>
              {tr(lang, isLive(activeRun!.kind) ? 'followLive' : 'followAnalysis')}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
