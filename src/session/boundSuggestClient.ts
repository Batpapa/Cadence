import { followSpan } from './scoreFollowClient';
import { withPickup } from './scoreFollow';
import { passGeometry, suggestionsIn, withinReach, alignmentPlan, type PassMark, type NoSuggestion } from './boundSuggest';
import { getSettingAbcMeta } from './recognition/indexStore';
import { scoreContour, bareScore, meterOf } from '../components/syncedScore';

// ── Bounds from the alignment, computed ──────────────────────────────────────
// Main-thread half of boundSuggest.ts: the detection's stretch, its margins
// on either side, aligned in the score-follow worker on the two scores the
// Synchro audio uses — the drawn ABC of the setting and its index contour,
// the better kept — then the passes read off it. About a second of a
// desktop's CPU per detection (measured 2026-10-31), so it is done when
// asked: the bound editor's opening, a join's button.

export interface BoundSuggestion {
  /** Where the tune's passes begin and end, as aligned — on both sides of a
   *  pause inside it, each numbered on its own. */
  marks: PassMark[];
  /** The rule's bounds, null where it proposes nothing — and why. */
  start: number | null;
  end: number | null;
  why: NoSuggestion;
}

/** What one detection's bounds are as stored, for what decides the result.
 *  `meter`: tells a pickup (withPickup), for numbering the passes. */
interface Span { start: number; end: number | null; settingId: string; meter: string }

/** Answers already worked out in this page, by recording (its size: a
 *  session's audio does not change), setting, bounds and pauses. Nothing is
 *  written anywhere: moved bounds are a new question. */
const known = new Map<string, BoundSuggestion | null>();

/** The drawn score of `settingId` from the cached index's ABC, or an empty
 *  one — the worker then aligns the index contour alone. */
async function drawnScore(settingId: string): Promise<number[]> {
  const meta = await getSettingAbcMeta(settingId).catch(() => null);
  if (!meta?.abc || !/^K:/m.test(meta.abc)) return [];
  return (await scoreContour(bareScore(meta.abc), meterOf(meta.abc)).catch(() => null)) ?? [];
}

/** The bounds `det` would have by the passes of its tune in `audio` (the
 *  whole session's recording, `duration` long — Infinity while it is being
 *  made; `pauses`: Analysis.pauses). Null when nothing could be aligned.
 *  `signal`: stops the worker; the promise then never settles. */
export async function suggestBounds(
  audio: Blob, det: Span, duration: number, signal?: AbortSignal, pauses: readonly number[] = [],
): Promise<BoundSuggestion | null> {
  const end = det.end ?? duration;
  const key = `${audio.size}|${det.settingId}|${det.start.toFixed(3)}|${end.toFixed(3)}|${pauses.join(',')}`;
  if (known.has(key)) return known.get(key)!;
  if (!det.settingId) return null;
  const score = await drawnScore(det.settingId);
  const marks: PassMark[] = [];
  let start: number | null = null, stop: number | null = null;
  const why: NoSuggestion = { start: 'unsure', end: 'unsure' };
  let aligned = false;
  for (const span of alignmentPlan(det.start, end, duration, pauses)) {
    const r = await followSpan(audio, score, det.settingId, span.from, span.to, signal);
    const g = typeof r === 'string' ? null : passGeometry(withPickup(r, det.meter), r.from);
    if (!g) continue;
    aligned = true;
    marks.push(...g.marks);
    const s = suggestionsIn(g, span.lo, span.hi);
    if (span.bounds !== 'end') {
      start = withinReach(s.start, det.start);
      why.start = s.why.start ?? (start === null ? 'far' : null);
    }
    if (span.bounds !== 'start') {
      stop = withinReach(s.end, end);
      why.end = s.why.end ?? (stop === null ? 'far' : null);
    }
  }
  const out = aligned ? { marks, start, end: stop, why } : null;
  known.set(key, out);
  return out;
}

/** A detection to work out, as DetectionTracker.toAlign lists it. */
export interface AlignJob { key: string; start: number; end: number; settingId: string; meter: string }

/** Works out the suggestions of an analysis as it goes — an import, a live
 *  recording (2026-11-01, the user) — one detection at a
 *  time, in the background: the recognition carries on meanwhile, in its own
 *  worker. Measured on an 85 min import (2026-10-31): 15 % more work, about a
 *  second per detection, so it keeps up and the end waits a second or two.
 *  `audio`: the recording as it stands; `duration`: its length — Infinity
 *  while it is being made; `pauses`: where it was paused so far. */
export class BoundAligner {
  private readonly queue: AlignJob[] = [];
  /** Offered once: a key is a question, asked once. */
  private readonly seen = new Set<string>();
  private running = false;
  private stopped = false;
  private readonly stop = new AbortController();
  private waiters: Array<() => void> = [];

  constructor(
    private audio: () => Promise<Blob | undefined>,
    private readonly duration: () => number,
    private readonly pauses: () => readonly number[],
    private readonly onResult: (key: string, suggestion: { start: number | null; end: number | null } | null) => void,
  ) {}

  /** From now on, the recording comes from here — a live one's file, once
   *  stopped: its chunks are gone from the database. */
  setAudio(audio: () => Promise<Blob | undefined>): void {
    this.audio = audio;
  }

  offer(jobs: readonly AlignJob[]): void {
    if (this.stopped) return;
    for (const j of jobs) {
      if (this.seen.has(j.key)) continue;
      this.seen.add(j.key);
      this.queue.push(j);
    }
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0 && !this.stopped) {
      const job = this.queue.shift()!;
      try {
        const blob = await this.audio();
        const s = blob ? await suggestBounds(blob, job, this.duration(), this.stop.signal, this.pauses()) : null;
        if (this.stopped) break;
        this.onResult(job.key, s && { start: s.start, end: s.end });
      } catch {
        // Asked again on the next offer: a live recording's chunks may have
        // gone from under the read, the file taking their place.
        this.seen.delete(job.key);
      }
    }
    this.running = false;
    for (const w of this.waiters.splice(0)) w();
  }

  /** Tunes still to work out, the one in hand included. */
  pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** Resolves once everything offered is worked out, or after `maxMs`,
   *  whichever comes first: the end of an analysis waits for the last ones,
   *  not for ever. */
  drain(maxMs: number): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, maxMs);
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  /** Stops the work in hand and everything after it. */
  dispose(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.stop.abort();
    for (const w of this.waiters.splice(0)) w();
  }
}
