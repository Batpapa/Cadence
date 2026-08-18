'use strict';
// Deliberately tiny, dependency-free implementations — this is a feasibility
// check ("is there enough signal"), not a production model. See regenerate
// -fixtures.js/build-dataset.js for how the input rows are built.

function standardize(X, meanArr, stdArr) {
  return X.map(row => row.map((v, j) => (v - meanArr[j]) / (stdArr[j] || 1)));
}

function fitStandardizer(X) {
  const n = X.length, d = X[0].length;
  const meanArr = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) meanArr[j] += row[j] / n;
  const stdArr = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) stdArr[j] += (row[j] - meanArr[j]) ** 2 / n;
  for (let j = 0; j < d; j++) stdArr[j] = Math.sqrt(stdArr[j]);
  return { meanArr, stdArr };
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

/** Simple L2-regularized logistic regression via batch gradient descent. */
function trainLogisticRegression(X, y, { iters = 800, lr = 0.3, l2 = 0.01 } = {}) {
  const n = X.length, d = X[0].length;
  let w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, v, j) => s + v * w[j], b);
      const p = sigmoid(z);
      const err = p - y[i];
      for (let j = 0; j < d; j++) gradW[j] += (err * X[i][j]) / n;
      gradB += err / n;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gradW[j] + l2 * w[j]);
    b -= lr * gradB;
  }
  return {
    predictProba: (row) => sigmoid(row.reduce((s, v, j) => s + v * w[j], b)),
    weights: w,
    bias: b,
  };
}

// ── Tiny random forest (Gini, bootstrap, random feature subset per split) ──

function gini(labels) {
  const n = labels.length;
  if (n === 0) return 0;
  const p1 = labels.reduce((a, b) => a + b, 0) / n;
  return 1 - p1 * p1 - (1 - p1) * (1 - p1);
}

function bestSplit(X, y, featureIdxs) {
  const n = X.length;
  let best = null;
  for (const j of featureIdxs) {
    const values = [...new Set(X.map(r => r[j]))].sort((a, b) => a - b);
    for (let t = 0; t < values.length - 1; t++) {
      const threshold = (values[t] + values[t + 1]) / 2;
      const leftY = [], rightY = [];
      for (let i = 0; i < n; i++) (X[i][j] <= threshold ? leftY : rightY).push(y[i]);
      if (leftY.length === 0 || rightY.length === 0) continue;
      const impurity = (leftY.length * gini(leftY) + rightY.length * gini(rightY)) / n;
      if (!best || impurity < best.impurity) best = { feature: j, threshold, impurity };
    }
  }
  return best;
}

function buildTree(X, y, featureIdxsAll, depth, maxDepth, minLeaf, rng) {
  const p1 = y.reduce((a, b) => a + b, 0) / (y.length || 1);
  if (depth >= maxDepth || y.length < minLeaf * 2 || p1 === 0 || p1 === 1) {
    return { leaf: true, proba: p1 };
  }
  const k = Math.max(1, Math.round(Math.sqrt(featureIdxsAll.length)));
  const shuffled = [...featureIdxsAll].sort(() => rng() - 0.5);
  const featureSubset = shuffled.slice(0, k);
  const split = bestSplit(X, y, featureSubset);
  if (!split) return { leaf: true, proba: p1 };

  const leftIdx = [], rightIdx = [];
  X.forEach((row, i) => (row[split.feature] <= split.threshold ? leftIdx : rightIdx).push(i));
  if (leftIdx.length < minLeaf || rightIdx.length < minLeaf) return { leaf: true, proba: p1 };

  const leftX = leftIdx.map(i => X[i]), leftY = leftIdx.map(i => y[i]);
  const rightX = rightIdx.map(i => X[i]), rightY = rightIdx.map(i => y[i]);
  return {
    leaf: false,
    feature: split.feature,
    threshold: split.threshold,
    left: buildTree(leftX, leftY, featureIdxsAll, depth + 1, maxDepth, minLeaf, rng),
    right: buildTree(rightX, rightY, featureIdxsAll, depth + 1, maxDepth, minLeaf, rng),
  };
}

function predictTree(node, row) {
  if (node.leaf) return node.proba;
  return row[node.feature] <= node.threshold ? predictTree(node.left, row) : predictTree(node.right, row);
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function trainRandomForest(X, y, { numTrees = 25, maxDepth = 4, minLeaf = 5, seed = 42 } = {}) {
  const rng = mulberry32(seed);
  const n = X.length;
  const featureIdxsAll = [...Array(X[0].length).keys()];
  const trees = [];
  for (let t = 0; t < numTrees; t++) {
    const bootstrapIdx = Array.from({ length: n }, () => Math.floor(rng() * n));
    const bx = bootstrapIdx.map(i => X[i]);
    const by = bootstrapIdx.map(i => y[i]);
    trees.push(buildTree(bx, by, featureIdxsAll, 0, maxDepth, minLeaf, rng));
  }
  return {
    predictProba: (row) => trees.reduce((s, tree) => s + predictTree(tree, row), 0) / trees.length,
  };
}

function confusionAt(yTrue, probs, threshold = 0.5) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const pred = probs[i] >= threshold ? 1 : 0;
    if (pred === 1 && yTrue[i] === 1) tp++;
    else if (pred === 1 && yTrue[i] === 0) fp++;
    else if (pred === 0 && yTrue[i] === 0) tn++;
    else fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return { tp, fp, tn, fn, precision, recall };
}

module.exports = {
  standardize, fitStandardizer, trainLogisticRegression, trainRandomForest, confusionAt,
};
