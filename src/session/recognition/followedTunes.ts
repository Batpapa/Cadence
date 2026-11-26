import type { DetectionEvent, WindowCandidate } from '../model';

// ── What the segmenter follows, and a second opinion on the shortlist ─────────
// (2026-11-26, the experimental recognition: ffWorker.ts's analyzeWithTranscriptor.)
//
// A window's query returns its best 10 tunes out of some 50 000 settings. When
// an intruder takes the lead in a confused window, the tune actually playing can
// fall out of those 10 — and then the segmenter does not receive a low score for
// it, it receives NOTHING, read as "absent". It cannot know the tune would have
// scored 0.55 there; only the engine can. So the tune the segmenter is following
// (its open detection, or one closed a window ago) is scored on the window's own
// contour whenever it is missing — against an index holding that tune alone,
// a few milliseconds.
//
// Then the whole shortlist is re-scored by a second contour of the same window
// (the same analysis decoded otherwise, transcriptor.ts's recognitionContour):
// each tune at the mean of its two scores. Two opinions that err in different
// places — the reason averaging FolkFriend's whole search with ours used to halve
// the wrong names shown briefly — without a second search of the index.
//
// Measured with the production segmenter on the 18 annotated recordings
// (recognition-research/JOURNAL.md 22.8): 688/703 tunes for 12 false positives
// and 21 wrong names shown briefly, against 685/13/33 without either, FolkFriend
// 683/11/46, the average of FolkFriend and ours 684/10/20. The detections' own
// alternates as well, or detections followed longer after they close: the same.

/** Windows after its close a detection's tune is still followed. */
const FOLLOW_AFTER_CLOSE = 1;

export class FollowedTunes {
  private readonly live = new Map<string, { tuneId: string; open: boolean; lastOpen: number }>();

  /** The segmenter's events after it stepped the window of index `k`. */
  update(events: DetectionEvent[], k: number): void {
    for (const e of events) {
      if (e.type === 'retract') { this.live.delete(e.id); continue; }
      const d = e.detection;
      const prev = this.live.get(d.id);
      const open = d.end === null;
      // the window it was last seen open in (a detection first met closed counts from now)
      const lastOpen = open || !prev || prev.open ? k : prev.lastOpen;
      this.live.set(d.id, { tuneId: d.tuneId, open, lastOpen });
    }
  }

  /** The tunes to score in the window of index `k`. */
  tunes(k: number): string[] {
    const out = new Set<string>();
    for (const d of this.live.values()) if (d.open || k - d.lastOpen <= FOLLOW_AFTER_CLOSE) out.add(d.tuneId);
    return [...out];
  }
}

/** `candidates` re-scored by other opinions (each: tune -> its score there): each tune at the
 *  mean of its scores; a tune an opinion did not score, at the lowest that opinion gave. An
 *  opinion that scored nothing is left out. Best first. */
export function rescored(candidates: WindowCandidate[], opinions: Map<string, number>[]): WindowCandidate[] {
  const heard = opinions.filter(o => o.size);
  if (!heard.length) return candidates;
  const floors = heard.map(o => Math.min(...o.values()));
  return candidates
    .map(c => ({ ...c, score: heard.reduce((s, o, i) => s + (o.get(c.tuneId) ?? floors[i]!), c.score) / (heard.length + 1) }))
    .sort((p, q) => q.score - p.score);
}
