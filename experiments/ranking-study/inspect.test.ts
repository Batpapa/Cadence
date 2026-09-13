import { it } from 'vitest';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import { observationAt } from '../../src/session/recognition/temporalObservationBuilder';
import { SESSIONS, DIR, loadWindows, buildTimeline, decode, rankAt } from './pipeline';
import { loadTruth, overlaps, type TruthEntry } from './truth';
import { ALL_TRANSFORMS, identity } from './transforms';

// ── Why did this stretch fail? ───────────────────────────────────────────────
// The aggregate sweep says WHICH transform wins; this says WHY, window by
// window. It exists because of what the 2026-09-08 dead-zone analysis needed
// and had to be hand-rolled for: not "was the tune detected" but "was the
// evidence ever there, did it survive, and did it ever land on two consecutive
// windows" — the last being the actual gate, since minSegmentWindows is 2.
//
//   INSPECT_SESSION=aprem INSPECT_FROM=50:37 INSPECT_TO=56:41 \
//   INSPECT_TUNES=931,2191,5654 INSPECT_TRANSFORM=nullRatio3 npm run ranking
//
// With no INSPECT_SESSION the test does nothing, so it stays out of the way of
// the sweep.

const parseTime = (v: string): number => {
  const parts = v.split(':').map(Number);
  return parts.reduce((a, n) => a * 60 + n, 0);
};

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

it('inspects one stretch window by window', () => {
  const want = process.env['INSPECT_SESSION'];
  if (!want) { console.log('(INSPECT_SESSION absent — rien a inspecter)'); return; }

  const id = SESSIONS.find(s => s.toLowerCase().includes(want.toLowerCase()));
  if (!id) throw new Error(`aucune session ne correspond a "${want}"`);

  const trName = process.env['INSPECT_TRANSFORM'] ?? 'identity';
  const tr = ALL_TRANSFORMS.find(t => t.name === trName) ?? identity;
  const flatFilter = process.env['INSPECT_FLAT'] !== 'off';
  const floor = Number(process.env['INSPECT_FLOOR'] ?? CFG.unknownObservationProbability);
  const from = parseTime(process.env['INSPECT_FROM'] ?? '0');
  const to = parseTime(process.env['INSPECT_TO'] ?? '99:00:00');
  const targets = (process.env['INSPECT_TUNES'] ?? '').split(',').map(s => s.trim()).filter(Boolean);

  const windows = loadWindows(id);
  const truth: TruthEntry[] = loadTruth(DIR, id);
  const tl = buildTimeline(windows, tr, CFG, { flatFilter });
  const segs = decode(tl, CFG, floor);

  console.log(`\n==== ${id} ====`);
  console.log(`transformation ${tr.name}  |  filtre plat ${flatFilter ? 'on' : 'off'}  |  plancher ${floor}`);
  console.log(`${mmss(from)} -> ${mmss(to)}\n`);

  // Which annotated rows live in the range, and what happened to each.
  console.log('-- verite terrain sur la plage --');
  for (const g of truth) {
    if (g.end <= from || g.start >= to) continue;
    const heard = segs.filter(s => overlaps(s, g)).map(s => `${s.label} (${s.span})`);
    const tag = g.kind === 'tune' ? '' : g.kind === 'offindex' ? ' [hors index]' : ' [non reconnu]';
    console.log(`  ${mmss(g.start)}-${mmss(g.end)}${tag}  ${g.label}`
      + (heard.length ? `  -> ${heard.join(', ')}` : '  -> rien'));
  }

  // What the two gates actually are — and they are not what an early version of
  // this file assumed.
  //
  //  1. Viterbi must EMIT a segment covering the span at all. That is decided by
  //     the emission scores against UNKNOWN plus the transition costs, so sparse
  //     support loses even when each supporting window is strong.
  //  2. `filterShortSegments` then requires `countTop1Windows >= minSegmentWindows`
  //     within that segment — the number of windows where the tune was
  //     FolkFriend's own RANK 1. NOT consecutive: they may sit anywhere in the
  //     segment. (Which also means the ranks carried by `timeline.rows` are
  //     load-bearing in production — the dense field they replaced was labelled
  //     "kept for a V2", which only ever applied to the scoring.)
  //
  // So `leads` below is the quantity gate 2 reads; whether a segment exists at
  // all is shown by the ground-truth block above.
  console.log('\n-- preuve par morceau vise --');
  const T = tl.windows.length;
  for (const tune of targets) {
    if (!tl.rows.has(tune)) { console.log(`  tune ${tune} : ABSENT de l espace d etats (jamais admis)`); continue; }

    let present = 0, leads = 0, clears = 0, inRange = 0;
    const leadTimes: string[] = [];
    for (let t = 0; t < T; t++) {
      const w = tl.windows[t]!;
      if (w.tWindowStart < from || w.tWindowEnd > to) continue;
      inRange++;
      const r = rankAt(tl, tune, t);
      if (r === null) continue;
      present++;
      if (r !== 1) continue;
      leads++;
      const v = observationAt(tl, tune, t);
      leadTimes.push(mmss(w.tWindowStart) + (v > floor ? '*' : ''));
      if (v > floor) clears++;
    }
    const gate2 = leads >= CFG.minSegmentWindows;
    console.log(`  tune ${tune} : ${inRange} fenetres | present ${present} | rang 1 : ${leads}`
      + ` | dont au-dessus du plancher : ${clears}`
      + ` | seuil de confirmation ${gate2 ? 'FRANCHI' : `MANQUE (il en faut ${CFG.minSegmentWindows})`}`);
    if (leadTimes.length) console.log(`      rang 1 a : ${leadTimes.join(' ')}   (* = au-dessus du plancher)`);
  }

  // What the window actually proposed, for eyeballing the shape of the failure.
  if (process.env['INSPECT_VERBOSE']) {
    console.log('\n-- fenetre par fenetre (top 3) --');
    for (let t = 0; t < T; t++) {
      const w = tl.windows[t]!;
      if (w.tWindowStart < from || w.tWindowEnd > to) continue;
      if (!w.candidates.length) { console.log(`  ${mmss(w.tWindowStart)}  (blanchie)`); continue; }
      const top = w.candidates.slice(0, 3)
        .map(c => `${c.displayName.slice(0, 22)}=${c.score.toFixed(3)}`).join('  ');
      console.log(`  ${mmss(w.tWindowStart)}  ${top}`);
    }
  }
}, 900_000);
