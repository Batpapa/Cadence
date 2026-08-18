'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { describe, rocAuc } = require('./lib/stats');
const { fitStandardizer, standardize, trainLogisticRegression, trainRandomForest, confusionAt } = require('./lib/model');

const OUT_DIR = path.resolve(__dirname, 'output');
const DATASET_PATH = path.join(OUT_DIR, 'dataset.jsonl');
const REPORT_JSON_PATH = path.join(OUT_DIR, 'report.json');

const FEATURES = [
  'top1_score', 'top2_score', 'top3_score', 'top1_minus_top2', 'top1_div_top2',
  'sum_top5', 'sum_top10', 'candidates_above_20', 'candidates_above_30', 'candidates_above_40', 'candidates_above_50',
  'note_count_raw', 'note_count_filtered', 'note_count_rejected',
  'note_duration_mean', 'note_duration_median',
  'note_power_mean', 'note_power_max', 'note_power_median',
  'best_bpm', 'best_quant_score', 'best_rhythm_score', 'best_combined_score',
  'tempo_score_std', 'tempo_score_range',
  'contour_length', 'contour_num_direction_changes', 'contour_repetition_ratio', 'contour_pitch_range', 'contour_unique_pitch_count',
];

function loadRows() {
  return fs.readFileSync(DATASET_PATH, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}

function byLabel(rows, label) { return rows.filter(r => r.label === label); }

function featureStatsReport(rows) {
  const music = byLabel(rows, 'MUSIC');
  const noisePure = byLabel(rows, 'NOISE_PURE');
  const noiseMismatch = byLabel(rows, 'NOISE_MISMATCH');

  const perFeature = FEATURES.map(f => {
    const musicVals = music.map(r => r[f]);
    const noiseVals = noisePure.map(r => r[f]);
    const mismatchVals = noiseMismatch.map(r => r[f]);
    const auc = rocAuc(musicVals, noiseVals);
    const aucMismatch = rocAuc(musicVals, mismatchVals);
    return {
      feature: f,
      music: describe(musicVals),
      noise_pure: describe(noiseVals),
      noise_mismatch: describe(mismatchVals),
      auc_music_vs_noise_pure: auc,
      discriminative_power: auc === null ? null : Math.max(auc, 1 - auc),
      auc_music_vs_noise_mismatch: aucMismatch,
    };
  });

  perFeature.sort((a, b) => (b.discriminative_power ?? -1) - (a.discriminative_power ?? -1));
  return { counts: { MUSIC: music.length, NOISE_PURE: noisePure.length, NOISE_MISMATCH: noiseMismatch.length }, perFeature };
}

function caseStudyHighScoreFalsePositives(rows) {
  const falsePositives = rows.filter(r => (r.label === 'NOISE_PURE' || r.label === 'NOISE_MISMATCH') && r.top1_score >= 0.50);
  falsePositives.sort((a, b) => b.top1_score - a.top1_score);

  const comparisons = falsePositives.map(fp => {
    const matched = rows.filter(r => r.label === 'MUSIC' && Math.abs(r.top1_score - fp.top1_score) <= 0.05);
    const compareFeatures = ['best_quant_score', 'best_rhythm_score', 'note_count_filtered', 'top1_minus_top2', 'note_power_mean', 'contour_repetition_ratio'];
    const matchedStats = {};
    for (const f of compareFeatures) matchedStats[f] = describe(matched.map(r => r[f]));
    return {
      window: { sessionId: fp.sessionId, windowIndex: fp.windowIndex, startTime: fp.startTime, top1_name: fp.top1_name, label: fp.label, top1_score: fp.top1_score },
      windowFeatures: Object.fromEntries(compareFeatures.map(f => [f, fp[f]])),
      musicAtSimilarScore: { n: matched.length, stats: matchedStats },
    };
  });

  return { count: falsePositives.length, examples: comparisons.slice(0, 20) };
}

/** NOISE_PURE comes from a single session (732984), while MUSIC/NOISE_MISMATCH
 *  come from the 4 real sessions — a naive leave-one-SESSION-out over all 5
 *  would give every real-session fold's test set zero negative examples
 *  (meaningless AUC/precision/recall: nothing to get wrong). Since there's
 *  only one noise SOURCE to begin with, generalization-across-noise-sources
 *  can't be tested with this dataset regardless of CV scheme — so instead we
 *  split the noise recording into contiguous time-chunks (one per real
 *  session) and pair each chunk with a session, so every fold gets a real
 *  negative test set while still never splitting a real MUSIC session
 *  between train and test (the actual leakage risk the user's spec calls out). */
function assignNoiseChunks(rows, numChunks) {
  const noiseIdx = [];
  rows.forEach((r, i) => { if (r.label === 'NOISE_PURE') noiseIdx.push(i); });
  const chunkSize = Math.ceil(noiseIdx.length / numChunks);
  const chunkOf = new Map();
  noiseIdx.forEach((i, k) => chunkOf.set(i, Math.min(numChunks - 1, Math.floor(k / chunkSize))));
  return chunkOf;
}

function runLOSO(rows) {
  const realSessions = [...new Set(rows.filter(r => r.label !== 'NOISE_PURE').map(r => r.sessionId))];
  const usable = rows.filter(r => r.label === 'MUSIC' || r.label === 'NOISE_PURE');
  const X_all = usable.map(r => FEATURES.map(f => r[f] ?? 0));
  const y_all = usable.map(r => (r.label === 'MUSIC' ? 1 : 0));
  const noiseChunkOf = assignNoiseChunks(usable, realSessions.length);

  const foldResults = [];
  for (let foldIdx = 0; foldIdx < realSessions.length; foldIdx++) {
    const testSession = realSessions[foldIdx];
    const trainIdx = [], testIdx = [];
    usable.forEach((r, i) => {
      const inTestGroup = r.sessionId === testSession || (r.label === 'NOISE_PURE' && noiseChunkOf.get(i) === foldIdx);
      (inTestGroup ? testIdx : trainIdx).push(i);
    });
    if (testIdx.length === 0 || trainIdx.length === 0) continue;
    const y_train = trainIdx.map(i => y_all[i]);
    // Skip degenerate folds (a fold with only one class present in TRAIN can't fit a meaningful classifier).
    if (new Set(y_train).size < 2) { foldResults.push({ testSession, skipped: 'train fold has a single class' }); continue; }

    const X_train_raw = trainIdx.map(i => X_all[i]);
    const X_test_raw = testIdx.map(i => X_all[i]);
    const y_test = testIdx.map(i => y_all[i]);

    const { meanArr, stdArr } = fitStandardizer(X_train_raw);
    const X_train = standardize(X_train_raw, meanArr, stdArr);
    const X_test = standardize(X_test_raw, meanArr, stdArr);

    const logreg = trainLogisticRegression(X_train, y_train);
    const rf = trainRandomForest(X_train_raw, y_train); // trees split on raw values, no standardization needed

    const logregProbs = X_test.map(row => logreg.predictProba(row));
    const rfProbs = X_test_raw.map(row => rf.predictProba(row));

    foldResults.push({
      testSession,
      n_test: testIdx.length,
      n_train: trainIdx.length,
      logreg: { auc: rocAuc(logregProbs.filter((_, i) => y_test[i] === 1), logregProbs.filter((_, i) => y_test[i] === 0)), confusion: confusionAt(y_test, logregProbs) },
      rf: { auc: rocAuc(rfProbs.filter((_, i) => y_test[i] === 1), rfProbs.filter((_, i) => y_test[i] === 0)), confusion: confusionAt(y_test, rfProbs) },
    });
  }

  // Bonus generalization check: train on ALL of MUSIC+NOISE_PURE, then see how
  // the model classifies NOISE_MISMATCH windows it never saw a single example of.
  const { meanArr, stdArr } = fitStandardizer(X_all);
  const X_all_std = standardize(X_all, meanArr, stdArr);
  const logregFull = trainLogisticRegression(X_all_std, y_all);
  const rfFull = trainRandomForest(X_all, y_all);

  const mismatchRows = rows.filter(r => r.label === 'NOISE_MISMATCH');
  const X_mismatch_raw = mismatchRows.map(r => FEATURES.map(f => r[f] ?? 0));
  const X_mismatch_std = standardize(X_mismatch_raw, meanArr, stdArr);
  const logregMismatchProbs = X_mismatch_std.map(row => logregFull.predictProba(row));
  const rfMismatchProbs = X_mismatch_raw.map(row => rfFull.predictProba(row));
  const fractionCorrectlyFlaggedNotMusic = (probs) => probs.filter(p => p < 0.5).length / (probs.length || 1);

  return {
    folds: foldResults,
    generalizationToMismatch: {
      n: mismatchRows.length,
      logreg_fraction_correctly_flagged_not_music: fractionCorrectlyFlaggedNotMusic(logregMismatchProbs),
      rf_fraction_correctly_flagged_not_music: fractionCorrectlyFlaggedNotMusic(rfMismatchProbs),
    },
    logregWeightsFullFit: Object.fromEntries(FEATURES.map((f, i) => [f, logregFull.weights[i]])),
  };
}

/** The realistic/hard task: MUSIC vs NOISE_MISMATCH — confident wrong matches
 *  during REAL pub noise within the real sessions (the "Romanian Fantasy at
 *  0.60 while people are talking" case), as opposed to the trivially-easy
 *  MUSIC vs NOISE_PURE (a single quiet ambience recording). Both classes
 *  exist naturally in every real session, so a plain leave-one-session-out
 *  works with no chunk-pairing trick needed. */
function runLOSOHard(rows) {
  const usable = rows.filter(r => r.label === 'MUSIC' || r.label === 'NOISE_MISMATCH');
  const sessions = [...new Set(usable.map(r => r.sessionId))];
  const X_all = usable.map(r => FEATURES.map(f => r[f] ?? 0));
  const y_all = usable.map(r => (r.label === 'MUSIC' ? 1 : 0));

  const foldResults = [];
  for (const testSession of sessions) {
    const trainIdx = [], testIdx = [];
    usable.forEach((r, i) => (r.sessionId === testSession ? testIdx : trainIdx).push(i));
    if (testIdx.length === 0 || trainIdx.length === 0) continue;
    const y_train = trainIdx.map(i => y_all[i]);
    if (new Set(y_train).size < 2) { foldResults.push({ testSession, skipped: 'train fold has a single class' }); continue; }

    const X_train_raw = trainIdx.map(i => X_all[i]);
    const X_test_raw = testIdx.map(i => X_all[i]);
    const y_test = testIdx.map(i => y_all[i]);

    const { meanArr, stdArr } = fitStandardizer(X_train_raw);
    const X_train = standardize(X_train_raw, meanArr, stdArr);
    const X_test = standardize(X_test_raw, meanArr, stdArr);

    const logreg = trainLogisticRegression(X_train, y_train);
    const rf = trainRandomForest(X_train_raw, y_train);

    const logregProbs = X_test.map(row => logreg.predictProba(row));
    const rfProbs = X_test_raw.map(row => rf.predictProba(row));

    foldResults.push({
      testSession,
      n_test: testIdx.length,
      n_train: trainIdx.length,
      logreg: { auc: rocAuc(logregProbs.filter((_, i) => y_test[i] === 1), logregProbs.filter((_, i) => y_test[i] === 0)), confusion: confusionAt(y_test, logregProbs) },
      rf: { auc: rocAuc(rfProbs.filter((_, i) => y_test[i] === 1), rfProbs.filter((_, i) => y_test[i] === 0)), confusion: confusionAt(y_test, rfProbs) },
    });
  }
  return { folds: foldResults };
}

function main() {
  const rows = loadRows();
  console.log(`Loaded ${rows.length} rows`);

  const featureReport = featureStatsReport(rows);
  console.log('\nTop 10 most discriminative features (MUSIC vs NOISE_PURE, AUC):');
  for (const f of featureReport.perFeature.slice(0, 10)) {
    console.log(`  ${f.feature.padEnd(28)} AUC=${f.auc_music_vs_noise_pure?.toFixed(3)}  music_mean=${f.music?.mean?.toFixed(3)}  noise_mean=${f.noise_pure?.mean?.toFixed(3)}`);
  }

  const caseStudy = caseStudyHighScoreFalsePositives(rows);
  console.log(`\nHigh-score false positives (top1_score>=0.50, label != MUSIC): ${caseStudy.count}`);

  console.log('\nRunning leave-one-session-out cross-validation...');
  const loso = runLOSO(rows);
  for (const f of loso.folds) {
    if (f.skipped) { console.log(`  [${f.testSession}] skipped: ${f.skipped}`); continue; }
    console.log(`  [${f.testSession}] n_test=${f.n_test}  logreg AUC=${f.logreg.auc?.toFixed(3)} P=${f.logreg.confusion.precision?.toFixed(2)} R=${f.logreg.confusion.recall?.toFixed(2)}  |  rf AUC=${f.rf.auc?.toFixed(3)} P=${f.rf.confusion.precision?.toFixed(2)} R=${f.rf.confusion.recall?.toFixed(2)}`);
  }
  console.log(`\nGeneralization to NOISE_MISMATCH (never trained on): logreg flags ${(loso.generalizationToMismatch.logreg_fraction_correctly_flagged_not_music * 100).toFixed(1)}% as not-music, rf flags ${(loso.generalizationToMismatch.rf_fraction_correctly_flagged_not_music * 100).toFixed(1)}%`);

  console.log('\nRunning leave-one-session-out cross-validation on the HARD task (MUSIC vs NOISE_MISMATCH)...');
  const losoHard = runLOSOHard(rows);
  for (const f of losoHard.folds) {
    if (f.skipped) { console.log(`  [${f.testSession}] skipped: ${f.skipped}`); continue; }
    console.log(`  [${f.testSession}] n_test=${f.n_test}  logreg AUC=${f.logreg.auc?.toFixed(3)} P=${f.logreg.confusion.precision?.toFixed(2)} R=${f.logreg.confusion.recall?.toFixed(2)}  |  rf AUC=${f.rf.auc?.toFixed(3)} P=${f.rf.confusion.precision?.toFixed(2)} R=${f.rf.confusion.recall?.toFixed(2)}`);
  }

  const report = { counts: featureReport.counts, perFeature: featureReport.perFeature, caseStudy, loso, losoHard };
  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2));
  console.log(`\nWrote full report to ${REPORT_JSON_PATH}`);
}

main();
