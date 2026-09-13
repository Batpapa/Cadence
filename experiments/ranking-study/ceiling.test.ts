import { it } from 'vitest';
import { SESSIONS, DIR, loadWindows } from './pipeline';
import { loadTruth } from './truth';

// ── How much recall can post-processing reach at all? ────────────────────────
//
// Everything downstream of FolkFriend — transforms, Viterbi, confirmation —
// can only pick among the ten candidates each window carries. A tune that never
// enters its own span's top ten is invisible to every configuration a campaign
// can draw, so that count is a hard ceiling, and the gap between it and the
// front says whether the next gain lives in the decoder or in the engine.
//
// Rungs of evidence, weakest to strongest, per annotated tune:
//   top10   — in the candidate list of at least one window overlapping its span
//   top3    — ranked 3rd or better at least once
//   top1    — ranked 1st at least once
//   top1x2  — ranked 1st on two consecutive windows (the production gate's shape)
//
// Windows are 10 s every 5 s, so a window counts for a span if its CENTRE lies
// inside it — edge windows straddling two tunes would otherwise credit both.
//
//   CEILING=1 npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/ceiling.test.ts

it('measures the recall ceiling of the candidate lists', () => {
  if (!process.env['CEILING']) { console.log('(CEILING absent)'); return; }
  const tot = { n: 0, top10: 0, top3: 0, top1: 0, top1x2: 0, top1n2: 0, top1n3: 0 };
  const misses: string[] = [];
  for (const id of SESSIONS) {
    const ws = loadWindows(id);
    const truth = loadTruth(DIR, id).filter(g => g.kind === 'tune');
    const s = { n: 0, top10: 0, top3: 0, top1: 0, top1x2: 0, top1n2: 0, top1n3: 0 };
    for (const g of truth) {
      const tid = [...g.ids][0]!;
      const inSpan = ws.filter(w => {
        const c = (w.tWindowStart + w.tWindowEnd) / 2;
        return c >= g.start && c <= g.end;
      });
      const ranks = inSpan.map(w => {
        const k = w.candidates.findIndex(c => c.tuneId === tid);
        return k < 0 ? Infinity : k + 1;
      });
      s.n++;
      const best = Math.min(Infinity, ...ranks);
      if (best <= 10) s.top10++;
      if (best <= 3) s.top3++;
      if (best <= 1) s.top1++;
      let x2 = false;
      for (let i = 1; i < ranks.length; i++) if (ranks[i] === 1 && ranks[i - 1] === 1) x2 = true;
      if (x2) s.top1x2++;
      // Production's actual gate: rank-1 windows COUNTED anywhere in the
      // segment (countTop1Windows), consecutive or not.
      const n1 = ranks.filter(r => r === 1).length;
      if (n1 >= 2) s.top1n2++;
      if (n1 >= 3) s.top1n3++;
      if (best > 10) misses.push(`${id.slice(0, 20)} ${tid} ${Math.round(g.start)}-${Math.round(g.end)}s (${inSpan.length} fen.)`);
      const hits = ranks.filter(r => r <= 10).length;
      if (best <= 10 && process.env['CEILING'] === 'v') {
        console.log(`   ${id.slice(0, 12)} ${tid.padStart(5)} fen=${String(inSpan.length).padStart(3)} top10=${hits} top1=${ranks.filter(r => r === 1).length}`);
      }
    }
    console.log(`${id.slice(0, 32).padEnd(32)} n=${String(s.n).padStart(3)} top10=${s.top10} top3=${s.top3} top1=${s.top1} top1x2=${s.top1x2} top1n2=${s.top1n2} top1n3=${s.top1n3}`);
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += s[k];
  }
  console.log(`${'TOTAL'.padEnd(32)} n=${tot.n} top10=${tot.top10} top3=${tot.top3} top1=${tot.top1} top1x2=${tot.top1x2} top1n2=${tot.top1n2} top1n3=${tot.top1n3}`);
  console.log(`\njamais dans le top 10 (${misses.length}) :\n  ${misses.join('\n  ')}`);
}, 600_000);
