import type { Detection, DetectionAlternate, DetectionEvent } from './model';
import { withManualAlternate } from './model';

// ── The detection list both engines keep ─────────────────────────────────────
// LiveSession and ImportSession held byte-identical copies of this until
// 2026-09-20. They are the same thing — a live recording and a file import run
// through the very same recogniser, one faster than real time — and the rules
// below are the delicate part: which of the user's decisions survive an update
// from the decoder, and which of the decoder's updates the user's decisions
// override.
//
// Pure, and in its own file, for the reason timelineModel.ts gives: it deserves
// tests, and importing either engine to get at it would drag in the worklet,
// the worker and the database.
//
// ── Confirmations live apart from the decoder (2026-10-10) ───────────────────
// A detection can be confirmed — or rated, which confirms it — while it is
// still playing (group feedback: "quitte à se tromper c'est notre problème").
// The decoder knows nothing of it and keeps revising as before: it may hand
// the same stretch to another tune (retracting the detection and opening a new
// one under a new id), merge it with a neighbour, or drop it to silence.
//
// So a confirmation is not a flag on one of the decoder's detections but a
// record of its own: "THIS RANGE is tune X" (user's wording). The range is the
// one on screen when it was given, and it stays fixed — the user vouched for a
// stretch, not for whatever the decoder later calls that stretch. After every
// batch of decoder events the list is rebuilt: each confirmation takes the
// decoder's detection that overlaps its range the most, and that detection is
// shown under the CONFIRMATION's id with the user's tune. Timing, confidence and
// finalization stay the decoder's — it is still the decoder's job to say where
// the playing starts and ends.
//
// What follows from that, all decided by the user on 2026-10-10:
//  • nothing confirmed is ever retracted — a retraction moves the confirmation
//    onto whatever now covers its range, and a merge carries it, the merged
//    detection becoming confirmed;
//  • two confirmations landing on one detection: the LATEST is the truth, the
//    other is not shown (and settled at the end — see `dominated`);
//  • a range nothing covers any more still shows, as last seen: someone said a
//    tune was played there.
//
// The id staying the confirmation's is what keeps a rating attached: a rating
// is filed under its detection's id (reviewLink.ts), and the decoder's id for a
// stretch can change under it at any time.

/** The user's verdict on a stretch of the recording. Persisted with a live
 *  recording's draft, so a crash recovery can apply it again to the replayed
 *  detections (recovery.ts). */
export interface DetectionConfirmation {
  /** The detection it was given on — and the id the confirmed detection keeps,
   *  whichever of the decoder's detections it currently stands on. */
  id: string;
  /** The range it vouches for, in seconds since the start: what was on screen
   *  when it was given. Fixed. */
  start: number;
  end: number;
  /** Order given — on one detection, the latest wins. */
  seq: number;
  /** The tune. */
  pick: DetectionAlternate;
  /** The user's own marks, which belong to the confirmed detection rather than
   *  to whichever decoder detection it rests on. */
  liked: boolean;
  manualAlternates?: DetectionAlternate[];
  /** The detection as last shown — what stays on screen should the decoder
   *  abandon the whole range. */
  last: Detection;
}

/** Where a detection ends as far as is known: its end once closed, else the end
 *  of the last window that heard it. An open detection has no end yet, and a
 *  rating or a confirmation given on it still needs one. */
export function provisionalEnd(d: Detection): number {
  if (d.end !== null) return d.end;
  const last = d.evidence[d.evidence.length - 1];
  return Math.max(d.start, last ? (last.tEnd ?? last.t) : d.start);
}

/** Overlap in seconds. A confirmation given the instant a detection opened
 *  can have a range of nearly nothing; it still names a moment, so its range is
 *  widened to a sliver rather than overlapping nothing at all. */
function overlap(c: { start: number; end: number }, d: Detection): number {
  const cEnd = Math.max(c.end, c.start + 1e-3);
  return Math.max(0, Math.min(cEnd, provisionalEnd(d)) - Math.max(c.start, d.start));
}

function confirmedView(base: Detection, c: DetectionConfirmation): Detection {
  return {
    ...base,
    id: c.id,
    tuneId: c.pick.tuneId,
    settingId: c.pick.settingId,
    displayName: c.pick.displayName,
    dance: c.pick.dance,
    meter: c.pick.meter,
    userConfirmed: true,
    liked: c.liked,
    manualAlternates: c.manualAlternates,
  };
}

/** The identity a detection currently shows, as a pick — what rating it
 *  confirms. Scored like the decoder's pick when it is that one. */
export function currentPick(d: Detection): DetectionAlternate {
  const vp = d.viterbiPick;
  return {
    tuneId: d.tuneId, settingId: d.settingId, displayName: d.displayName,
    dance: d.dance, meter: d.meter,
    meanScore: vp && vp.tuneId === d.tuneId ? vp.meanScore : d.meanScore,
  };
}

export interface Resolution {
  /** What is shown, sorted by start. */
  detections: Detection[];
  /** Confirmation id → the decoder detection it stands on. */
  claims: Map<string, string>;
  /** Shown id → the decoder detection behind it (absent for a confirmation
   *  standing on nothing). */
  rawIdOf: Map<string, string>;
  /** Confirmation id → the one that took its detection from it. */
  dominatedBy: Map<string, string>;
}

/** The list to show: the decoder's detections with the user's confirmations
 *  laid over them. See this file's header for the rules.
 *
 *  `final` once no more windows will arrive: a confirmation standing on
 *  nothing is then as settled as it will ever be. */
export function resolveDetections(
  raw: readonly Detection[],
  confirmations: readonly DetectionConfirmation[],
  final: boolean,
): Resolution {
  const sortedRaw = [...raw].sort((a, b) => a.start - b.start);

  // Each confirmation's best detection: the largest overlap with its range,
  // and on a tie the one it was given on.
  const best = new Map<string, Detection>();
  for (const c of confirmations) {
    let pick: Detection | undefined;
    let pickOverlap = 0;
    for (const d of sortedRaw) {
      // Sorted by start: past the range's end, nothing can overlap it.
      if (d.start >= Math.max(c.end, c.start + 1e-3)) break;
      const o = overlap(c, d);
      if (o > pickOverlap || (o > 0 && o === pickOverlap && d.id === c.id)) {
        pick = d;
        pickOverlap = o;
      }
    }
    if (pick) best.set(c.id, pick);
  }

  // One confirmation per detection: the latest.
  const winnerOf = new Map<string, DetectionConfirmation>();
  for (const c of confirmations) {
    const d = best.get(c.id);
    if (!d) continue;
    const held = winnerOf.get(d.id);
    if (!held || c.seq > held.seq) winnerOf.set(d.id, c);
  }
  const claims = new Map<string, string>();
  for (const [rawId, c] of winnerOf) claims.set(c.id, rawId);
  const dominatedBy = new Map<string, string>();
  for (const c of confirmations) {
    const d = best.get(c.id);
    if (d && claims.get(c.id) !== d.id) dominatedBy.set(c.id, winnerOf.get(d.id)!.id);
  }

  // A decoder detection nobody claims keeps its own id — unless a confirmation
  // already shows under it (the decoder's id for that stretch outlived the
  // confirmation's move to another): then it takes a derived one, stable from
  // one rebuild to the next, so two cards never share an id.
  const reserved = new Set(confirmations.map(c => c.id));
  const rawIdOf = new Map<string, string>();
  const detections: Detection[] = [];
  for (const d of sortedRaw) {
    const c = winnerOf.get(d.id);
    if (c) {
      detections.push(confirmedView(d, c));
      rawIdOf.set(c.id, d.id);
      continue;
    }
    let id = d.id;
    while (reserved.has(id)) id += '+';
    detections.push(id === d.id ? d : { ...d, id });
    rawIdOf.set(id, d.id);
  }
  for (const c of confirmations) {
    if (best.has(c.id)) continue;
    detections.push({
      ...confirmedView(c.last, c),
      end: provisionalEnd(c.last),
      finalized: final || c.last.finalized,
    });
  }
  detections.sort((a, b) => a.start - b.start);
  return { detections, claims, rawIdOf, dominatedBy };
}

/** The decoder's detections, the user's confirmations, and the list they make
 *  together — one per engine. */
export class DetectionTracker {
  private readonly raw = new Map<string, Detection>();
  private readonly confirmations = new Map<string, DetectionConfirmation>();
  private seq = 0;
  private final = false;
  private resolution: Resolution = { detections: [], claims: new Map(), rawIdOf: new Map(), dominatedBy: new Map() };
  /** The end each shown detection had when last reported settled. */
  private readonly settledEnds = new Map<string, number>();

  /** Folds a batch of decoder events in. The decoder's own detections carry
   *  the like marker and hand-named variants of an unconfirmed detection
   *  forward — the aggregator has never heard of either. */
  apply(events: readonly DetectionEvent[]): void {
    // Most windows change nothing — and a 5-hour import feeds thousands of them.
    if (events.length === 0 && !this.final) return;
    for (const ev of events) {
      if (ev.type === 'retract') { this.raw.delete(ev.id); continue; }
      const existing = this.raw.get(ev.detection.id);
      this.raw.set(ev.detection.id, {
        ...ev.detection,
        liked: existing?.liked ?? false,
        manualAlternates: existing?.manualAlternates,
      });
    }
    this.refresh();
  }

  /** The decoder's last events: nothing will move after these. */
  finish(events: readonly DetectionEvent[]): void {
    this.final = true;
    this.apply(events);
  }

  list(): Detection[] {
    return [...this.resolution.detections];
  }

  get(id: string): Detection | undefined {
    return this.resolution.detections.find(d => d.id === id);
  }

  /** Records the user's verdict on a shown detection: any tune confirms it —
   *  the decoder's own pick included — and `null` hands it back to the decoder.
   *  A new verdict on a confirmed detection is the latest word, and keeps the
   *  range first vouched for. */
  confirm(id: string, pick: DetectionAlternate | null): void {
    const shown = this.get(id);
    if (!shown) return;
    const c = this.confirmations.get(id);
    if (pick === null) {
      if (!c) return;
      this.confirmations.delete(id);
      // The marks go back to the detection it stood on, which shows again
      // under its own id.
      const rawId = this.resolution.claims.get(id);
      const r = rawId ? this.raw.get(rawId) : undefined;
      if (r) this.raw.set(r.id, { ...r, liked: c.liked, manualAlternates: c.manualAlternates });
    } else if (c) {
      c.pick = { ...pick };
      c.seq = ++this.seq;
    } else {
      this.confirmations.set(id, {
        id,
        start: shown.start,
        end: provisionalEnd(shown),
        seq: ++this.seq,
        pick: { ...pick },
        liked: shown.liked,
        manualAlternates: shown.manualAlternates,
        last: shown,
      });
    }
    this.refresh();
  }

  toggleLike(id: string): void {
    this.mark(id, d => ({ liked: !d.liked }));
  }

  /** See model.ts's withManualAlternate. */
  addManualAlternate(id: string, tune: DetectionAlternate): void {
    this.mark(id, d => ({ manualAlternates: withManualAlternate(d, tune) }));
  }

  /** See model.ts's manualAlternateRemovalFields: removing the very tune the
   *  detection is confirmed as also hands it back to the decoder. */
  removeManualAlternate(id: string, tuneId: string): void {
    const shown = this.get(id);
    if (!shown) return;
    const left = (shown.manualAlternates ?? []).filter(o => o.tuneId !== tuneId);
    this.mark(id, () => ({ manualAlternates: left.length > 0 ? left : undefined }));
    if (shown.userConfirmed && shown.tuneId === tuneId) this.confirm(id, null);
  }

  /** The confirmations, for a draft. */
  snapshot(): DetectionConfirmation[] {
    return [...this.confirmations.values()].map(c => ({ ...c }));
  }

  /** Puts a draft's confirmations back, before replaying its windows. */
  restore(confirmations: readonly DetectionConfirmation[]): void {
    for (const c of confirmations) {
      this.confirmations.set(c.id, { ...c });
      this.seq = Math.max(this.seq, c.seq);
    }
    this.refresh();
  }

  /** Confirmations another, later one has taken the detection from, each with
   *  the detection that took it — not shown, and what the end of a recording
   *  settles (the rating of one, if any). */
  dominated(): Array<{ loser: Detection; winner: Detection }> {
    const out: Array<{ loser: Detection; winner: Detection }> = [];
    for (const [loserId, winnerId] of this.resolution.dominatedBy) {
      const c = this.confirmations.get(loserId);
      const winner = this.get(winnerId);
      if (!c || !winner) continue;
      out.push({ loser: { ...confirmedView(c.last, c), end: provisionalEnd(c.last) }, winner });
    }
    return out;
  }

  /** Shown detections finalized since the last call, or finalized ones whose
   *  end has moved since — where a rating given while it played gets its
   *  definitive instant. */
  takeSettled(): Detection[] {
    const out: Detection[] = [];
    for (const d of this.resolution.detections) {
      if (!d.finalized || d.end === null || this.settledEnds.get(d.id) === d.end) continue;
      this.settledEnds.set(d.id, d.end);
      out.push(d);
    }
    return out;
  }

  private mark(id: string, change: (shown: Detection) => Partial<Pick<Detection, 'liked' | 'manualAlternates'>>): void {
    const shown = this.get(id);
    if (!shown) return;
    const patch = change(shown);
    const c = this.confirmations.get(id);
    if (c) {
      Object.assign(c, patch);
    } else {
      const rawId = this.resolution.rawIdOf.get(id);
      const r = rawId ? this.raw.get(rawId) : undefined;
      if (!r) return;
      this.raw.set(r.id, { ...r, ...patch });
    }
    this.refresh();
  }

  private refresh(): void {
    this.resolution = resolveDetections([...this.raw.values()], [...this.confirmations.values()], this.final);
    // Each confirmation remembers how it last looked on screen — what stays
    // should the decoder abandon its range.
    for (const d of this.resolution.detections) {
      const c = this.confirmations.get(d.id);
      if (c && this.resolution.claims.has(c.id)) c.last = d;
    }
  }
}
