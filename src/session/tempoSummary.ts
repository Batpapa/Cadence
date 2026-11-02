import type { Detection } from './model';
import { beatOfDance, type Beat } from './liveFollow';
import { TEMPO_OPTIONS, tempoInside, insideRate, countedWindows, type NoveltyStore, type TempoEstimate, type TempoReading, type WindowTempo } from './liveTempo';

// ── The live tempo, as the screen tells it ───────────────────────────────────
// The tracker counts quavers (liveTempo.ts); a musician counts beats, and the
// beat is the tune's dance's — known once the tune is recognised. Before that,
// and outside any detection, quavers a minute (the user, 2026-11-01). The
// beat is the Play-along's (beatOfDance), from the detection's dance, else
// its metre: there is no Q: field in a live recording.

export interface TempoValue {
  /** In `unit`s a minute. */
  value: number;
  unit: Beat['unit'];
  quaversPerMinute: number;
}

const QUAVER: Beat = { unit: 'quaver', quavers: 1 };

/** The detection a reading at `t` belongs to: of those under way at `t`, the
 *  latest begun — detections overlap by design (model.ts), and the newer one
 *  is the tune the window mostly heard. */
export function detectionAt(detections: readonly Detection[], t: number): Detection | null {
  let best: Detection | null = null;
  for (const d of detections) {
    if (d.start <= t && (d.end === null || d.end >= t) && (!best || d.start > best.start)) best = d;
  }
  return best;
}

/** A quaver rate (per second) in the beats of `detection`'s dance, or in
 *  quavers without one. */
export function inBeats(rate: number, detection: Detection | null): TempoValue {
  const beat = detection ? beatOfDance(detection.dance, detection.meter) : QUAVER;
  return { value: (rate * 60) / beat.quavers, unit: beat.unit, quaversPerMinute: rate * 60 };
}

/** A point of the curve: a pulse, smoothed, and the stretch it belongs to —
 *  the curve is drawn unbroken along a stretch. */
export interface TempoPoint {
  t: number;
  rate: number;
  run: number;
  /** Of a tune whose tempo is shown with a "~" (InsideTempo's approx, weak). */
  approx?: boolean;
}

/** Pulses further apart than this are not one stretch of music: a silence, a
 *  tune ended. Shorter holes are the agreement rule missing a reading or
 *  two in the middle of a tune (TEMPO_OPTIONS) — drawn across, or the curve
 *  of a tune came out in dashes (2026-11-01, the user, against the mock-up). */
const JOIN_S = 15;
/** The curve: the median of the pulses within this many seconds on either side. */
const SMOOTH_S = 8;

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** The curve of the readings: their pulses, each the median of the pulses
 *  within SMOOTH_S of it in the same stretch. A stretch ends at a hole longer
 *  than JOIN_S, and where the tracker started listening again (a pause, audio
 *  lost): the music after is not the music before. */
export function smoothedTempo(readings: readonly TempoReading[]): TempoPoint[] {
  const pts: TempoPoint[] = [];
  let run = 0, lastT = -Infinity, restarted = false;
  for (const r of readings) {
    if (r.state === 'listening') { restarted = true; continue; }
    if (r.state !== 'pulse') continue;
    if (pts.length && (restarted || r.t - lastT > JOIN_S)) run++;
    restarted = false;
    pts.push({ t: r.t, rate: r.rate, run });
    lastT = r.t;
  }
  return pts.map((p, i) => {
    const near: number[] = [];
    for (let j = i; j >= 0 && pts[j]!.run === p.run && p.t - pts[j]!.t <= SMOOTH_S; j--) near.push(pts[j]!.rate);
    for (let j = i + 1; j < pts.length && pts[j]!.run === p.run && pts[j]!.t - p.t <= SMOOTH_S; j++) near.push(pts[j]!.rate);
    return { ...p, rate: median(near) };
  });
}

/** How long the last tempo stays shown once no reading agrees any more: the
 *  agreement rule misses a reading or two inside a tune, and the value
 *  flickered to "no pulse" and back (2026-11-01, the live test). */
const HOLD_S = 10;

/** The tempo to show now: the curve's last point, while it is no older than
 *  HOLD_S behind the last reading and the tracker has not started listening
 *  again since. Null otherwise. */
export function currentPoint(readings: readonly TempoReading[], curve: readonly TempoPoint[] = smoothedTempo(readings)): TempoPoint | null {
  const p = curve[curve.length - 1];
  const last = readings[readings.length - 1];
  if (!p || !last || last.t - p.t > HOLD_S) return null;
  for (let i = readings.length - 1; i >= 0 && readings[i]!.t > p.t; i--) {
    if (readings[i]!.state === 'listening') return null;
  }
  return p;
}

// ── A detection's own tempo ──────────────────────────────────────────────────
// Read inside its bounds (liveTempo.ts's tempoInside, the user's rule of
// 2026-11-02) in the novelty the engine keeps, never in the readings above:
// those listen 12 s back whatever was played there.

/** A detection's tempo and the windows it was read from. */
export interface InsideTempo {
  /** Quavers a second (insideRate). */
  rate: number;
  /** Read over less than the full window — a tune shorter than it: "~". */
  approx: boolean;
  /** Too few windows with a clear pulse to count them alone: "~" too, on
   *  the live screen (liveTempo.ts's insideRate). */
  weak: boolean;
  /** From its first windows to its last, as a share (0.03: 3 % faster); null
   *  when too few to tell. */
  change: number | null;
  /** The windows, a second apart: the detection's curve. */
  points: WindowTempo[];
}

/** The windows a tune's start and end are each taken over, for `change`. */
const END_WINDOWS = 15;

/** What `points` say of their detection. Null when they say nothing. */
export function summariseInside(points: WindowTempo[]): InsideTempo | null {
  const r = insideRate(points);
  if (!r) return null;
  // The windows the tempo is the median of, but its slips: over all of them,
  // Jerry Daly's "slowed down 31 %" — its first 20 s weak and half again too
  // fast (2026-11-02, the user's live recording).
  const rates = countedWindows(points).map(p => p.rate).filter(rate => Math.abs(rate / r.rate - 1) <= SLIP);
  const change = rates.length >= 2 * END_WINDOWS
    ? median(rates.slice(-END_WINDOWS)) / median(rates.slice(0, END_WINDOWS)) - 1
    : null;
  return { ...r, change, points };
}

/** `d`'s tempo, in the novelty of its analysis. An open detection runs to the
 *  end of what has been heard. `windows`: those already worked out on this
 *  curve (keyed by their frames, so valid for any detection of it). */
export function insideTempo(d: Pick<Detection, 'start' | 'end'>, store: NoveltyStore, windows?: Map<string, TempoEstimate | null>): InsideTempo | null {
  const end = d.end ?? store.length / store.fps;
  return summariseInside(tempoInside(store.view(), store.fps, 0, d.start, end, TEMPO_OPTIONS, windows));
}

/** Each detection's tempo, worked out once per bounds — the feeds ask for it
 *  on every redraw of every card. An open detection is worked out again as it
 *  grows, every few seconds of it. */
export class DetectionTempoCache {
  private readonly entries = new Map<string, { key: string; value: InsideTempo | null }>();
  /** One window cache for the whole curve: a window's frames say what it is. */
  private readonly windows = new Map<string, TempoEstimate | null>();

  get(d: Pick<Detection, 'id' | 'start' | 'end'>, store: NoveltyStore): InsideTempo | null {
    const key = d.end === null ? `${d.start}:open:${Math.floor(store.length / store.fps / OPEN_STEP_S)}` : `${d.start}:${d.end}`;
    const e = this.entries.get(d.id);
    if (e && e.key === key) return e.value;
    const value = insideTempo(d, store, this.windows);
    this.entries.set(d.id, { key, value });
    return value;
  }
}

/** How often an open detection's tempo is worked out again, seconds heard. */
const OPEN_STEP_S = 3;

/** Whether a saved detection's tempo was read over less than the full window
 *  — what InsideTempo.approx said when it was saved, from its bounds. */
export function approxTempo(d: Pick<Detection, 'start' | 'end'>): boolean {
  return d.end !== null && d.end - d.start < TEMPO_OPTIONS.windowSeconds - 0.5;
}

/** A window further than this from its tune's tempo is a slip of the tracker,
 *  half again or twice the tempo. A tune's own tempo moves less: 7 % from its
 *  10th to its 90th percentile at most (2026-11-01, 255 tunes). */
const SLIP = 0.2;

/** The session's curve. Over each detection, its own windows (insideCurve),
 *  where it is the tune (detectionAt); elsewhere the readings, smoothed, but
 *  those whose 12 s hear a detection. A reading listens 12 s back: drawn at
 *  its second, a tune's tempo came out some seconds late, past its end into
 *  the gap after it, the tune before heard in its first seconds, and a line
 *  ran from one tune to the next (2026-11-02, the user's live recording: the
 *  curve beside its tunes' bands, unlike their own curves). Outside the
 *  detections are what is not recognised yet, and what never is. */
export function sessionCurve(readings: readonly TempoReading[], detections: readonly Detection[], tempoOf: (d: Detection) => InsideTempo | null): TempoPoint[] {
  const T = TEMPO_OPTIONS.windowSeconds;
  const hears = (t: number) => detections.some(d => d.start < t && (d.end === null || d.end > t - T));
  // A reading that hears a detection breaks the stretch, as a restart does:
  // the readings on either side of a tune are not one stretch of music.
  const outside = smoothedTempo(readings.map(r => (r.state === 'pulse' && hears(r.t) ? { t: r.t, state: 'listening' as const } : r)));
  const pts = [...outside];
  let run = outside.length ? outside[outside.length - 1]!.run + 1 : 0;
  for (const d of [...detections].sort((a, b) => a.start - b.start)) {
    const it = tempoOf(d);
    if (!it) continue;
    for (const p of insideCurve(it)) if (detectionAt(detections, p.t) === d) pts.push({ ...p, run });
    run++;
  }
  return pts.sort((a, b) => a.t - b.t);
}

/** A detection's curve: its windows, but those a slip from its tempo — the
 *  tracker taking half again or twice the tempo for a few seconds. */
export function insideCurve(it: InsideTempo): TempoPoint[] {
  const approx = it.approx || it.weak;
  return it.points.filter(p => Math.abs(p.rate / it.rate - 1) <= SLIP).map(p => ({ t: p.t, rate: p.rate, run: 0, approx }));
}


/** The detections as they are saved: each with its tempo (Detection.quaverRate)
 *  read inside its bounds — the final ones, put on the passes when they were.
 *  A detection added by hand is left as it is: nothing was listened to for
 *  it. Measured (experiments/tempo/detections.test.ts, 2026-11-02): a tempo on
 *  all 337 detections, within 4 % of the alignment on 94.9 % of 256; on the
 *  245 the readings' median had one for, 95.9 % against its 96.7 %. */
export function withTempo(detections: readonly Detection[], store: NoveltyStore): Detection[] {
  const windows = new Map<string, TempoEstimate | null>();
  return detections.map(d => {
    if (d.manual || d.end === null) return d;
    const it = insideTempo(d, store, windows);
    return it ? { ...d, quaverRate: it.rate } : d;
  });
}
