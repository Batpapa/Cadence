import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';
import { t } from '../../services/i18nService';
import { StudyIcon, MetronomeIcon } from '../../components/icons';
import {
  ANALYSIS_VIEWS, analysisView, analysisStudy, analysisTempo, setAnalysisView, toggleAnalysisStudy, toggleAnalysisTempo,
  type AnalysisView,
} from './analysisView';

const VIEW_LABEL: Record<AnalysisView, string> = {
  simple:   'sessions.view.simple',
  detailed: 'sessions.view.detailed',
  editor:   'sessions.view.editor',
  focus:    'sessions.view.focus',
};

/** The room between the tabs and the switches (`gap-2`), and between the two. */
const GAP_PX = 8;

// The app's segmented control (styles.css, .seg) and toggle chips (.chip),
// the twins below wearing the same classes so that they measure the same.
const TAB_CLS = 'seg-btn whitespace-nowrap';
const TAB_ROOMY = 'px-3 text-xs';
const TAB_TIGHT = 'px-2 text-2xs';
const STUDY_CLS = 'chip min-h-8 px-3 font-medium whitespace-nowrap gap-1.5';
const STUDY_ICON_ONLY = 'chip min-h-8 px-2';

/** How tight the bar has to be: everything at ease; the switches down to their
 *  icons; and then the tabs too. In that order — the user's call: the tabs are
 *  what is read, the switches are known by their icons. */
type Fit = 'roomy' | 'icon' | 'tight';

/** The switches at the far end, in order: "BPM" beside "Study" (2026-11-02,
 *  the user). Each holds in every view. */
const SWITCHES = [
  { key: 'tempo', icon: () => <MetronomeIcon size={14} />, label: () => t('sessions.view.tempo'), hint: () => t('sessions.view.tempo.hint'), on: () => analysisTempo.value, toggle: toggleAnalysisTempo },
  { key: 'study', icon: () => <StudyIcon size={14} />, label: () => t('sessions.view.study'), hint: () => t('sessions.view.study.hint'), on: () => analysisStudy.value, toggle: toggleAnalysisStudy },
] as const;

/** How much of each tune is shown (analysisView.ts), as tabs — and "BPM" and
 *  "Study" on their own at the far end: not other views but switches that
 *  hold in all of them. The same bar on the finished analysis and on the live
 *  and import feeds (2026-10-30), at the top of each screen's pinned bar.
 *
 *  40 px tall (`h-10`): the segmented rail's, a 32 px tab in its padding.
 *
 *  Four tabs and the switches have to hold on a phone's width (see Fit).
 *  Measured, not guessed from the screen's width: the labels' lengths differ
 *  from one language to the next. The measures are invisible twins of the
 *  roomy tabs and of both forms of the switches, always laid out, so the
 *  answer never depends on which form happens to be on screen — the way a fit
 *  decided from the shown form itself flips back and forth at the threshold.
 *  They sit in a box of no size, so they can never widen the page. */
export function AnalysisViewBar() {
  const view = analysisView.value;
  // Read here so the bar redraws on either switch.
  const states = SWITCHES.map(s => s.on());
  const barRef = useRef<HTMLDivElement>(null);
  const tabsTwinRef = useRef<HTMLDivElement>(null);
  const fullTwinRef = useRef<HTMLDivElement>(null);
  const iconTwinRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit>('roomy');

  useLayoutEffect(() => {
    const bar = barRef.current;
    const tabs = tabsTwinRef.current;
    const full = fullTwinRef.current;
    const icon = iconTwinRef.current;
    if (!bar || !tabs || !full || !icon) return;
    const measure = () => {
      const room = bar.clientWidth;
      setFit(tabs.offsetWidth + GAP_PX + full.offsetWidth <= room ? 'roomy'
        : tabs.offsetWidth + GAP_PX + icon.offsetWidth <= room ? 'icon'
        : 'tight');
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [bar, tabs, full, icon]) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tabSize = fit === 'tight' ? TAB_TIGHT : TAB_ROOMY;
  const twins = (roomy: boolean): ComponentChild[] => SWITCHES.map(s => (
    <span key={s.key} class={`${roomy ? STUDY_CLS : STUDY_ICON_ONLY} w-max`}>{s.icon()}{roomy && s.label()}</span>
  ));

  return (
    <div ref={barRef} class="relative flex items-center gap-2 h-10" data-tour="summary-views">
      <div class="absolute left-0 top-0 w-0 h-0 overflow-hidden invisible pointer-events-none" aria-hidden="true">
        <div ref={tabsTwinRef} class="seg w-max">
          {ANALYSIS_VIEWS.map(v => <span key={v} class={`${TAB_CLS} ${TAB_ROOMY}`}>{t(VIEW_LABEL[v] as Parameters<typeof t>[0])}</span>)}
        </div>
        <div ref={fullTwinRef} class="flex gap-2 w-max">{twins(true)}</div>
        <div ref={iconTwinRef} class="flex gap-2 w-max">{twins(false)}</div>
      </div>

      {/* `bg-elevated`, not the rail's own `bg-bg`: the bar stands on the
          pinned strip's bg, where a bg rail would not show. Its hover is then
          the surface, the elevated one vanishing on it. */}
      <div class="seg bg-elevated shrink-0" role="tablist" aria-label={t('sessions.view.label')}>
        {ANALYSIS_VIEWS.map(v => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            class={`${TAB_CLS} ${tabSize} ${view === v ? 'seg-btn-on' : 'hover:bg-surface'}`}
            onClick={() => setAnalysisView(v)}
          >
            {t(VIEW_LABEL[v] as Parameters<typeof t>[0])}
          </button>
        ))}
      </div>
      <div class="ml-auto shrink-0 flex items-center gap-2">
        {SWITCHES.map((s, i) => (
          <button
            key={s.key}
            class={`${fit === 'roomy' ? STUDY_CLS : STUDY_ICON_ONLY} cursor-pointer ${
              states[i] ? 'chip-toggle-on' : 'hover:text-primary hover:border-accent/50'}`}
            title={s.hint()}
            aria-label={fit === 'roomy' ? undefined : s.label()}
            aria-pressed={states[i]}
            onClick={s.toggle}
          >
            {s.icon()}
            {fit === 'roomy' && s.label()}
          </button>
        ))}
      </div>
    </div>
  );
}
