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
// Ratings are a fourth switch beside them, "Study", whatever the view.
//
// Per DEVICE, in localStorage (the user's call): a phone at a session and a
// desk with the analysis open are not doing the same thing. Absent means the
// default — simple, study off — and only another choice is stored.

export type AnalysisView = 'simple' | 'detailed' | 'editor';

export const ANALYSIS_VIEWS: readonly AnalysisView[] = ['simple', 'detailed', 'editor'];

const VIEW_KEY = 'cadence_analysis_view';
const STUDY_KEY = 'cadence_analysis_study';

function readView(): AnalysisView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'detailed' || v === 'editor' ? v : 'simple';
  } catch {
    return 'simple';
  }
}

function readStudy(): boolean {
  try {
    return localStorage.getItem(STUDY_KEY) === '1';
  } catch {
    return false;
  }
}

export const analysisView = signal<AnalysisView>(readView());
export const analysisStudy = signal<boolean>(readStudy());

export function setAnalysisView(v: AnalysisView): void {
  analysisView.value = v;
  try {
    if (v === 'simple') localStorage.removeItem(VIEW_KEY);
    else localStorage.setItem(VIEW_KEY, v);
  } catch { /* private mode: it lasts as long as the page */ }
}

export function toggleAnalysisStudy(): void {
  const on = !analysisStudy.value;
  analysisStudy.value = on;
  try {
    if (on) localStorage.setItem(STUDY_KEY, '1');
    else localStorage.removeItem(STUDY_KEY);
  } catch { /* private mode: it lasts as long as the page */ }
}

/** What a view shows, asked by name rather than by comparing views. */
export const showsDetails = (v: AnalysisView) => v !== 'simple';
export const showsEditing = (v: AnalysisView) => v === 'editor';
