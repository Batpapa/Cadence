// ── Live score following: where a tune being played is in its score, NOW ─────
// The live counterpart of scoreFollow.ts, for the score viewer's Play-along
// (2026-10-31, the user; developer mode only for now): the microphone heard
// frame by frame, the score's cursor kept on what is being played.
//
// The same hidden semi-Markov model as scoreFollow.ts — each quaver a segment
// of free length around a tempo's quaver, the score looping on itself, an
// "outside the tune" state scored as another tune or noise — run forwards
// only, one frame at a time. What changes:
//  - outside the tune is a state the path may leave and come back to, at any
//    quaver, each way for a price: someone practising stops, starts again at
//    the B part, plays a bar twice. The recording's model enters once and
//    leaves once.
//  - several tempi are followed side by side, instead of one searched for on
//    30 s of the recording; a quaver may hand over to the next at another
//    tempo, for a price, so the tempo can drift as it does.
//  - the loudness under which a frame says nothing is a running percentile,
//    not one over the whole recording.
//  - the position is read off the best path as it stands — the quaver under
//    way and how far into it — `lagFrames` back, where the path has settled.
//    The page then carries it forward to the moment it draws (LiveCursor):
//    by then the music has moved on by the microphone's latency, the frame,
//    the lag and the screen's.
//
// Self-contained on purpose: the bench (experiments/score-follow/live.mjs)
// runs this very file under plain Node, which resolves no extensionless
// import — so the bench measures what ships.

const MIDI_LOW = 48;
const MIDI_NUM = 48;

export interface LiveFollowOptions {
  /** Shortest and longest quaver, as a ratio of a tempo's (scoreFollow.ts). */
  minRatio: number;
  maxRatio: number;
  durWeight: number;
  /** Outside the tune, a frame is worth its best pitch minus this, or the
   *  noise floor (scoreFollow.ts). */
  otherPenalty: number;
  noiseFloor: number;
  /** Crotchets per minute of the tempi followed side by side. */
  bpms: number[];
  /** What coming into the tune from outside costs, and leaving it. */
  enterPenalty: number;
  exitPenalty: number;
  /** What a quaver handing over to the next at another tempo costs. */
  switchPenalty: number;
  /** How far back the position is read, in frames. */
  lagFrames: number;
  /** Frames the raw verdict must hold before the cursor shows, and before it
   *  goes: a cursor that blinks is worse than one a moment late. */
  showFrames: number;
  hideFrames: number;
  /** The span the loudness percentile is taken over, and the local tempo's. */
  loudSeconds: number;
  rateSeconds: number;
  /** Feature frames per second: the sample rate over 1024. */
  fps: number;
}

export const LIVE_FOLLOW_DEFAULTS: LiveFollowOptions = {
  minRatio: 0.45,
  maxRatio: 2.2,
  durWeight: 2,
  otherPenalty: 1.2,
  noiseFloor: Math.log(0.01 + 2 / MIDI_NUM),
  bpms: [60, 80, 100, 120, 140, 160, 180, 200, 220, 240],
  // Measured with live.mjs (2026-10-31). On the synthetic solo and practice
  // runs, 6 over 4 kept the same quavers right and the same acquisition with
  // a cursor shown outside the tune 17 % of the time instead of 36, and up
  // to 15 changes nothing there. On real pub sessions, where a score fits
  // what is heard far less well, the path came back in elsewhere all the
  // time: at 15 (and LiveCursor's confirmSeconds 0.4) the cursor is on the
  // right note 71 % of the time instead of 61 and jumps back 130 times
  // instead of 864 (Anglade, 20 tunes), 45 % and 227 instead of 37 % and
  // 1996 (the pub afternoon).
  enterPenalty: 15,
  exitPenalty: 4,
  switchPenalty: 2,
  lagFrames: 3,
  // 15 over 5: a little fewer cursors outside the tune, no later acquisition.
  showFrames: 15,
  // 20 over 33: a cursor left on a stopped tune 12 % of the time outside it
  // instead of 17 (solo), 21 instead of 29 (practice); nothing else moved.
  hideFrames: 20,
  loudSeconds: 15,
  rateSeconds: 3,
  fps: 48000 / 1024,
};

/** search: nothing followed yet; follow: the tune is being played; lost: it
 *  was, and is no longer. */
export type LiveState = 'search' | 'follow' | 'lost';

export interface LiveEstimate {
  state: LiveState;
  /** Where the score is at `at`: the quaver of one pass, with its fraction
   *  (0 ≤ quaver < quavers). Null while the tune is not heard there — also
   *  for a moment inside `follow`, which LiveCursor rides out. */
  quaver: number | null;
  /** Seconds from the first frame the position is for — `lagFrames` before
   *  the end of the last frame heard, or where the tune was come back into. */
  at: number;
  /** The local tempo, quavers per second, over the last `rateSeconds`. */
  rate: number;
  /** The tempo followed (crotchets per minute) — for a diagnostic. */
  bpm: number;
  /** Of the recent frames that had a pitch, the share on the score's pitch
   *  class (scoreFollow.ts's `match`); null when none had one. */
  match: number | null;
}

interface Tempo {
  bpm: number;
  /** Frames per quaver, and the shortest and longest a quaver may last. */
  d: number;
  dMin: number;
  dMax: number;
  /** The duration penalty of a quaver `k` frames long, k ≥ dMin. */
  pen: Float64Array;
  /** best[b·N + i]: the best path whose quaver i ENDS at frame boundary b. */
  best: Float64Array;
  /** How that quaver was come to: its length, and the tempo of the quaver
   *  before it — or OUTSIDE (= the number of tempi). */
  fromK: Int16Array;
  fromSrc: Int8Array;
}

export class LiveFollower {
  readonly quavers: number;
  private readonly opt: LiveFollowOptions;
  private readonly rows: Int8Array;
  private readonly pcs: Int8Array;
  private readonly tempi: Tempo[];
  /** Ring depths: boundaries the recursion reads back, and those the
   *  trace-back does. */
  private readonly ringB: number;
  private readonly ringF: number;
  private readonly rateFrames: number;
  /** Cumulative emission per pitch at each boundary (ringB × MIDI_NUM). */
  private readonly C: Float64Array;
  /** Best path ending outside the tune at each boundary, and how it got
   *  there: -1 it already was, else tempo·N + quaver just left. */
  private readonly O: Float64Array;
  private readonly oFrom: Int32Array;
  /** The best of every tempo per quaver and boundary, and whose. */
  private readonly M: Float64Array;
  private readonly mArg: Int8Array;
  /** Each frame's loudest pitch class, -1 for none. */
  private readonly top: Int8Array;
  /** The recent frames' loudness (push's `level`, or the features' sum). */
  private readonly energy: Float32Array;
  private readonly sorted: Float32Array;
  private readonly L = new Float64Array(MIDI_NUM);
  private loud = 0;
  /** The best quaver ending at the last boundary, tempo·N + quaver. */
  private eBest = -Infinity;
  private eArg = -1;
  private T = 0;
  private state: LiveState = 'search';
  private run = 0;

  /** `score`: MIDI pitches, one per quaver of a pass (scoreFollow.ts). */
  constructor(score: number[], options: Partial<LiveFollowOptions> = {}) {
    const opt = { ...LIVE_FOLLOW_DEFAULTS, ...options };
    this.opt = opt;
    const N = score.length;
    this.quavers = N;
    this.rows = Int8Array.from(score, (m) => {
      let p = m - MIDI_LOW;
      while (p < 0) p += 12;
      while (p >= MIDI_NUM) p -= 12;
      return p;
    });
    this.pcs = Int8Array.from(score, m => ((m % 12) + 12) % 12);
    this.rateFrames = Math.ceil(opt.rateSeconds * opt.fps);
    let dMaxAll = 1;
    const shapes = opt.bpms.map((bpm) => {
      const d = opt.fps / ((bpm / 60) * 2);
      const dMin = Math.max(1, Math.floor(d * opt.minRatio));
      const dMax = Math.ceil(d * opt.maxRatio);
      dMaxAll = Math.max(dMaxAll, dMax);
      const pen = new Float64Array(dMax + 1);
      for (let k = dMin; k <= dMax; k++) pen[k] = -opt.durWeight * Math.log(k / d) ** 2;
      return { bpm, d, dMin, dMax, pen };
    });
    this.ringB = dMaxAll + 1;
    this.ringF = opt.lagFrames + this.rateFrames + 2 * dMaxAll + 2;
    this.tempi = shapes.map(s => ({
      ...s,
      best: new Float64Array(this.ringB * N).fill(-Infinity),
      fromK: new Int16Array(this.ringF * N),
      fromSrc: new Int8Array(this.ringF * N),
    }));
    this.C = new Float64Array(this.ringB * MIDI_NUM);
    this.O = new Float64Array(this.ringB).fill(-Infinity);
    this.O[0] = 0;
    this.oFrom = new Int32Array(this.ringF).fill(-1);
    this.M = new Float64Array(this.ringB * N).fill(-Infinity);
    this.mArg = new Int8Array(this.ringB * N);
    this.top = new Int8Array(this.ringF).fill(-1);
    const loudFrames = Math.max(1, Math.ceil(opt.loudSeconds * opt.fps));
    this.energy = new Float32Array(loudFrames);
    this.sorted = new Float32Array(loudFrames);
  }

  /** Frames heard so far. */
  get frames(): number { return this.T; }

  /** One more frame of pitch energies (MIDI_NUM values, FolkFriend's
   *  `take_features`), and where the score now stands. `level`: the mean
   *  square of the frame's samples, when there are samples to measure. */
  push(frame: ArrayLike<number>, level?: number): LiveEstimate {
    const { opt, rows, ringB, ringF, C, O, M, mArg, L } = this;
    const N = this.quavers;
    const f = this.T, T1 = f + 1;

    // The frame's loudness, against the recent ones' 90th percentile. On the
    // samples' level when given: the features hardly say how loud a frame is
    // — pink noise 25 dB under the music still weighed a fifth to two fifths
    // of a played frame (2026-10-31), so a pause was never read as one and
    // the cursor wandered on through it. Under a hundredth of the power
    // (-20 dB) a frame says nothing. Else on the features' sum, at
    // scoreFollow.ts's 5 %.
    let sum = 0, topV = 0, topP = -1;
    for (let p = 0; p < MIDI_NUM; p++) {
      const v = frame[p]!;
      sum += v;
      if (v > topV) { topV = v; topP = p; }
    }
    const loudness = level ?? sum;
    const quietBelow = level === undefined ? 0.05 : 0.01;
    const span = this.energy.length;
    this.energy[f % span] = loudness;
    if (f < 64 || (f & 15) === 0) {
      const n = Math.min(f + 1, span);
      const s = this.sorted.subarray(0, n);
      s.set(this.energy.subarray(0, n));
      s.sort();
      this.loud = s[Math.floor(n * 0.9)] || 1;
    }
    const quiet = sum <= 0 || loudness < this.loud * quietBelow;
    // A quiet frame has no pitch to match either.
    this.top[f % ringF] = quiet || topP < 0 ? -1 : (topP + MIDI_LOW) % 12;

    // Emissions — scoreFollow.ts's, for one frame.
    const flat = Math.log(0.01 + 1 / MIDI_NUM);
    let topL = flat;
    if (quiet) {
      L.fill(flat);
    } else {
      topL = -Infinity;
      for (let p = 0; p < MIDI_NUM; p++) {
        const below = p >= 12 ? frame[p - 12]! : 0;
        const above = p + 12 < MIDI_NUM ? frame[p + 12]! : 0;
        const v = Math.log(0.01 + (frame[p]! + 0.6 * Math.max(below, above)) / sum);
        L[p] = v;
        if (v > topL) topL = v;
      }
    }
    const cPrev = (f % ringB) * MIDI_NUM, cNow = (T1 % ringB) * MIDI_NUM;
    for (let p = 0; p < MIDI_NUM; p++) C[cNow + p] = C[cPrev + p]! + L[p]!;

    // Outside the tune: stayed there, or just left after a quaver.
    const other = Math.max(topL - opt.otherPenalty, opt.noiseFloor);
    const stay = O[f % ringB]!;
    const leave = this.eBest - opt.exitPenalty;
    const oNow = (leave > stay ? leave : stay) + other;
    O[T1 % ringB] = oNow;
    this.oFrom[T1 % ringF] = leave > stay ? this.eArg : -1;

    // The quavers, at every tempo: those ending at this boundary, and the one
    // under way that is the best path now.
    const H = this.tempi.length;
    const mNow = (T1 % ringB) * N;
    M.fill(-Infinity, mNow, mNow + N);
    let inBest = -Infinity, inH = -1, inI = -1, inK = 0, inSrc = H;
    for (let h = 0; h < H; h++) {
      const tp = this.tempi[h]!;
      const { best, pen, d, dMin } = tp;
      const bNow = (T1 % ringB) * N, fNow = (T1 % ringF) * N;
      const kTop = Math.min(tp.dMax, T1);
      for (let i = 0; i < N; i++) {
        const prev = i === 0 ? N - 1 : i - 1;
        const row = rows[i]!;
        const cT = C[cNow + row]!;
        let b = -Infinity, bk = 0, bs = 0;
        for (let k = 1; k <= kTop; k++) {
          const sb = (T1 - k) % ringB;
          const at = sb * N + prev;
          // The way in to quaver i at that boundary: from the quaver before
          // it at this tempo, at another, or from outside the tune.
          let e = best[at]!, src = h;
          const m = M[at]! - opt.switchPenalty;
          if (m > e) { e = m; src = mArg[at]!; }
          const o = O[sb]! - opt.enterPenalty;
          if (o > e) { e = o; src = H; }
          if (e === -Infinity) continue;
          const v = e + cT - C[sb * MIDI_NUM + row]!;
          if (k >= dMin) {
            const w = v + pen[k]!;
            if (w > b) { b = w; bk = k; bs = src; }
          }
          // Under way, a quaver costs nothing until it outlasts its tempo's.
          const u = k <= d ? v : v + pen[k]!;
          if (u > inBest) { inBest = u; inH = h; inI = i; inK = k; inSrc = src; }
        }
        best[bNow + i] = b;
        tp.fromK[fNow + i] = bk;
        tp.fromSrc[fNow + i] = bs;
        if (b > M[mNow + i]!) { M[mNow + i] = b; mArg[mNow + i] = h; }
      }
    }
    this.eBest = -Infinity;
    for (let i = 0; i < N; i++) {
      if (M[mNow + i]! > this.eBest) { this.eBest = M[mNow + i]!; this.eArg = mArg[mNow + i]! * N + i; }
    }
    this.T = T1;

    const inTune = inH >= 0 && inBest > oNow;
    const following = this.state === 'follow';
    if (inTune === following) this.run = 0;
    else if (++this.run >= (inTune ? opt.showFrames : opt.hideFrames)) {
      this.state = inTune ? 'follow' : 'lost';
      this.run = 0;
    }
    const lagAt = (T1 - opt.lagFrames) / opt.fps;
    if (!inTune || this.state !== 'follow') {
      return { state: this.state, quaver: null, at: lagAt, rate: 0, bpm: 0, match: null };
    }
    return { state: this.state, ...this.trace(inH, inI, inK, inSrc, T1), bpm: this.tempi[inH]!.bpm };
  }

  /** The best path back from the quaver under way: the position `lagFrames`
   *  back, the local tempo and match over the last `rateSeconds`. */
  private trace(h: number, i: number, k: number, src: number, T1: number): Pick<LiveEstimate, 'quaver' | 'at' | 'rate' | 'match'> {
    const { opt, ringF, tempi } = this;
    const N = this.quavers;
    const H = tempi.length;
    const w0 = T1 - this.rateFrames;
    const starts: number[] = [], ends: number[] = [], idx: number[] = [];
    let start = T1 - k, end = T1, ci = i, csrc = src;
    for (;;) {
      starts.push(start); ends.push(end); idx.push(ci);
      // Back to the quaver before, unless this one came from outside the
      // tune, or what came before is past the window or out of the ring.
      if (start <= w0 || csrc === H || start <= T1 - ringF) break;
      const pi = ci === 0 ? N - 1 : ci - 1;
      const tp = tempi[csrc]!;
      const fi = (start % ringF) * N + pi;
      const pk = tp.fromK[fi]!;
      if (pk <= 0) break;
      end = start;
      start -= pk;
      ci = pi;
      csrc = tp.fromSrc[fi]!;
    }
    const n = starts.length;
    // The position: `lagFrames` back — or where the tune was come back into,
    // when that is more recent.
    let u = T1 - opt.lagFrames;
    if (csrc === H && u < starts[n - 1]!) u = starts[n - 1]!;
    let quaver = idx[0]!;
    for (let s = 0; s < n; s++) {
      if (starts[s]! > u) continue;
      // The quaver under way has no end yet: its tempo's length, at least.
      const len = s === 0 ? Math.max(T1 - starts[0]!, tempi[h]!.d) : ends[s]! - starts[s]!;
      quaver = idx[s]! + Math.min(0.999, Math.max(0, (u - starts[s]!) / len));
      break;
    }
    // The local tempo, from the quavers begun in the window; the tempo's own
    // when there are too few of them.
    const spanFrames = starts[0]! - starts[n - 1]!;
    const rate = n >= 4 && spanFrames > 0 ? ((n - 1) * opt.fps) / spanFrames : opt.fps / tempi[h]!.d;
    let hit = 0, heard = 0;
    for (let s = 0; s < n; s++) {
      const pc = this.pcs[idx[s]!]!;
      for (let fr = Math.max(starts[s]!, w0); fr < ends[s]!; fr++) {
        const t = this.top[fr % ringF]!;
        if (t < 0) continue;
        heard++;
        if (t === pc) hit++;
      }
    }
    return { quaver, at: u / opt.fps, rate, match: heard ? hit / heard : null };
  }
}

// ── The cursor drawn: the estimate carried forward to the moment shown ───────

export interface LiveCursorOptions {
  /** A gap larger than this, in quavers, is a jump (the musician went
   *  elsewhere), not a drift to make up. */
  snapQuavers: number;
  /** How fast a gap is made up, per second. */
  gain: number;
  /** Seconds without a position before the cursor goes. */
  holdSeconds: number;
  /** Seconds the music must be heard elsewhere before the cursor jumps
   *  there: a follower torn between two places would otherwise be seen
   *  jumping to and fro. Meanwhile the cursor runs on where it is. */
  confirmSeconds: number;
}

/** confirmSeconds 0.4: on real pub sessions, a third of the jumps back seen
 *  without it, the notes right as often (live.mjs, 2026-10-31); a restart
 *  elsewhere in practice is shown that much later. */
export const LIVE_CURSOR_DEFAULTS: LiveCursorOptions = { snapQuavers: 4, gain: 4, holdSeconds: 1, confirmSeconds: 0.4 };

/** Turns the follower's estimates — late, and in steps — into a cursor that
 *  moves on its own between them: extrapolated at the local tempo to the
 *  moment it is drawn, it makes up any gap by speeding up or slowing down,
 *  never by stepping back, unless the gap says the music is elsewhere. */
export class LiveCursor {
  private readonly quavers: number;
  private readonly opt: LiveCursorOptions;
  private q = 0;
  private at = 0;
  private rate = 0;
  private seen = -Infinity;
  private shown: number | null = null;
  private last = 0;
  /** Since when the music has been heard elsewhere (confirmSeconds). */
  private away: number | null = null;

  constructor(quavers: number, options: Partial<LiveCursorOptions> = {}) {
    this.quavers = quavers;
    this.opt = { ...LIVE_CURSOR_DEFAULTS, ...options };
  }

  /** A new estimate. A null position keeps the last one going (held for
   *  `holdSeconds`); `lost` takes the cursor away at once. */
  update(e: Pick<LiveEstimate, 'state' | 'quaver' | 'at' | 'rate'>): void {
    if (e.state !== 'follow') { this.seen = -Infinity; this.shown = null; return; }
    if (e.quaver === null) return;
    this.q = e.quaver;
    this.at = e.at;
    this.rate = e.rate;
    this.seen = e.at;
  }

  /** Where to draw the cursor for the music at `now` (the follower's clock,
   *  seconds): a quaver of one pass with its fraction, or null. */
  position(now: number): number | null {
    if (now - this.seen > this.opt.holdSeconds) { this.shown = null; this.away = null; return null; }
    const N = this.quavers;
    const target = mod(this.q + this.rate * (now - this.at), N);
    if (this.shown === null) {
      this.shown = target;
      this.last = now;
      return target;
    }
    const dt = Math.min(0.1, Math.max(0, now - this.last));
    this.last = now;
    // The gap left once the cursor has run on at the tempo.
    let gap = mod(target - (this.shown + this.rate * dt), N);
    if (gap > N / 2) gap -= N;
    if (Math.abs(gap) > this.opt.snapQuavers) {
      // Elsewhere: a jump, once it has held long enough.
      if (this.away === null) this.away = now;
      if (now - this.away >= this.opt.confirmSeconds) { this.shown = target; this.away = null; }
      else this.shown = mod(this.shown + this.rate * dt, N);
    } else {
      this.away = null;
      this.shown = mod(this.shown + Math.max(0, this.rate * dt + this.opt.gain * gap * dt), N);
    }
    return this.shown;
  }
}

function mod(x: number, n: number): number {
  const r = x % n;
  return r < 0 ? r + n : r;
}
