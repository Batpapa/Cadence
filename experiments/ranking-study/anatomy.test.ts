import { it } from 'vitest';
import * as fs from 'node:fs';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import { countTop1Windows } from '../../src/session/recognition/viterbiDetector';
import {
  SESSIONS, DIR, loadWindows, buildTimeline, decode, type ConfirmRule,
} from './pipeline';
import { loadTruth, overlaps, matchFor, type TruthEntry } from './truth';
import { ALL_TRANSFORMS } from './transforms';

// ── What are the false positives and the misses, one by one? ─────────────────
//
// The campaign optimises two counts. Whether the next gain lives in the decoder
// or in the engine depends on what those counts are made of:
//
//  - a false positive sitting INSIDE an annotated tune is an identity confusion
//    during real music — FolkFriend preferred a wrong tune, and only a better
//    ranking can fix it;
//  - one sitting in no annotated span is a phantom in talk, tuning or silence —
//    the null model's job, i.e. the floor, the transforms and the gate.
//
// For each miss, the rung it reached in the candidate lists (see ceiling.test.ts)
// and what was reported over its span instead.
//
//   ANATOMY=v3/prod.json npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/anatomy.test.ts
// Reads the FIRST configuration of the file (evalset format).

const mmss = (s: number): string => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

it('dissects false positives and misses', () => {
  const file = process.env['ANATOMY'];
  if (!file) { console.log('(ANATOMY absent)'); return; }
  const path = file.includes(':') || file.startsWith('/') ? file : `${__dirname}/${file}`;
  const c = (JSON.parse(fs.readFileSync(path, 'utf-8')) as Record<string, unknown>[])[Number(process.env['ANATOMY_INDEX'] ?? 0)]! as {
    transform: string; flat: boolean; floor: number; minSeg?: number; confirm: string;
    weights: Record<string, number>; topFrac?: number; label?: string;
  };
  const tr = ALL_TRANSFORMS.find(t => t.name === c.transform)!;
  const m = /^(mean|peak)x([\d.]+)$/.exec(c.confirm);
  const confirm: ConfirmRule = m ? { kind: m[1] as 'mean' | 'peak', ratio: c.floor * Number(m[2]) } : { kind: 'none' };
  console.log(`configuration : ${c.label ?? JSON.stringify(c)}`);

  const fpKinds = { inTune: 0, inOffindex: 0, outside: 0 };
  for (const id of SESSIONS) {
    const ws = loadWindows(id);
    const truth: TruthEntry[] = loadTruth(DIR, id);
    const tunes = truth.filter(g => g.kind === 'tune');
    const tl = buildTimeline(ws, tr, CFG, { flatFilter: c.flat });
    const segs = decode(tl, CFG, c.floor, c.minSeg, c.weights, confirm, c.topFrac ?? 0);
    const idx = (t: number) => tl.windows.findIndex(w => w.tWindowStart >= t - 1e-6);

    console.log(`\n==== ${id} ====`);
    // False positives, per SEGMENT (the score counts distinct ids).
    const excused = (s: typeof segs[number]) => truth.some(g => g.kind === 'unknown' && overlaps(s, g));
    for (const s of segs) {
      if (tunes.some(g => g.ids.has(s.tuneId)) || excused(s)) continue;
      const i0 = idx(s.startTime);
      const wc = Math.max(1, tl.windows.filter(w => w.tWindowStart >= s.startTime - 1e-6 && w.tWindowStart < s.endTime - 1e-6).length);
      const n1 = i0 >= 0 ? countTop1Windows(s.tuneId, i0, wc, tl) : -1;
      const under = truth.filter(g => overlaps(s, g));
      const where = under.length
        ? under.map(g => (g.kind === 'tune' ? `pendant ${[...g.ids][0]}` : g.kind)).join(',')
        : 'hors annotation';
      if (under.some(g => g.kind === 'tune')) fpKinds.inTune++;
      else if (under.some(g => g.kind === 'offindex')) fpKinds.inOffindex++;
      else fpKinds.outside++;
      console.log(`  FP  ${s.tuneId.padStart(5)} ${mmss(s.startTime)}-${mmss(s.endTime)} ${String(wc).padStart(3)} fen. rang1=${n1}  ${where}  (${s.label})`);
    }
    // Misses.
    for (const g of tunes) {
      if (matchFor(g, segs)) continue;
      const tid = [...g.ids][0]!;
      const inSpan = ws.filter(w => { const x = (w.tWindowStart + w.tWindowEnd) / 2; return x >= g.start && x <= g.end; });
      const ranks = inSpan.map(w => { const k = w.candidates.findIndex(cd => cd.tuneId === tid); return k < 0 ? 0 : k + 1; });
      const n1 = ranks.filter(r => r === 1).length;
      const top = ranks.filter(r => r > 0).length;
      const instead = segs.filter(s => overlaps(s, g)).map(s => s.tuneId);
      console.log(`  RATE ${tid.padStart(5)} ${mmss(g.start)}-${mmss(g.end)} ${String(inSpan.length).padStart(3)} fen. top10=${top} rang1=${n1} rangs=[${ranks.join(' ')}] -> ${instead.length ? instead.join(',') : 'rien'}`);
    }
  }
  console.log(`\nsegments FP : pendant un morceau annote ${fpKinds.inTune}, sur hors-index ${fpKinds.inOffindex}, hors annotation ${fpKinds.outside}`);
}, 600_000);
