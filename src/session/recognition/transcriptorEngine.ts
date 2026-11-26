import { recognitionContour } from '../../../transcriptor/src/recognition.ts';
import { resample, RATE } from '../../../transcriptor/src/decoder.ts';
import type { TuneQuery } from './folkfriendQuery';
import { FolkFriendView } from './folkfriendView';
import { FollowedTunes, rescored } from './followedTunes';
import type { WindowEngine } from './windowEngine';
import type { DetectionEvent, WindowResult, WindowDebugFeatures } from '../model';

// ── transcriptor/'s note decoder (the default engine) ─────────────────────────
// (2026-11-26) The window heard by the decoder that writes the hidden
// transcription's ABC, in the same regime: FolkFriend's cleaned class energies
// of the same samples as one more view (folkfriendView.ts), the contour queried
// as FolkFriend's would be (folkfriendQuery.ts), the pitches read off the
// decoder's own tuning — measured in transcriptor/src/recognition.ts. Then the
// tune the segmenter follows is scored when it fell out of the shortlist, and
// the shortlist re-scored by the window's other opinions (followedTunes.ts,
// where the measurements are). The decoder works at the rate it was measured at.

export class TranscriptorEngine implements WindowEngine {
  private readonly view = new FolkFriendView(RATE);
  private followed = new FollowedTunes();
  /** Windows the segmenter has stepped: the next one's index. */
  private stepCount = 0;

  /** `sampleRate`: the worker's (the audio's); `query`: over the loaded index. The FolkFriend
   *  module must be initialised, and transcriptorInit.ts's WebAssembly analysis asked for. */
  constructor(private readonly sampleRate: number, private readonly query: TuneQuery) {}

  analyze(pcm: Float32Array, tStart: number, tEnd: number): { result: WindowResult; abc: string | null } {
    const x = this.sampleRate === RATE ? pcm : resample(pcm, this.sampleRate, RATE);
    const { contour, opinions, tuning } = recognitionContour(x, RATE, this.view.of(x));
    let candidates = contour ? this.query.query(contour, tuning) : [];
    if (contour) {
      // the tune the segmenter follows, scored here even when it fell out of the 10
      const missing = this.followed.tunes(this.stepCount).filter(t => !candidates.some(c => c.tuneId === t));
      if (missing.length) candidates = [...candidates, ...this.query.shortlist(contour, missing, tuning)].sort((p, q) => q.score - p.score);
      // the shortlist re-scored by the window's other opinions
      const others = opinions.filter(Boolean);
      if (others.length && candidates.length) {
        const tunes = candidates.map(c => c.tuneId);
        candidates = rescored(candidates, others.map(o => new Map(this.query.shortlist(o, tunes, tuning).map(c => [c.tuneId, c.score]))));
      }
    }
    const abc = contour ? this.query.abcOf(contour) : null;
    const debug: WindowDebugFeatures = { contour: contour || null, octaveShiftApplied: 0, features: null };
    return { result: { tWindowStart: tStart, tWindowEnd: tEnd, empty: candidates.length === 0, candidates, debug }, abc };
  }

  stepped(events: DetectionEvent[]): void {
    this.followed.update(events, this.stepCount++);
  }

  reset(): void {
    this.followed = new FollowedTunes();
    this.stepCount = 0;
  }
}
