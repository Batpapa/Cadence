import type { WindowCandidate } from '../model';

// ── Two transcriptions of one window, their candidates averaged ───────────────
// (2026-11-26, hidden "experimental recognition", file imports only.) The window
// is transcribed twice — by FolkFriend, and by cadence-transcriptor's note
// decoder (transcriptor.ts's recognitionContour) — each contour queried against
// the same index, and every tune scored by the MEAN of its two scores: the two
// transcriptions go wrong in different places (on the 18 annotated sessions, 380
// windows right with the transcriptor only, 666 with FolkFriend only), and an
// error rarely survives the average.
//
// Measured with the production segmenter, unchanged (recognition-research/
// JOURNAL.md, section 22): 685/703 tunes for 10 false positives, against
// FolkFriend's 683 for 11; wrong names shown briefly on the live screen 46 -> 22;
// the right tune first in 94.1 % of the windows inside a tune (91.8 %). The
// segmenter's settings were swept again on these windows (cross-validated): the
// production ones stay the best.
//
// A tune only one list has is counted, in the other, at that list's last score
// — it was at most that. Weights 0.4 to 0.5 measured alike; the plain mean kept.

/** The candidates of two lists of a window, each tune at the mean of its scores,
 *  best first, at most `top`. A list that is empty (its transcription found no
 *  music) leaves the other as it is. */
export function fuseCandidates(a: WindowCandidate[], b: WindowCandidate[], top = 10): WindowCandidate[] {
  if (!b.length) return a.slice(0, top);
  if (!a.length) return b.slice(0, top);
  const floorA = a[a.length - 1]!.score, floorB = b[b.length - 1]!.score;
  const byTune = new Map<string, { a?: WindowCandidate; b?: WindowCandidate }>();
  for (const c of a) if (!byTune.has(c.tuneId)) byTune.set(c.tuneId, { a: c });
  for (const c of b) {
    const e = byTune.get(c.tuneId);
    if (!e) byTune.set(c.tuneId, { b: c });
    else if (!e.b) e.b = c;
  }
  const out: WindowCandidate[] = [];
  for (const { a: x, b: y } of byTune.values()) {
    const score = ((x?.score ?? floorA) + (y?.score ?? floorB)) / 2;
    // the setting, key and pitch of the transcription that heard the tune best
    const from = !x ? y! : !y ? x : (x.score >= y.score ? x : y);
    out.push({ ...from, score });
  }
  // stable: a tie keeps the first list's order
  out.sort((p, q) => q.score - p.score);
  return out.slice(0, top);
}
