import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { showModal, renderModalBody, MODAL_W } from '../../components/modal';
import { MetronomeIcon, ChevronDownIcon } from '../../components/icons';
import { Sparkline } from '../../trending/ui/sparkline';
import type { LiveSession } from '../liveSession';
import type { Detection } from '../model';
import { tempoUnitText } from './tempoText';
import { TEMPO_OPTIONS, tempoInside, type NoveltyStore, type TempoEstimate, type TempoReading } from '../liveTempo';
import {
  approxTempo, currentPoint, detectionAt, inBeats, insideCurve, sessionCurve, summariseInside,
  type DetectionTempoCache, type TempoPoint,
} from '../tempoSummary';
import { fmtLongTime, tuneName } from './sessionUiShared';
import { beatOfDance, type Beat } from '../liveFollow';

/** The session's curve counts in quavers: tunes of every dance on one axis. */
const QUAVER_BEAT: Beat = { unit: 'quaver', quavers: 1 };

// ── The tempo during a live recording ────────────────────────────────────────
// Shown with the "BPM" switch (analysisView.ts), off by default; worked out
// whatever it says. A line of its own at the very bottom of the live screen (the user's choice,
// 2026-11-01, of the two mock-ups): the tempo now, a curve of the last two
// minutes; pressed, the curve since the start in a modal, with each tune's
// tempo. The readings live in the engine (LiveSession.tempo), in memory only.

/** Readings in the bar's little curve: the last two minutes. */
const SPARK_READINGS = 120;

/** Re-renders on every new reading — about once a second. */
function useTempoReadings(live: LiveSession): readonly TempoReading[] {
  const [, setTick] = useState(0);
  useEffect(() => live.listenTempo(() => setTick(n => n + 1)), [live]);
  return live.tempo;
}

interface Now {
  value: string;
  unit: string;
  /** The tempo itself, not a word about its absence. */
  known: boolean;
  detection: Detection | null;
  quaversPerMinute: number | null;
}

/** The tempo now, in the beat of the tune it falls in: the curve's last point,
 *  held a few seconds (tempoSummary.ts's currentPoint). */
function nowOf(readings: readonly TempoReading[], curve: readonly TempoPoint[], detections: readonly Detection[]): Now {
  const p = currentPoint(readings, curve);
  if (p) {
    const detection = detectionAt(detections, p.t);
    const v = inBeats(p.rate, detection);
    return { value: `${p.approx ? '~' : ''}${Math.round(v.value)}`, unit: tempoUnitText(v.unit), known: true, detection, quaversPerMinute: v.quaversPerMinute };
  }
  const listening = readings.length === 0 || readings[readings.length - 1]!.state === 'listening';
  return listening
    ? { value: '…', unit: t('sessions.tempo.listening'), known: false, detection: null, quaversPerMinute: null }
    : { value: '—', unit: t('sessions.tempo.none'), known: false, detection: null, quaversPerMinute: null };
}

/** The curve's values for a sparkline, a break between stretches. */
function sparkValues(curve: readonly TempoPoint[]): (number | null)[] {
  const out: (number | null)[] = [];
  curve.forEach((p, i) => {
    if (i > 0 && curve[i - 1]!.run !== p.run) out.push(null);
    out.push(p.rate);
  });
  return out;
}

/** The bottom line of the live screen — drawn by the sessions view, after the
 *  page (views/sessions.tsx). Greyed while paused: the value is the last one
 *  heard. */
export function LiveTempoBar({ live }: { live: LiveSession }) {
  const readings = useTempoReadings(live);
  const paused = live.getPhase() === 'paused';
  const recent = readings.slice(-SPARK_READINGS);
  // In a tune, its own curve, as its card and the modal say: the readings'
  // stricter rule said "no pulse" over a tune whose card said 133
  // (2026-11-02, the user).
  const from = recent[0]?.t ?? 0;
  const detections = live.getDetections();
  const near = detections.filter(d => d.end === null || d.end >= from);
  const curve = sessionCurve(recent, near, d => live.tempoCache.get(d, live.novelty)).filter(p => p.t >= from);
  const now = nowOf(recent, curve, detections);
  const spark = sparkValues(curve);
  return (
    <div class="sticky bottom-0 z-10 bg-bg border-t border-border px-6 pt-2 pb-3">
      <button
        class="w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-surface text-left cursor-pointer transition-colors hoverable:border-accent"
        title={t('sessions.tempo.open')}
        onClick={() => showTempoModal(live)}
      >
        <span class="text-accent shrink-0"><MetronomeIcon size={18} /></span>
        <span class="flex flex-col leading-tight min-w-0">
          <span class="text-2xs text-muted">{t('sessions.tempo.title')}</span>
          <span class="flex items-baseline gap-1.5 min-w-0">
            <span class={`font-mono tabular-nums text-xl font-bold ${now.known && !paused ? 'text-primary' : 'text-dim'}`}>{now.value}</span>
            <span class="text-xs text-muted truncate">{now.unit}</span>
          </span>
        </span>
        <span class={`ml-auto shrink-0 ${paused ? 'opacity-40' : ''}`}>
          {spark.length > 1 && <Sparkline values={spark} width={96} height={28} />}
        </span>
        <span class="text-dim shrink-0 -rotate-90"><ChevronDownIcon size={12} /></span>
      </button>
    </div>
  );
}

export function showTempoModal(live: LiveSession): void {
  const { el, cleanup } = renderModalBody(<TempoModalBody live={live} />);
  // No footer: nothing to confirm.
  showModal(t('sessions.tempo.title'), el, [], { maxWidth: MODAL_W.l, onDismiss: cleanup });
}

function TempoModalBody({ live }: { live: LiveSession }) {
  const readings = useTempoReadings(live);
  const detections = live.getDetections();
  const tempoOf = (d: Detection) => live.tempoCache.get(d, live.novelty);
  // Each tune drawn as its own curve: the same as a click on its card.
  const curve = sessionCurve(readings, detections, tempoOf);
  const now = nowOf(readings, curve, detections);
  return (
    <div class="space-y-3">
      <div>
        <div class="flex items-baseline gap-2">
          <span class={`font-mono tabular-nums text-3xl font-bold ${now.known ? 'text-primary' : 'text-dim'}`}>{now.value}</span>
          <span class="text-sm text-muted">{now.unit}</span>
          {now.detection && now.quaversPerMinute !== null && (
            <span class="ml-auto font-mono tabular-nums text-xs text-dim">{t('sessions.tempo.quavers', { n: Math.round(now.quaversPerMinute) })}</span>
          )}
        </div>
        {now.known && (
          <p class="text-xs text-muted mt-0.5 truncate">
            {now.detection
              ? <>{tuneName(now.detection).text} · <span class="capitalize">{now.detection.dance}</span></>
              : t('sessions.tempo.notRecognised')}
          </p>
        )}
      </div>

      {curve.length > 0
        ? <TempoChart readings={readings} curve={curve} current={currentPoint(readings, curve)} detections={detections} recent />
        : <p class="text-sm text-dim">{t('sessions.tempo.empty')}</p>}
      {/* No list of the tunes under it (2026-11-02, the user): each card
          says its tempo, and opens its own curve. */}
      <p class="text-2xs text-dim">{t('sessions.tempo.note')}</p>
    </div>
  );
}

/** Under 2 %, the readings' own spread: steady. */
function changeText(change: number): string {
  const n = Math.round(Math.abs(change) * 100);
  if (Math.abs(change) < 0.02) return t('sessions.tempo.steady');
  return change > 0 ? t('sessions.tempo.faster', { n }) : t('sessions.tempo.slower', { n });
}

// ── The curve ────────────────────────────────────────────────────────────────

const H = 210;
const PAD = { left: 34, right: 8, top: 20, bottom: 22 };
/** Steps of the time axis, seconds: the first giving at most six ticks. */
const TIME_STEPS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
/** Fewer points than this in a stretch are not drawn. */
const MIN_RUN = 3;
/** Steps of the tempo axis, beats a minute: the first giving at most five. */
const RATE_STEPS = [1, 2, 5, 10, 20, 40, 50, 100];
/** The session's curve, unless the whole of it is asked for: the last
 *  minutes at this scale, seconds a pixel — the whole recording on the
 *  modal's width put an hour's tunes a few pixels apart (2026-11-02, the
 *  user). A tune of a minute is 60 px, its name shown over it; some eight
 *  minutes on a phone. */
const RECENT_S_PER_PX = 1;

function TempoChart({ readings, curve, current, detections, span, beat = QUAVER_BEAT, recent = false }: {
  readings: readonly TempoReading[];
  curve: readonly TempoPoint[];
  /** The point shown as "now", marked at the end of the curve. */
  current: TempoPoint | null;
  detections: readonly Detection[];
  /** The stretch of recording drawn, seconds: a detection's. Absent, from the
   *  start to the last reading. */
  span?: { from: number; to: number };
  /** The beat the tempo axis counts in: a detection's dance's (2026-11-02,
   *  the user). Absent, quavers — the one count across tunes of all dances. */
  beat?: Beat;
  /** The last minutes only (RECENT_S_PER_PX), the whole on demand: the
   *  session's curve. */
  recent?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  // The box's width is the modal's, CSS-driven, and the drawing never makes
  // it wider: measuring it cannot feed back on itself.
  const [w, setW] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setW(Math.max(200, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = w - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const end = span ? Math.max(span.to, span.from + 10) : Math.max(60, readings[readings.length - 1]?.t ?? 0);
  /** The recording runs longer than the last minutes shown. */
  const longer = recent && end > plotW * RECENT_S_PER_PX;
  const begin = span?.from ?? (longer && !all ? end - plotW * RECENT_S_PER_PX : 0);
  // A stretch of one or two points is drawn as nothing: a dot floating before
  // Shamrock Hill's curve said nothing but "something was heard" (2026-11-02).
  const runSize = new Map<number, number>();
  for (const p of curve) runSize.set(p.run, (runSize.get(p.run) ?? 0) + 1);
  const pulses = curve.filter(p => p.t >= begin && p.t <= end && runSize.get(p.run)! >= MIN_RUN);
  /** A rate, quavers a second, on the axis: beats a minute. */
  const perMin = (rate: number) => (rate * 60) / beat.quavers;
  const values = pulses.map(p => perMin(p.rate));
  // Nothing heard in the last minutes: an axis around the usual tempi.
  const lo0 = values.length ? Math.min(...values) : 360 / beat.quavers, hi0 = values.length ? Math.max(...values) : lo0;
  // At least 40 quavers a minute tall, and 10 of room on either side.
  const range = Math.max(40 / beat.quavers, hi0 - lo0);
  const rateStep = RATE_STEPS.find(s => range / s <= 4) ?? 100;
  const lo = Math.floor((lo0 - 10 / beat.quavers) / rateStep) * rateStep;
  const hi = Math.ceil((hi0 + 10 / beat.quavers) / rateStep) * rateStep;
  const timeStep = TIME_STEPS.find(s => (end - begin) / s <= 6) ?? 3600;

  const xs = (s: number) => PAD.left + ((s - begin) / (end - begin)) * plotW;
  const ys = (q: number) => PAD.top + plotH - ((q - lo) / (hi - lo)) * plotH;

  // Unbroken along a stretch (tempoSummary.ts's smoothedTempo).
  let line = '';
  pulses.forEach((p, i) => {
    const join = i > 0 && pulses[i - 1]!.run === p.run;
    line += `${join ? 'L' : 'M'}${xs(p.t).toFixed(1)} ${ys(perMin(p.rate)).toFixed(1)} `;
  });
  const rateTicks: number[] = [];
  for (let q = lo; q <= hi; q += rateStep) rateTicks.push(q);
  const timeTicks: number[] = [];
  for (let s = Math.ceil(begin / timeStep) * timeStep; s <= end; s += timeStep) timeTicks.push(s);
  // Shaded by the detection's place in the whole recording, not among those
  // shown: a tune sliding out of the last minutes swapped every shade.
  const bands = [...detections].sort((a, b) => a.start - b.start).map((d, i) => {
    const x0 = xs(Math.max(begin, d.start)), x1 = xs(Math.min(end, d.end ?? end));
    return { d, x0, width: Math.max(0, x1 - x0 - 2), odd: i % 2 === 1 };
  }).filter(b => b.d.start < end && (b.d.end ?? end) > begin);

  const nearest = (clientX: number) => {
    const el = boxRef.current;
    const box = el?.getBoundingClientRect();
    if (!el || !box || !pulses.length) return null;
    // The pointer is in the screen's pixels, the drawing in the layout's: the
    // app's zoom (html's CSS zoom) sets them apart — at 125 %, the point
    // shown was a quarter off what the pointer was on (2026-11-02, the user).
    const scale = el.offsetWidth ? box.width / el.offsetWidth : 1;
    const s = begin + (((clientX - box.left) / scale - PAD.left) / plotW) * (end - begin);
    let best = 0;
    for (let i = 1; i < pulses.length; i++) if (Math.abs(pulses[i]!.t - s) < Math.abs(pulses[best]!.t - s)) best = i;
    // Nothing to point at in a break of the curve.
    return Math.abs(pulses[best]!.t - s) <= (5 / plotW) * (end - begin) + 3 ? best : null;
  };
  const h = hover !== null ? pulses[hover] : undefined;
  const hDet = h ? detectionAt(detections, h.t) : null;
  const hVal = h ? inBeats(h.rate, hDet) : null;
  const hx = h ? xs(h.t) : 0;

  return (
    <div>
      <div
        ref={boxRef}
        class="relative w-full select-none touch-pan-y"
        style={{ height: `${H}px` }}
        onPointerMove={(e) => setHover(nearest(e.clientX))}
        onPointerDown={(e) => setHover(nearest(e.clientX))}
        onPointerLeave={() => setHover(null)}
      >
        {bands.map(b => (
          <div key={b.d.id}>
            <div
              class={`absolute rounded-sm ${b.odd ? 'bg-accent/[0.14]' : 'bg-accent/[0.07]'}`}
              style={{ left: `${b.x0 + 1}px`, width: `${b.width}px`, top: `${PAD.top}px`, height: `${plotH}px` }}
            />
            {b.width >= 28 && (
              <div class="absolute text-2xs text-muted truncate text-center" style={{ left: `${b.x0 + 1}px`, width: `${b.width}px`, top: '2px' }}>
                {tuneName(b.d).text}
              </div>
            )}
          </div>
        ))}
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} class="absolute inset-0 block" role="img" aria-label={t('sessions.tempo.chart')}>
          {rateTicks.map(q => (
            <path key={q} d={`M${PAD.left} ${ys(q).toFixed(1)} H${w - PAD.right}`} stroke="var(--color-border)" stroke-width="1" />
          ))}
          <path d={line} fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          {/* Now, at the end of the curve — the mock-up's dot. */}
          {current && !h && <circle cx={xs(current.t)} cy={ys(perMin(current.rate))} r="4.5" fill="var(--color-accent)" stroke="var(--color-surface)" stroke-width="2" />}
          {h && <path d={`M${hx.toFixed(1)} ${PAD.top} V${PAD.top + plotH}`} stroke="var(--color-dim)" stroke-width="1" stroke-dasharray="2 3" />}
          {h && <circle cx={hx} cy={ys(perMin(h.rate))} r="4.5" fill="var(--color-accent)" stroke="var(--color-surface)" stroke-width="2" />}
        </svg>
        {rateTicks.map(q => (
          <div key={q} class="absolute text-2xs font-mono tabular-nums text-dim text-right" style={{ left: '0', width: `${PAD.left - 6}px`, top: `${ys(q) - 7}px` }}>{q}</div>
        ))}
        {timeTicks.map(s => (
          <div key={s} class="absolute text-2xs font-mono tabular-nums text-dim text-center" style={{ left: `${xs(s) - 20}px`, width: '40px', top: `${PAD.top + plotH + 5}px` }}>{fmtLongTime(s)}</div>
        ))}
        {h && hVal && (
          <div
            class="absolute pointer-events-none rounded-md border border-border bg-elevated px-2 py-1.5 text-2xs leading-snug whitespace-nowrap shadow-lg"
            style={{ top: `${PAD.top + 8}px`, ...(hx > w / 2 ? { right: `${w - hx + 8}px` } : { left: `${hx + 8}px` }) }}
          >
            <div class="font-mono text-dim">{fmtLongTime(h.t)}{hDet ? ` · ${tuneName(hDet).text}` : ''}</div>
            <div><span class="font-mono tabular-nums font-bold text-primary">{Math.round(hVal.value)}</span> <span class="text-muted">{tempoUnitText(hVal.unit)}</span></div>
            {hDet && <div class="text-dim">{t('sessions.tempo.quavers', { n: Math.round(hVal.quaversPerMinute) })}</div>}
          </div>
        )}
      </div>
      <div class="flex items-baseline gap-3 text-2xs text-dim mt-0.5">
        <span>{beat === QUAVER_BEAT ? t('sessions.tempo.axis') : tempoUnitText(beat.unit)}</span>
        {longer && (
          <button class="text-xs text-muted hover:text-accent transition-colors cursor-pointer min-h-8" onClick={() => { setAll(a => !a); setHover(null); }}>
            {t(all ? 'sessions.tempo.showRecent' : 'sessions.tempo.showAll')}
          </button>
        )}
        <span class="ml-auto">{t('sessions.tempo.timeAxis')}</span>
      </div>
    </div>
  );
}

// ── One detection's curve ────────────────────────────────────────────────────
// A click on a card's tempo (2026-11-01, the user): the curve over that tune
// alone, read inside its bounds (tempoSummary.ts's insideTempo, the user's
// rule of 2026-11-02) — its first seconds share the window [start, start +
// 12 s], and never hear the tune before. On a feed still being analysed, from
// the engine's novelty; on a saved analysis, worked out from the recording on
// this device, the curve growing as it comes (the novelty is not saved, only
// each tune's tempo, Detection.quaverRate).

/** Where a detection's novelty comes from. */
export type DetectionTempoSource =
  /** The engine's, looked at again every second: the feed goes on. */
  | { novelty: () => NoveltyStore; cache: DetectionTempoCache }
  /** Worked out from the recording, when asked. */
  | { audio: () => Promise<Blob | undefined> };

export function showDetectionTempo(ann: Detection, source: DetectionTempoSource): void {
  const { el, cleanup } = renderModalBody(<DetectionTempoBody ann={ann} source={source} />);
  showModal(t('sessions.tempo.title'), el, [], { maxWidth: MODAL_W.l, onDismiss: cleanup });
}

/** The curve redrawn at most this often while it is worked out, ms. */
const GROW_EVERY_MS = 150;

function DetectionTempoBody({ ann, source }: { ann: Detection; source: DetectionTempoSource }) {
  const [state, setState] = useState<'computing' | 'noAudio' | 'failed' | null>('novelty' in source ? null : 'computing');
  const [ratio, setRatio] = useState(0);
  const [, setTick] = useState(0);
  /** The recording's novelty over the detection, frame 0 at its start, as it
   *  comes — and the windows already worked out on it. */
  const computed = useRef<NoveltyStore | null>(null);
  const windows = useRef(new Map<string, TempoEstimate | null>());
  useEffect(() => {
    if ('novelty' in source) {
      const id = setInterval(() => setTick(n => n + 1), 1000);
      return () => clearInterval(id);
    }
    const abort = new AbortController();
    let last = 0;
    void (async () => {
      const blob = await source.audio().catch(() => undefined);
      if (abort.signal.aborted) return;
      if (!blob) { setState('noAudio'); return; }
      const { tempoOfSpan } = await import('../scoreFollowClient');
      const r = await tempoOfSpan(blob, ann.start, ann.end ?? ann.start, (store) => {
        computed.current = store;
        const now = performance.now();
        if (now - last >= GROW_EVERY_MS) { last = now; setTick(n => n + 1); }
      }, setRatio, abort.signal).catch(() => 'failed' as const);
      if (abort.signal.aborted) return;
      if (typeof r === 'string') { setState(r === 'no_audio' ? 'noAudio' : 'failed'); return; }
      computed.current = r;
      setState(null);
    })();
    return () => abort.abort();
  }, []);

  const end = ann.end ?? ('novelty' in source ? source.novelty().length / source.novelty().fps : ann.start);
  const store = 'novelty' in source ? null : computed.current;
  const it = 'novelty' in source
    ? source.cache.get(ann, source.novelty())
    : store ? summariseInside(tempoInside(store.view(), store.fps, ann.start, ann.start, end, TEMPO_OPTIONS, windows.current)) : null;
  const curve = it ? insideCurve(it) : [];
  // The value the card shows, when it was saved: worked out again here at
  // the recording's own rate, it may say one more or less.
  const rate = ann.quaverRate ?? it?.rate ?? null;
  const approx = ann.end !== null ? approxTempo(ann) : it?.approx ?? false;
  const value = rate !== null ? inBeats(rate, ann) : null;
  return (
    <div class="space-y-3">
      <div>
        <div class="flex items-baseline gap-2">
          <span class={`font-mono tabular-nums text-3xl font-bold ${value ? 'text-primary' : 'text-dim'}`}>{value ? `${approx ? '~' : ''}${Math.round(value.value)}` : '—'}</span>
          {value && <span class="text-sm text-muted">{tempoUnitText(value.unit)}</span>}
          {value && <span class="ml-auto font-mono tabular-nums text-xs text-dim">{t('sessions.tempo.quavers', { n: Math.round(value.quaversPerMinute) })}</span>}
        </div>
        <p class="text-xs text-muted mt-0.5 truncate">
          {tuneName(ann).text} · <span class="capitalize">{ann.dance}</span>
          {' · '}{fmtLongTime(ann.start)} – {ann.end === null ? t('sessions.tempo.ongoing') : fmtLongTime(ann.end)}
          {it?.change != null && state === null && <> · {changeText(it.change)}</>}
        </p>
      </div>
      {state === 'computing' && <p class="text-sm text-dim">{t('sessions.tempo.computing', { n: Math.round(ratio * 100) })}</p>}
      {state === 'noAudio' && <p class="text-sm text-dim">{t('sessions.tempo.noAudio')}</p>}
      {state === 'failed' && <p class="text-sm text-dim">{t('sessions.tempo.failed')}</p>}
      {/* Drawn as soon as there is a point: the curve grows to the right. */}
      {curve.length > 0
        ? <TempoChart readings={[]} curve={curve} current={null} detections={[ann]} span={{ from: ann.start, to: end }} beat={beatOfDance(ann.dance, ann.meter)} />
        : state === null && <p class="text-sm text-dim">{t('sessions.tempo.empty')}</p>}
      <p class="text-2xs text-dim">{t('sessions.tempo.note')}</p>
    </div>
  );
}
