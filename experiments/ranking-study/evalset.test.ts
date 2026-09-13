import { it } from 'vitest';
import * as fs from 'node:fs';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import {
  SESSIONS, NOISE, DIR, loadWindows, buildTimeline, decode,
  type TransitionWeights, type ConfirmRule,
} from './pipeline';
import { loadTruth, scoreSession, matchFor, type TruthEntry } from './truth';
import { ALL_TRANSFORMS } from './transforms';

// ── Replay a list of configurations, session by session ──────────────────────
//
// The campaign files already carry per-session results; this exists for the
// configurations no campaign drew — production itself, and hand-built probes
// around a plateau. Input and output are the same row shape as the campaign's,
// so the analysis reads both without distinction.
//
//   EVAL_IN=configs.json EVAL_OUT=results.json \
//     npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/evalset.test.ts
//
// A config: { transform, flat, floor, minSeg, confirm: 'none' | 'meanx1.50' | 'peakx2.00',
//             weights: { tuneChange, unknownStay, tuneToUnknown, unknownToTune } | {} }
// `confirm` ratios multiply the floor, exactly as in the campaign.

interface Config {
  transform: string; flat: boolean; floor: number; minSeg?: number;
  confirm: string; weights: TransitionWeights; label?: string; topFrac?: number; absentRatio?: number; hold?: { k: number; decay: number };
}

it('replays configurations', () => {
  const inPath = process.env['EVAL_IN'];
  if (!inPath) { console.log('(EVAL_IN absent — rien a rejouer)'); return; }
  const configs = JSON.parse(fs.readFileSync(inPath, 'utf-8')) as Config[];

  const sessions = SESSIONS.map(id => ({ id, windows: loadWindows(id), truth: loadTruth(DIR, id) as TruthEntry[] }));
  const noiseWindows = loadWindows(NOISE);

  const cache = new Map<string, { tls: { s: typeof sessions[number]; tl: ReturnType<typeof buildTimeline> }[]; noiseTl: ReturnType<typeof buildTimeline> }>();
  const out: unknown[] = [];
  const t0 = Date.now();
  for (const c of configs) {
    const key = `${c.transform}|${c.flat}|${JSON.stringify(c.hold ?? null)}`;
    let g = cache.get(key);
    if (!g) {
      const tr = ALL_TRANSFORMS.find(t => t.name === c.transform);
      if (!tr) throw new Error(`transformation inconnue : ${c.transform}`);
      g = {
        tls: sessions.map(s => ({ s, tl: buildTimeline(s.windows, tr, CFG, { flatFilter: c.flat, hold: c.hold }) })),
        noiseTl: buildTimeline(noiseWindows, tr, CFG, { flatFilter: c.flat, hold: c.hold }),
      };
      cache.set(key, g);
    }
    const m = /^(mean|peak)x([\d.]+)$/.exec(c.confirm);
    const confirm: ConfirmRule = m ? { kind: m[1] as 'mean' | 'peak', ratio: c.floor * Number(m[2]) } : { kind: 'none' };
    let found = 0, total = 0, fp = 0;
    const per: number[][] = [];
    const covs: number[] = [];
    // Temporal quality per found tune (added 2026-09-13, user's second goal):
    // coverage alone cannot see a detection spilling into the next tune, IoU can;
    // start / end absolute errors say which boundary is off.
    const ious: number[] = [], startErr: number[] = [], endErr: number[] = [];
    // Per session: [sum of IoU over found tunes, number of found tunes with a span], so a
    // held-out validation can score temporal quality too, not only (found, fp).
    const perT: number[][] = [];
    for (const { s, tl } of g.tls) {
      const segs = decode(tl, CFG, c.floor, c.minSeg, c.weights, confirm, c.topFrac ?? 0, c.absentRatio ?? 0);
      const sc = scoreSession(s.truth, segs);
      found += sc.found; total += sc.total; fp += sc.falsePositives;
      per.push([sc.found, sc.total, sc.falsePositives, sc.misplaced]);
      if (sc.found) covs.push(sc.meanCoverage * sc.found);
      const iouBefore = ious.length;
      perT.push([0, 0]);
      for (const row of s.truth) {
        if (row.kind !== 'tune' || !(row.end > row.start)) continue;
        const hit = matchFor(row, segs);
        if (!hit) continue;
        const inter = Math.max(0, Math.min(hit.endTime, row.end) - Math.max(hit.startTime, row.start));
        const union = Math.max(hit.endTime, row.end) - Math.min(hit.startTime, row.start);
        ious.push(union > 0 ? inter / union : 0);
        startErr.push(Math.abs(hit.startTime - row.start));
        endErr.push(Math.abs(hit.endTime - row.end));
      }
      const added = ious.slice(iouBefore);
      perT[perT.length - 1] = [added.reduce((x, y) => x + y, 0), added.length];
    }
    const qt = (a: number[], p: number) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]!; };
    const temporal = {
      iouMean: ious.length ? ious.reduce((x, y) => x + y, 0) / ious.length : 0,
      startErrP50: qt(startErr, 0.5), startErrP90: qt(startErr, 0.9),
      endErrP50: qt(endErr, 0.5), endErrP90: qt(endErr, 0.9),
    };
    const noise = new Set(decode(g.noiseTl, CFG, c.floor, c.minSeg, c.weights, confirm, c.topFrac ?? 0, c.absentRatio ?? 0).map(s => s.tuneId)).size;
    out.push({ ...c, found, total, fp, noise, coverage: found ? covs.reduce((a, b) => a + b, 0) / found : 0, per, perT, temporal });
    console.log(`  ${c.label ?? c.transform} : ${found}/${total} fp=${fp} bruit=${noise} | ${per.map(p => `${p[0]}/${p[2]}`).join(' ')}`);
  }
  fs.writeFileSync(process.env['EVAL_OUT'] ?? inPath.replace(/\.json$/, '-results.json'), JSON.stringify(out, null, 1), 'utf-8');
  console.log(`${out.length} configurations rejouees en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}, 36_000_000);
