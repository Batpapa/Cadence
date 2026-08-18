'use strict';

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function std(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
function percentile(sortedXs, p) {
  if (sortedXs.length === 0) return null;
  const idx = (p / 100) * (sortedXs.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedXs[lo];
  return sortedXs[lo] + (sortedXs[hi] - sortedXs[lo]) * (idx - lo);
}

function describe(values) {
  const xs = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return {
    count: xs.length,
    mean: mean(xs),
    median: percentile(xs, 50),
    std: std(xs),
    min: xs[0],
    max: xs[xs.length - 1],
    p5: percentile(xs, 5),
    p25: percentile(xs, 25),
    p75: percentile(xs, 75),
    p95: percentile(xs, 95),
  };
}

/** ROC AUC via the Mann-Whitney U statistic (rank-sum), O(n log n).
 *  `positive` values are the "MUSIC" class; `negative` are "NOISE".
 *  AUC = P(a random positive scores higher than a random negative).
 *  0.5 = no discriminative power; closer to 0 or 1 = strong (direction-dependent). */
function rocAuc(positive, negative) {
  const pos = positive.filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  const neg = negative.filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  if (pos.length === 0 || neg.length === 0) return null;

  const tagged = [...pos.map(v => [v, 1]), ...neg.map(v => [v, 0])];
  tagged.sort((a, b) => a[0] - b[0]);

  // Assign average rank to ties.
  const ranks = new Array(tagged.length);
  let i = 0;
  while (i < tagged.length) {
    let j = i;
    while (j + 1 < tagged.length && tagged[j + 1][0] === tagged[i][0]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let rankSumPos = 0;
  for (let k = 0; k < tagged.length; k++) if (tagged[k][1] === 1) rankSumPos += ranks[k];

  const n1 = pos.length, n0 = neg.length;
  const u1 = rankSumPos - (n1 * (n1 + 1)) / 2;
  return u1 / (n1 * n0);
}

module.exports = { mean, std, percentile, describe, rocAuc };
