// The tempo saved with each detection of a file analysis (2026-11-01).
//
// What an import does, as far as Node can do it: the production detector on
// the windows of the annotated sessions (the windows the engine itself made,
// test-fixtures/sessions/*-windows.json), then the app's tempo tracker on the
// audio and the app's own withTempo — each detection's median pulse. Truths
// as in bench.mjs: whole passes over the annotated span (the user's), and the
// offline alignment (../score-follow/output/real.json).
//
// The tempo saved is read inside each detection (liveTempo.ts's tempoInside,
// since 2026-11-02). Against the rule before — the median of the tracker's
// readings 12 s into the detection — on the same 337 detections: a tempo on
// all of them instead of 90.5 %; within 4 % of the alignment on 94.9 % of
// 256 instead of 96.7 % of 245; on those same 245, 95.9 %; on the 11 the old
// rule had nothing for, 72.7 %.
//
// A difference with the app, small: the bounds are the decoder's, not yet put
// on the passes (boundSuggest.ts).
//
//   npx vitest run --config experiments/tempo/vitest.config.ts      (from Cadence/)
import { it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { IncrementalViterbiSegmenter } from '../../src/session/recognition/viterbiSegmenter';
import { DetectionTracker } from '../../src/session/detectionState';
import { Novelty, tempoInside, insideRate } from '../../src/session/liveTempo';
import { HOP_S_IMPORT } from '../../src/session/sessionConfig';
import type { Detection, WindowResult } from '../../src/session/model';

const require = createRequire(import.meta.url);
const { featuresOf, decodeSpan } = require('../score-follow/lib/engine');
const { FPS } = require('../score-follow/lib/align');

const ROOT = path.resolve(__dirname, '../..');
const AUDIO: Record<string, string> = {
  '20260523_1_matin_Anglade': '20260523_1_matin_Anglade.m4a',
  '20260523_2_aprem_tabac': '20260523_2_aprem_tabac.m4a',
  '20260523_5_auberge_fleurie': '20260523_5_auberge_fleurie.m4a',
  '20240721_tocane_2_chapiteau': '20240721_tocane_2_chapiteau.m4a',
  '1Hour_Trad_Irish_Music_Session_in_Korea': '1Hour Trad Irish Music Session in Korea.mp3',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video': 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video.mp3',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24': '13th Moon Gravity Well - Irish Trad Session 2024.01.24.mp3',
};

const secs = (s: string) => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
const pct = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const share = <T>(xs: T[], f: (x: T) => boolean) => (xs.length ? (100 * xs.filter(f).length) / xs.length : NaN).toFixed(1) + '%';

interface Aligned { fixture: string; tuneId: string; name: string; dance: string; span: number; len: number; match: number; passDurs: number[]; onsets: [number, number][] }
const real: Aligned[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../score-follow/output/real.json'), 'utf8'));

interface Row { fixture: string; name: string; dance: string; seconds: number; rate: number | null; approx: boolean; weak: boolean; passTruth: number | null; aligned: number | null; matched: boolean }

/** The alignment's own rate over a tune, as bench.mjs reads it: the median of
 *  its local rates — the slope of quavers over time in each 12 s, every 3 s,
 *  leaving out the windows where it jumps (back, or more than four quavers
 *  on). Over the whole tune at once, a stretch it followed at a wrong pace
 *  weighed in full: Miss Thornton's came out at 267 instead of 230. */
function alignedRate(r: Aligned): number | null {
  const on = r.onsets;
  if (on.length < 20) return null;
  const rates: number[] = [];
  for (let end = on[0]![0] + 12; end <= on[on.length - 1]![0]; end += 3) {
    const inW = on.filter(([t]) => t >= end - 12 && t < end);
    if (inW.length < 24) continue;
    let q = 0, bad = false;
    const pts: [number, number][] = [[inW[0]![0], 0]];
    for (let j = 1; j < inW.length; j++) {
      let d = inW[j]![1] - inW[j - 1]![1];
      if (d <= 0) d += r.len;
      if (d > 4) { bad = true; break; }
      q += d;
      pts.push([inW[j]![0], q]);
    }
    if (bad) continue;
    const mt = pts.reduce((s, p) => s + p[0], 0) / pts.length, mq = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    rates.push(pts.reduce((s, p) => s + (p[0] - mt) * (p[1] - mq), 0) / pts.reduce((s, p) => s + (p[0] - mt) ** 2, 0));
  }
  return rates.length ? pct(rates, 0.5) : null;
}

it('tempo of the detections of a file analysis', () => {
  const rows: Row[] = [];
  let audioS = 0, tempoMs = 0, featureMs = 0;
  for (const [fixture, audioName] of Object.entries(AUDIO)) {
    const audio = path.join(ROOT, 'test-fixtures/audio', audioName);
    const csvPath = path.join(ROOT, 'test-fixtures/sessions', fixture + '-timings.csv');
    if (!fs.existsSync(audio) || !fs.existsSync(csvPath)) continue;
    const windows: WindowResult[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-fixtures/sessions', fixture + '-windows.json'), 'utf8'));
    const segmenter = new IncrementalViterbiSegmenter(HOP_S_IMPORT);
    const tracker = new DetectionTracker();
    tracker.apply(segmenter.feedAll(windows));
    tracker.finish(segmenter.finalize());
    const detections = tracker.list();

    const annotations = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(','))
      .filter(([, , id]) => Number(id) > 0).map(([a, b, id]) => ({ start: secs(a!), end: secs(b!), tuneId: id! }));
    const aligned = real.filter(r => r.fixture === fixture);

    for (const d of detections) {
      // The novelty inside this detection, as the app keeps it, and its tempo
      // read inside its bounds (tempoInside).
      const from = d.start, to = d.end ?? d.start;
      const t0 = Date.now();
      const F: Float32Array = featuresOf(decodeSpan(audio, from, to - from));
      const t1 = Date.now();
      const inside = insideRate(tempoInside(new Novelty().of(F), FPS, from, d.start, to));
      tempoMs += Date.now() - t1;
      featureMs += t1 - t0;
      audioS += to - from;

      // The annotated tune it stands on: same tune, most overlap.
      let best: { start: number; end: number; tuneId: string } | null = null, bestOverlap = 0;
      for (const a of annotations) {
        const o = Math.min(a.end, to) - Math.max(a.start, d.start);
        if (a.tuneId === d.tuneId && o > bestOverlap) { best = a; bestOverlap = o; }
      }
      const r = best ? aligned.find(x => x.tuneId === best!.tuneId && Math.abs(x.span - (best!.end - best!.start)) < 0.01 && x.match >= 0.6) : undefined;
      const passTruth = r && best && r.passDurs.length ? (Math.round((best.end - best.start) / pct(r.passDurs, 0.5)) * r.len) / (best.end - best.start) : null;
      rows.push({ fixture, name: d.displayName, dance: d.dance, seconds: to - d.start, rate: inside?.rate ?? null, approx: inside?.approx ?? false, weak: inside?.weak ?? false, passTruth, aligned: r ? alignedRate(r) : null, matched: !!best });
    }
    process.stderr.write(`${fixture}: ${detections.length} detections\n`);
  }

  const err = (a: number, b: number) => Math.abs(a / b - 1);
  console.log(`
windows inside the detection: approx ("~", shorter than the window) on ${rows.filter(x => x.approx).length}`);
  const within = (xs: Row[]) => `${xs.filter(x => x.rate !== null && x.aligned !== null).length} ` + share(xs.filter(x => x.rate !== null && x.aligned !== null), x => Math.abs(x.rate! / x.aligned! - 1) < 0.04);
  console.log(`weak ("~" on the live screen, too few windows with a clear pulse) on ${rows.filter(x => x.weak).length}; within 4 % of the alignment: weak ${within(rows.filter(x => x.weak))}, the others ${within(rows.filter(x => !x.weak))}`);
  console.log(`\n${rows.length} detections; a tempo saved on ${share(rows, x => x.rate !== null)}`);
  console.log(`  of the right tune (an annotated span of the same tune under it): ${rows.filter(x => x.matched).length}, tempo on ${share(rows.filter(x => x.matched), x => x.rate !== null)}`);
  console.log(`  of no annotated tune (wrong tune, unknown tune, talk): ${rows.filter(x => !x.matched).length}, tempo on ${share(rows.filter(x => !x.matched), x => x.rate !== null)}`);
  const vsAligned = rows.filter(x => x.rate !== null && x.aligned !== null);
  console.log(`\nagainst the alignment (${vsAligned.length} detections): within 2 / 4 / 8 %:`, [0.02, 0.04, 0.08].map(e => share(vsAligned, x => err(x.rate!, x.aligned!) < e)).join(' / '));
  const solid = rows.filter(x => x.rate !== null && x.passTruth !== null && x.aligned !== null && err(x.aligned, x.passTruth) < 0.02);
  console.log(`against whole passes, where the alignment agrees within 2 % (${solid.length}): within 2 / 4 / 8 %:`, [0.02, 0.04, 0.08].map(e => share(solid, x => err(x.rate!, x.passTruth!) < e)).join(' / '));
  for (const d of [...new Set(vsAligned.map(x => x.dance))].sort()) {
    const s = vsAligned.filter(x => x.dance === d);
    console.log(`  ${d.padEnd(10)} ${String(s.length).padStart(4)}  within 4 % ${share(s, x => err(x.rate!, x.aligned!) < 0.04).padStart(6)}  ratio p10/50/90 ${[0.1, 0.5, 0.9].map(p => pct(s.map(x => x.rate! / x.aligned!), p).toFixed(2)).join(' ')}`);
  }
  if (process.env.LIST) for (const x of vsAligned.filter(x => err(x.rate!, x.aligned!) >= 0.04)) console.log(`  ✗ ${x.fixture.slice(0, 18)} ${x.name.slice(0, 28).padEnd(28)} ${x.dance.padEnd(9)} saved ${(x.rate! * 30).toFixed(0)} aligned ${(x.aligned! * 30).toFixed(0)} passes ${x.passTruth ? (x.passTruth * 30).toFixed(0) : '-'} (crotchets/min)`);
  console.log(`\ncost, Node, this PC: features ${(featureMs / (audioS / 60)).toFixed(0)} ms and tracker ${(tempoMs / (audioS / 60)).toFixed(0)} ms a minute of audio (${(audioS / 60).toFixed(0)} min; features include ffmpeg's decoding)`);
}, 3_600_000);
