import { it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { IncrementalViterbiSegmenter } from '../../src/session/recognition/viterbiSegmenter';
import { ANALYSIS_HOP_S } from '../../src/session/sessionConfig';
import type { WindowResult } from '../../src/session/model';

// Replays each annotated fixture through the segmenter ONE WINDOW AT A TIME, as
// ffWorker.ts does live, and records what the detection list shows after every
// window: when each detection first appears, what it is renamed to, whether it
// is retracted. A batch decode would only give the final list; the time to a
// first right answer only exists on this path.
//
// Writes one JSON per session to $BENCH_OUT (scored by score.mjs beside it).
// $SESSIONS (comma-separated) replays only those fixtures — a quick look on a subset.
// $WINDOWS_DIR replays other window dumps of the same recordings instead
// (an engine experiment), with the same file names.

const DIR = process.env['WINDOWS_DIR'] ?? nodePath.resolve(__dirname, '../../test-fixtures/sessions');
const SESSIONS = [
  '20260523_1_matin_Anglade',
  '20260523_2_aprem_tabac',
  '20260523_5_auberge_fleurie',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video',
  '20240721_tocane_2_chapiteau',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24',
  '1Hour_Trad_Irish_Music_Session_in_Korea',
  '732984_11910076-lq',
  // 13th Moon Gravity Well, 2025-26 (same room and band every week)
  ...['2025_07_02', '2025_08_13', '2025_08_27', '2025_10_22', '2025_12_10', '2026_01_14', '2026_02_25', '2026_04_08'].map(d => `13th_Moon_${d}`),
  '20240723_tocane_soir_1',
  '20260227_3_marcellin_fond',
];

interface Shown { id: string; tuneId: string; start: number; end: number | null; finalized: boolean }

it('replays every fixture window by window', () => {
  const outDir = process.env['BENCH_OUT'];
  if (!outDir) throw new Error('BENCH_OUT not set');
  fs.mkdirSync(outDir, { recursive: true });

  const only = process.env['SESSIONS']?.split(',').map(s => s.trim()).filter(Boolean);
  for (const session of only?.length ? only : SESSIONS) {
    const raw = JSON.parse(fs.readFileSync(nodePath.join(DIR, `${session}-windows.json`), 'utf-8')) as WindowResult[] | Record<string, WindowResult>;
    const windows = Array.isArray(raw) ? raw : Object.values(raw);
    const seg = new IncrementalViterbiSegmenter(ANALYSIS_HOP_S);
    const shown = new Map<string, Shown>();
    // Every state a detection id passes through: [now, tuneId, start, end, kind].
    const log: [number, string, string, number, number | null, string][] = [];
    const apply = (now: number, events: ReturnType<IncrementalViterbiSegmenter['step']>) => {
      for (const e of events) {
        if (e.type === 'retract') {
          const s = shown.get(e.id);
          if (s) log.push([now, e.id, s.tuneId, s.start, s.end, 'retract']);
          shown.delete(e.id);
          continue;
        }
        const d = e.detection;
        shown.set(d.id, { id: d.id, tuneId: d.tuneId, start: d.start, end: d.end, finalized: d.finalized });
        log.push([now, d.id, d.tuneId, d.start, d.end, e.type]);
      }
    };
    const t0 = Date.now();
    for (const w of windows) apply(w.tWindowEnd, seg.step(w));
    const last = windows[windows.length - 1]?.tWindowEnd ?? 0;
    apply(last, seg.finalize());
    const final = [...shown.values()].map(s => ({ tuneId: s.tuneId, start: s.start, end: s.end ?? last }));
    fs.writeFileSync(nodePath.join(outDir, `cadence-${session}.json`), JSON.stringify({ session, duration: last, final, log }));
    console.log(`${session}: ${windows.length} windows, ${final.length} detections, ${log.length} events, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
});
