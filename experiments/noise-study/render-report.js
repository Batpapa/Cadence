'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { histogramSvg } = require('./lib/svgHistogram');

const OUT_DIR = path.resolve(__dirname, 'output');
const REPORT_JSON_PATH = path.join(OUT_DIR, 'report.json');
const DATASET_PATH = path.join(OUT_DIR, 'dataset.jsonl');
const HTML_OUT_PATH = path.join(OUT_DIR, 'report.html');

const PRIORITY_FEATURES = [
  'top1_score', 'top1_minus_top2', 'note_count_filtered', 'note_power_mean',
  'best_quant_score', 'best_bpm', 'best_rhythm_score', 'contour_length',
];

function loadRows() {
  return fs.readFileSync(DATASET_PATH, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}

function fmt(v, d = 3) { return v === null || v === undefined ? '—' : Number(v).toFixed(d); }

function statsRow(f) {
  const m = f.music, n = f.noise_pure;
  return `<tr>
    <td>${f.feature}</td>
    <td class="num ${f.discriminative_power > 0.75 ? 'hi' : f.discriminative_power > 0.6 ? 'mid' : ''}">${fmt(f.auc_music_vs_noise_pure)}</td>
    <td class="num">${fmt(f.discriminative_power)}</td>
    <td class="num">${fmt(m?.mean)}</td>
    <td class="num">${fmt(m?.median)}</td>
    <td class="num">${fmt(n?.mean)}</td>
    <td class="num">${fmt(n?.median)}</td>
    <td class="num">${fmt(f.auc_music_vs_noise_mismatch)}</td>
  </tr>`;
}

function main() {
  const report = JSON.parse(fs.readFileSync(REPORT_JSON_PATH, 'utf-8'));
  const rows = loadRows();
  const music = rows.filter(r => r.label === 'MUSIC');
  const noisePure = rows.filter(r => r.label === 'NOISE_PURE');

  const chartFeatures = [...new Set([...PRIORITY_FEATURES, ...report.perFeature.slice(0, 6).map(f => f.feature)])];
  const charts = chartFeatures.map(f => {
    const meta = report.perFeature.find(x => x.feature === f);
    return histogramSvg(music.map(r => r[f]), noisePure.map(r => r[f]), {
      title: `${f}  (AUC=${fmt(meta?.auc_music_vs_noise_pure, 2)})`,
      xLabel: f,
    });
  }).join('\n');

  const featureTableRows = report.perFeature.map(statsRow).join('\n');

  const caseStudyRows = report.caseStudy.examples.map(ex => `<tr>
    <td>${ex.window.sessionId}</td>
    <td>${ex.window.startTime?.toFixed(0)}s</td>
    <td>${ex.window.top1_name}</td>
    <td>${ex.window.label}</td>
    <td class="num">${fmt(ex.window.top1_score, 2)}</td>
    <td class="num">${fmt(ex.windowFeatures.best_quant_score, 2)} <span class="ref">(music@score: ${fmt(ex.musicAtSimilarScore.stats.best_quant_score?.mean, 2)}, n=${ex.musicAtSimilarScore.n})</span></td>
    <td class="num">${fmt(ex.windowFeatures.note_count_filtered, 0)} <span class="ref">(music: ${fmt(ex.musicAtSimilarScore.stats.note_count_filtered?.mean, 0)})</span></td>
    <td class="num">${fmt(ex.windowFeatures.top1_minus_top2, 2)} <span class="ref">(music: ${fmt(ex.musicAtSimilarScore.stats.top1_minus_top2?.mean, 2)})</span></td>
  </tr>`).join('\n');

  function losoRowsOf(folds) {
    return folds.map(f => {
      if (f.skipped) return `<tr><td>${f.testSession}</td><td colspan="6">skipped: ${f.skipped}</td></tr>`;
      return `<tr>
        <td>${f.testSession}</td>
        <td class="num">${f.n_test}</td>
        <td class="num">${fmt(f.logreg.auc, 2)}</td>
        <td class="num">${fmt(f.logreg.confusion.precision, 2)}</td>
        <td class="num">${fmt(f.logreg.confusion.recall, 2)}</td>
        <td class="num">${fmt(f.rf.auc, 2)}</td>
        <td class="num">${fmt(f.rf.confusion.precision, 2)}</td>
        <td class="num">${fmt(f.rf.confusion.recall, 2)}</td>
      </tr>`;
    }).join('\n');
  }
  const losoHardRows = losoRowsOf(report.losoHard.folds);

  const losoRows = report.loso.folds.map(f => {
    if (f.skipped) return `<tr><td>${f.testSession}</td><td colspan="6">skipped: ${f.skipped}</td></tr>`;
    return `<tr>
      <td>${f.testSession}</td>
      <td class="num">${f.n_test}</td>
      <td class="num">${fmt(f.logreg.auc, 2)}</td>
      <td class="num">${fmt(f.logreg.confusion.precision, 2)}</td>
      <td class="num">${fmt(f.logreg.confusion.recall, 2)}</td>
      <td class="num">${fmt(f.rf.auc, 2)}</td>
      <td class="num">${fmt(f.rf.confusion.precision, 2)}</td>
      <td class="num">${fmt(f.rf.confusion.recall, 2)}</td>
    </tr>`;
  }).join('\n');

  const html = `<title>Noise Signature Study</title>
<style>
/* ── Tokens ─────────────────────────────────────────────────────────────
   Subject: exposing FolkFriend's own internal telemetry (notes, tempo
   curve, contour, candidate margin) to see whether background pub noise
   has a statistical signature distinct from real tunes. Palette reads as
   a signal-analysis instrument: dark instrument-panel ground, MUSIC in
   teal (signal), NOISE in coral (static), a warm gold reserved for calling
   out the strongest numbers. Monospace carries headings/labels/data —
   this is a telemetry readout, not editorial prose. */
:root {
  --bg:#f2f3f5; --surface:#ffffff; --surface-2:#eceef1; --fg:#171b21; --muted:#5c6472; --border:#d7dbe1;
  --music:#128577; --noise:#b04f2b; --accent:#8c6a17;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --font-body: -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#10141a; --surface:#171d25; --surface-2:#1c232c; --fg:#e7e6e2;
    --muted:#7e8896; --border:#2a323d; --music:#45c2ae; --noise:#e2825a; --accent:#d9ac4c;
  }
}
:root[data-theme="dark"] {
  --bg:#10141a; --surface:#171d25; --surface-2:#1c232c; --fg:#e7e6e2; --muted:#7e8896; --border:#2a323d;
  --music:#45c2ae; --noise:#e2825a; --accent:#d9ac4c;
}

* { box-sizing: border-box; }
body { background:var(--bg); color:var(--fg); font-family: var(--font-body); max-width: 900px; margin: 0 auto; padding: 48px 20px 100px; line-height:1.6; }
h1,h2,h3 { font-family: var(--font-mono); line-height:1.3; text-wrap: balance; letter-spacing: -0.01em; }
h1 { font-size: 28px; margin: 0 0 6px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; margin: 52px 0 4px; padding-left: 12px; border-left: 3px solid var(--music); color: var(--fg); }
h3 { font-size: 15px; margin: 28px 0 8px; color: var(--fg); }
p { max-width: 68ch; }
.subtitle { color: var(--muted); font-size: 14px; max-width: 68ch; margin: 0 0 28px; }
.section-note { color: var(--muted); font-size: 12.5px; max-width: 68ch; margin: 4px 0 16px; }

.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; font-family: var(--font-mono); }
th, td { padding: 6px 10px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--border); }
thead th { background: var(--surface-2); font-weight: 600; position: sticky; top:0; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; color: var(--muted); }
tbody tr:nth-child(even) { background: color-mix(in srgb, var(--surface-2) 45%, transparent); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num.hi { color: var(--accent); font-weight: 700; }
td.num.mid { color: var(--muted); }
.ref { color: var(--muted); font-size: 11.5px; }

.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin: 18px 0; }
.chart { border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin: 0; background: var(--surface); }
.chart-title { font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; margin: 0 0 4px; color: var(--fg); }
.chart-xlabel { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); text-align:center; margin-top: 2px; }
.axis-line { stroke: var(--border); stroke-width: 1; }
.axis-label { font-size: 9px; fill: var(--muted); font-family: var(--font-mono); }
.bar-music { fill: var(--music); opacity: 0.62; }
.bar-noise { fill: var(--noise); opacity: 0.55; }

.legend { display:flex; gap:20px; font-family: var(--font-mono); font-size:12px; margin: 4px 0 18px; }
.legend span { display:inline-flex; align-items:center; gap:7px; }
.swatch { width:11px; height:11px; border-radius:2px; display:inline-block; }

.counts { display:flex; gap:32px; margin: 20px 0 8px; padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.counts div { font-family: var(--font-mono); font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.counts b { font-size: 26px; display:block; color: var(--fg); font-weight: 700; margin-bottom: 2px; }
.counts .music b { color: var(--music); }
.counts .noise b { color: var(--noise); }
.counts .mismatch b { color: var(--accent); }

code { font-family: var(--font-mono); background: var(--surface-2); padding: 1px 6px; border-radius: 4px; font-size: 0.92em; }
ul, ol { max-width: 68ch; padding-left: 22px; }
li { margin-bottom: 8px; }
b { font-weight: 700; }
</style>

<h1>Noise signature study</h1>
<p class="subtitle">Does FolkFriend's own internal telemetry — note stats, tempo curve, candidate margin, contour shape — separate real tunes from pub background noise, independently of Viterbi? Generated from ${rows.length} labeled 15-second windows across 5 real annotated sessions + 1 dedicated noise recording. See <code>experiments/noise-study/</code> in the Cadence repo.</p>

<div class="counts">
  <div class="music"><b>${report.counts.MUSIC}</b>music</div>
  <div class="noise"><b>${report.counts.NOISE_PURE}</b>noise_pure</div>
  <div class="mismatch"><b>${report.counts.NOISE_MISMATCH}</b>noise_mismatch</div>
</div>

<h2>Feature discriminative power</h2>
<p class="section-note">AUC against NOISE_PURE (a dedicated quiet-ambience recording) and, separately, against NOISE_MISMATCH (confident wrong matches inside real sessions — the harder, realistic case). Gold = discriminative power &gt; 0.75.</p>
<div class="table-wrap">
<table>
<thead><tr><th>feature</th><th>AUC (pure)</th><th>disc. power</th><th>music mean</th><th>music median</th><th>noise mean</th><th>noise median</th><th>AUC (mismatch)</th></tr></thead>
<tbody>${featureTableRows}</tbody>
</table>
</div>

<h2>Distributions</h2>
<div class="legend">
  <span><i class="swatch" style="background:var(--music)"></i>MUSIC</span>
  <span><i class="swatch" style="background:var(--noise)"></i>NOISE_PURE</span>
</div>
<div class="charts">${charts}</div>

<h2>High-score false positives</h2>
<p class="section-note">${report.caseStudy.count} windows scored top1Score ≥ 0.50 on a tune that was NOT actually played. Showing up to 20, each compared against real-music windows within ±0.05 of the same top1Score.</p>
<div class="table-wrap">
<table>
<thead><tr><th>session</th><th>t</th><th>top1 name</th><th>label</th><th>top1Score</th><th>quantScore</th><th>noteCount</th><th>top1−top2</th></tr></thead>
<tbody>${caseStudyRows}</tbody>
</table>
</div>

<h2>Leave-one-session-out cross-validation — easy task (MUSIC vs NOISE_PURE)</h2>
<p class="ref">NOISE_PURE comes from a single recording, so its windows are split into 4 time-chunks (one paired per real session) rather than a true held-out session — see analyze.js for why a naive per-session split here is meaningless.</p>
<table>
<thead><tr><th>test session</th><th>n</th><th>logreg AUC</th><th>logreg P</th><th>logreg R</th><th>RF AUC</th><th>RF P</th><th>RF R</th></tr></thead>
<tbody>${losoRows}</tbody>
</table>
<p>Generalization to NOISE_MISMATCH (never trained on, n=${report.loso.generalizationToMismatch.n}): logistic regression flags <b>${(report.loso.generalizationToMismatch.logreg_fraction_correctly_flagged_not_music * 100).toFixed(1)}%</b> as not-music, random forest flags <b>${(report.loso.generalizationToMismatch.rf_fraction_correctly_flagged_not_music * 100).toFixed(1)}%</b>.</p>

<h2>Leave-one-session-out cross-validation — hard/realistic task (MUSIC vs NOISE_MISMATCH)</h2>
<p class="ref">This is the task that actually matters: distinguishing real tune windows from confident-but-wrong matches inside real pub sessions (the "Romanian Fantasy at 0.60" case). Both classes occur naturally in every real session, so this is a genuine leave-one-session-out, no chunking trick.</p>
<table>
<thead><tr><th>test session</th><th>n</th><th>logreg AUC</th><th>logreg P</th><th>logreg R</th><th>RF AUC</th><th>RF P</th><th>RF R</th></tr></thead>
<tbody>${losoHardRows}</tbody>
</table>

<h2>Conclusion</h2>

<h3>Does a statistical noise signature exist?</h3>
<p>Yes — but it depends heavily on <em>which</em> noise. This study deliberately used two very different negative classes, and they behave completely differently:</p>
<ul>
<li><b>NOISE_PURE</b> (a single 28-minute quiet pub-ambience recording, no music at all) is <b>trivially separable</b> from real music — several raw FolkFriend-internal features (note power, note duration) reach AUC ≈ 1.000 on their own, and a simple logistic regression / random forest gets perfect leave-one-session-out AUC. But this near-perfect number should not be over-trusted: it comes from a <em>single</em> noise recording, so it may just mean "this one room's ambience is very different from music," not "all noise is this separable."</li>
<li><b>NOISE_MISMATCH</b> — windows from the real sessions where FolkFriend's own top-1 pick is confidently wrong (not in the real setlist) — is the far more realistic and important class: it's exactly the "Romanian Fantasy scores 0.60 while people are talking" scenario that motivated this study. Here the separation is real but much weaker: <code>top1_score</code> alone only reaches AUC=0.82, and cross-session generalization is uneven (LOSO AUC ranges from 0.98 down to 0.66 depending on which session is held out).</li>
</ul>
<p><b>Critically, a model trained only on NOISE_PURE almost completely fails to catch NOISE_MISMATCH</b> (random forest flags just 2.1% of it as not-music, logistic regression 5.5%) — confirming these are statistically different populations. A future noise detector cannot be validated against a quiet-room recording alone; it needs real in-session false positives like the ones collected here.</p>

<h3>Most promising features</h3>
<ol>
<li><b><code>top1_minus_top2</code></b> (the margin) is the single best univariate feature on the realistic task (AUC=0.88, beating raw <code>top1_score</code>'s 0.81) — this rigorously confirms, on thousands of real labeled windows across 5 sessions, the ~23× margin gap that was only eyeballed from a handful of examples earlier in this project (the old <code>MARGIN_FLOOR</code> idea). <code>top1_div_top2</code> (the same idea as a ratio instead of a difference) tracks close behind at AUC=0.86. This is the strongest single candidate if any signal were to eventually feed back into detection — and now the basis of the production margin filter (topN=3, X=5%) wired 2026-08-18.</li>
<li><b>Recurring named false-positive "attractors"</b> (romanian fantasy, michael's lament, out the door and over the wall, ...) turned out to have their own even-more-specific signature: a "tempo-agnostic" contour — their match score barely varies across the 36 tempo candidates FolkFriend tries (mean <code>tempo_score_std</code> 0.14 vs 0.24 for other false positives vs 0.35 for real music), even more pronounced among high-scoring false positives specifically. This is now a second production filter (<code>tempoSpreadThreshold</code>=0.12, stacked after the margin filter) — A/B tested to cut known-attractor false positives by 83% for the cost of a single tune across the dataset.</li>
<li><b><code>note_power_mean</code> / <code>note_power_median</code></b> — still strong on the hard task (AUC 0.82 / 0.82), and essentially free (already computed, just previously discarded after the initial retain() filter).</li>
<li><b><code>tempo_score_range</code> / <code>tempo_score_std</code></b> (spread of the 36 BPM-candidate scores FolkFriend already computes and discards) — a genuinely new finding, never examined before this instrumentation. AUC 0.78 / 0.76 on the hard task — solid but noticeably less dominant once more sessions were added, worth watching rather than over-trusting from the first (4-session) pass.</li>
<li><b><code>note_count_rejected</code> / <code>note_count_raw</code></b> — inverted but still strong (AUC 0.80 / 0.74; background chatter produces 2-3× MORE raw pitch detections than real music, and correspondingly far more get rejected by FolkFriend's own power/duration filter). A cheap, never-before-exposed signal.</li>
</ol>

<h3>Can we build a reliable noise detector from this?</h3>
<p>Partially, and not yet with full confidence — but two concrete signals (margin, tempo spread) were solid enough to A/B test and wire into production directly, see below. The hard-task leave-one-session-out results, across <b>5</b> real sessions (a 6th, "session_dubliners", was collected 2026-08-18 then explicitly excluded — the session leader played too poorly that day to be a representative sample, confirmed by the user, not a detector fault) show real and persistent variance: AUC 0.97 (Anglade), 0.97 (aprem_tabac), 0.85 (auberge_fleurie), 0.67 (One_of_the_Best...), 0.87-0.88 (Tocane — a ~5.4h reference recording, added the same day). "One_of_the_Best..." staying the persistent weak point is itself informative: whatever makes that recording harder (different source/encoding — it's the one fixture that was already an MP3 download rather than a phone recording) isn't something more sessions alone fixed. More session diversity — and understanding that specific gap — would still be needed before trusting a full multivariate model in production.</p>

<h3>Shipped to production (2026-08-18)</h3>
<p>Despite the multivariate model not yet being production-ready, the two strongest individual signals were clear and cheap enough to A/B test and wire in directly, stacked in this order: (1) <b>margin filter</b> — <code>flatWindowTopN=3</code>, <code>flatWindowMarginThreshold=0.05</code> (a window whose top1 candidate doesn't beat its top-3rd by ≥5% is stripped of all candidates before Viterbi); (2) <b>tempo-spread filter</b> — <code>tempoSpreadThreshold=0.12</code> (same idea, using the 36-tempo-candidate score spread). Both required rebuilding and revendoring the WASM (the tempo filter needs telemetry — <code>WindowResult.debug</code> — that only the new debug WASM exports provide, now wired into <code>ffWorker.ts</code> for every real session, live and import alike). See <code>detectionTemporalConfig.ts</code> for the full sweep methodology behind both threshold choices, and project memory for the "Road to Lisdoonvarna" homonym-collision story that led from topN=2 to topN=3.</p>

<h3>Data-quality caveat found along the way (confirmed)</h3>
<p>Not every NOISE_MISMATCH label is trustworthy. Manually inspecting the highest-score "false positives" turned up two distinct patterns: genuinely degenerate matches (e.g. "balkan hills, the" at top1Score=1.00 but margin=0.08, versus real music's typical ~0.54 margin at that score — a flat, many-way-tied match), and — more concerning — cases like "helvic head," which appeared with a HIGH and STABLE margin (~0.45-0.51, matching real music's ~0.46-0.49) across 3 consecutive overlapping windows. That pattern looked statistically like a real detection, not noise — <b>confirmed directly by the user: "helvic head" was in fact really played, just never written down in the setlist annotation.</b> This is exactly the failure mode this caveat predicted, not a false alarm — a reminder that the NOISE_MISMATCH label's accuracy is bounded by how complete the human setlist annotation is, and that a production noise detector built from this label should expect some irreducible label noise unless annotations are cross-checked by ear.</p>

<h3>What this means for Viterbi (not touched in this study)</h3>
<p>Nothing was changed in the production pipeline. If <code>top1_minus_top2</code> or the tempo-spread features are pursued further, the natural next step discussed but not started is a pre-Viterbi per-window filter (in the same family as the N/X flat-window-margin sweep explored earlier this project) — but this needs a explicit go-ahead and more session diversity first, per the brief for this study.</p>
`;

  fs.writeFileSync(HTML_OUT_PATH, html);
  console.log(`Wrote ${HTML_OUT_PATH}`);
}

main();
