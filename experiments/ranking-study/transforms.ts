// ── Observation transforms ───────────────────────────────────────────────────
// Each rewrites ONE window's candidate scores. They are applied after the
// pre-Viterbi filters and before buildTemporalTimeline, so nothing in the
// detector, the Viterbi sweep or FolkFriend itself is touched: only the numbers
// the emission model reads.
//
// The problem they exist to attack, stated in detectionTemporalConfig.ts:
// `unknownObservationProbability` compares an ABSOLUTE score. Accompaniment
// degrades the contour, so a correctly identified tune can sit at 0.17-0.25 for
// its whole run while topping every window by a healthy margin — and lose to a
// constant floor of 0.20 the entire time.
//
// The 2026-09-08 dead-zone analysis sharpened that: in the six silent minutes of
// Audio D, FolkFriend's median top-1 score (0.290) was NORMAL — barely below the
// healthy control's 0.313. What collapsed was the MARGIN (0.063 vs 0.130) and
// with it the stability of the leader. A correct tune was found elsewhere in the
// same session at 0.145, LOWER than the 0.287 of one that was missed. Absolute
// level is not what separates the two cases.
//
// Windows always carry exactly 10 candidates (FolkFriend truncates), so `scores`
// has a fixed length and rank is simply the index + 1.

/** Present-but-negligible. Kept strictly positive because a 0 observation is
 *  indistinguishable from "this tune was absent from the window". */
const FLOOR = 1e-4;

export interface ObservationTransform {
  name: string;
  /** One line, printed above the results table. */
  blurb: string;
  /** `scores` arrives sorted descending — FolkFriend's own candidate order. */
  apply(scores: number[]): number[];
}

const clampFloor = (v: number): number => (v > FLOOR ? v : FLOOR);

/** Control. Must reproduce production numbers exactly, and the harness asserts
 *  it does before any other result is believed. */
export const identity: ObservationTransform = {
  name: 'identity',
  blurb: 'scores bruts FolkFriend — temoin, doit reproduire la production',
  apply: (s) => s.slice(),
};

/** A genuine per-window distribution: the candidates' scores normalised to sum
 *  to 1. The most principled of the set, because Viterbi's emission term wants
 *  P(observation | state) and this is the only transform that actually produces
 *  one. It encodes rank AND margin at once: a decisive window concentrates mass
 *  on its leader, a flat one spreads it thin across ten near-equals — which is
 *  the flat-window filter's judgement, expressed continuously instead of as a
 *  cliff. `unknownObservationProbability` then reads naturally as the mass we
 *  reserve for none-of-these. */
export const share: ObservationTransform = {
  name: 'share',
  blurb: 'part normalisee s_i / somme(s) — vraie distribution par fenetre',
  apply: (s) => {
    const sum = s.reduce((a, b) => a + b, 0);
    if (sum <= 0) return s.map(() => FLOOR);
    return s.map(v => clampFloor(v / sum));
  },
};

/** Purely relative to the window's own best. The leader always scores 1.0,
 *  whatever its absolute level — the most direct possible answer to "degraded
 *  audio drags the score down".
 *
 *  Expected to fail, and included because failing informatively is worth a
 *  column: it throws away all information about whether the window meant
 *  anything, so every window in the recording nominates a leader at full
 *  strength, noise included. */
export const relLeader: ObservationTransform = {
  name: 'relLeader',
  blurb: 's_i / s_1 — le meneur vaut 1 quel que soit son niveau absolu',
  apply: (s) => {
    const top = s[0] ?? 0;
    if (top <= 0) return s.map(() => FLOOR);
    return s.map(v => clampFloor(v / top));
  },
};

/** Rank and nothing else: the magnitudes are discarded entirely. The cleanest
 *  test of "does the absolute score carry any information the ordering does
 *  not?" — if this matches `share`, the scores are only useful as a sort key. */
export function rankDecay(rho: number): ObservationTransform {
  return {
    name: `rankDecay${rho}`,
    blurb: `${rho}^(rang-1) — le rang seul, magnitudes ignorees`,
    apply: (s) => s.map((_, i) => clampFloor(Math.pow(rho, i))),
  };
}

/** Half-way house: the geometric mean of the absolute score and its value
 *  relative to the leader, i.e. s_i / sqrt(s_1). Keeps some absolute
 *  information while lifting a whole degraded window towards its leader.
 *  Included to see whether the answer is a blend rather than a side. */
export const sqrtHybrid: ObservationTransform = {
  name: 'sqrtHybrid',
  blurb: 'moyenne geometrique absolu/relatif — s_i / racine(s_1)',
  apply: (s) => {
    const top = s[0] ?? 0;
    if (top <= 0) return s.map(() => FLOOR);
    const d = Math.sqrt(top);
    return s.map(v => clampFloor(v / d));
  },
};

/** The targeted candidate: relative to the leader, then scaled by how decisive
 *  the window actually was.
 *
 *  The decisiveness term is the flat-window filter's own quantity — the gap
 *  between the top candidate and the third — but applied as a weight instead of
 *  a threshold. That matters because of what the dead-zone analysis found: the
 *  filter blanked 3 of the 5 windows in which the missed tune was RANKED FIRST,
 *  on the grounds that the top three were close. A blanked window is not
 *  neutral, it becomes an UNKNOWN observation — evidence AGAINST the tune it
 *  was actually nominating. Weighting keeps that evidence, in proportion.
 *
 *  A perfectly decisive window (third candidate near zero) gives its leader
 *  1.0; a perfectly flat one gives everything near zero and UNKNOWN wins on its
 *  own, with no filter needed. */
export const relLeaderXMargin: ObservationTransform = {
  name: 'relLeaderXMargin',
  blurb: '(s_i / s_1) x marge normalisee (s_1 - s_3)/s_1 — filtre plat rendu continu',
  apply: (s) => {
    const top = s[0] ?? 0;
    if (top <= 0) return s.map(() => FLOOR);
    const third = s[2] ?? 0;
    const decisiveness = Math.max(0, (top - third) / top);
    return s.map(v => clampFloor((v / top) * decisiveness));
  },
};

/** Same idea as relLeaderXMargin but keeping the absolute level in play, so the
 *  comparison isolates whether dropping it is what helps or what hurts. */
export const shareXMargin: ObservationTransform = {
  name: 'shareXMargin',
  blurb: 'part normalisee x marge normalisee — distribution ponderee par la decision',
  apply: (s) => {
    const sum = s.reduce((a, b) => a + b, 0);
    const top = s[0] ?? 0;
    if (sum <= 0 || top <= 0) return s.map(() => FLOOR);
    const third = s[2] ?? 0;
    const decisiveness = Math.max(0, (top - third) / top);
    return s.map(v => clampFloor((v / sum) * decisiveness));
  },
};

/**
 * THE MAIN HYPOTHESIS. Each candidate divided by its own window's null model —
 * the score a merely-typical candidate gets here.
 *
 * The reasoning starts from a fact worth restating: **FolkFriend's output is a
 * score, not a probability.** It is a Needleman-Wunsch alignment similarity. Its
 * ORDERING within a window is meaningful; its absolute LEVEL is contaminated by
 * how cleanly the audio transcribed, which is exactly the nuisance we keep
 * fighting. Feeding it to `log()` as though it were a likelihood, then comparing
 * it to a constant, gives that nuisance parameter a vote.
 *
 * Dividing by a within-window null removes it. And because the detector's
 * emission term is `log(observation)`, this makes the observation a genuine
 * LOG-RATIO — evidence for this tune over the window's own background — which is
 * the shape a Viterbi emission is supposed to have in the first place.
 *
 * The consequence for `unknownObservationProbability` is the interesting part:
 * it stops being a score at all and becomes a pure RATIO. "1.5" means "a
 * candidate must beat this window's null by half again to be believed", and
 * that sentence is true whatever the recording's audio quality — which is not
 * something the current absolute floor of 0.20 can ever claim.
 *
 * `k` picks the null. k=3 is the flat-window filter's own reference point,
 * expressed as a ratio rather than a difference and used continuously rather
 * than as a cliff.
 */
export function nullRatio(k: number): ObservationTransform {
  return {
    name: `nullRatio${k}`,
    blurb: `s_i / s_${k} — rapport au modele nul de la fenetre, le plancher devient un facteur`,
    apply: (s) => {
      const nul = s[k - 1] ?? 0;
      if (nul <= 0) return s.map(() => FLOOR);
      return s.map(v => clampFloor(v / nul));
    },
  };
}

/** Same idea, but the null is the mean of everything below the leader — more
 *  robust than a single order statistic, which one lucky near-duplicate in the
 *  index can distort. */
export const nullRatioTailMean: ObservationTransform = {
  name: 'nullRatioTailMean',
  blurb: 's_i / moyenne(s_2..s_n) — modele nul robuste, moyenne de la queue',
  apply: (s) => {
    if (s.length < 2) return s.map(() => FLOOR);
    let sum = 0;
    for (let i = 1; i < s.length; i++) sum += s[i]!;
    const nul = sum / (s.length - 1);
    if (nul <= 0) return s.map(() => FLOOR);
    return s.map(v => clampFloor(v / nul));
  },
};

export const ALL_TRANSFORMS: ObservationTransform[] = [
  identity,             // control — must reproduce production
  nullRatio(3),         // main hypothesis, flat filter's reference point as a ratio
  nullRatio(5),         // same, median-ish null
  nullRatioTailMean,    // same, robust null
  share,                // a real per-window distribution
  relLeader,            // pure relative — expected to fail informatively
  rankDecay(0.5),       // pure rank — does magnitude carry anything at all?
  relLeaderXMargin,     // bounded cousin of nullRatio3
  sqrtHybrid,           // half absolute, half relative
  shareXMargin,
];
