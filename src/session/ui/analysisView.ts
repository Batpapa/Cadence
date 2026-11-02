import { signal } from '@preact/signals';

// ── How much of an analysis is shown (2026-10-28) ────────────────────────────
// An analysis always read as an editing tool — bounds, clips, deletion, merge,
// ratings on every tune — when most visits are to listen again. Three views,
// as tabs under the timeline (the user's design):
//   simple   — play, score, score following, add to a deck, name, ♥, the
//              confidence badge (still the way to correct), the silences;
//   detailed — and the dance, the mode, the times, the clip controls;
//   editor   — and everything that changes the analysis: bounds, silences
//              (fill, give), deletion, merge, set links. What it always was.
//   focus    — one tune at a time, large, with the detailed view's facts, and
//              arrows to the tune before and after (2026-10-30, a tester's
//              request: a phone put down beside you at a session). See
//              FocusView.tsx.
// Ratings are a switch beside them, "Study", whatever the view.
//
// The same views, and the same switch, on the live and import feeds since
// 2026-10-30: they are analyses too, only still being made.
//
// Per DEVICE, in localStorage (the user's call): a phone at a session and a
// desk with the analysis open are not doing the same thing. Absent means the
// default — simple, study off — and only another choice is stored.

export type AnalysisView = 'simple' | 'detailed' | 'editor' | 'focus';

export const ANALYSIS_VIEWS: readonly AnalysisView[] = ['simple', 'detailed', 'editor', 'focus'];

const VIEW_KEY = 'cadence_analysis_view';
const STUDY_KEY = 'cadence_analysis_study';
const TEMPO_KEY = 'cadence_analysis_tempo';

function readView(): AnalysisView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'detailed' || v === 'editor' || v === 'focus' ? v : 'simple';
  } catch {
    return 'simple';
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export const analysisView = signal<AnalysisView>(readView());
export const analysisStudy = signal<boolean>(readFlag(STUDY_KEY));
/** "BPM" (2026-11-02, the user): each tune's tempo on its card, and the live
 *  tempo at the bottom of a recording. A switch beside "Study", per device and
 *  off by default as it is. Only what is SHOWN: the tempo is worked out by
 *  every analysis and saved with it whatever this says (Detection.quaverRate)
 *  — it costs some 7 % of an import. */
export const analysisTempo = signal<boolean>(readFlag(TEMPO_KEY));

export function setAnalysisView(v: AnalysisView): void {
  analysisView.value = v;
  try {
    if (v === 'simple') localStorage.removeItem(VIEW_KEY);
    else localStorage.setItem(VIEW_KEY, v);
  } catch { /* private mode: it lasts as long as the page */ }
}

function toggle(flag: typeof analysisStudy, key: string): void {
  const on = !flag.value;
  flag.value = on;
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch { /* private mode: it lasts as long as the page */ }
}

export function toggleAnalysisStudy(): void { toggle(analysisStudy, STUDY_KEY); }
export function toggleAnalysisTempo(): void { toggle(analysisTempo, TEMPO_KEY); }

/** What a view shows, asked by name rather than by comparing views. */
export const showsDetails = (v: AnalysisView) => v !== 'simple';
export const showsEditing = (v: AnalysisView) => v === 'editor';
export const showsFocus = (v: AnalysisView) => v === 'focus';
