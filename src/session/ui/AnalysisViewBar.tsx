import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { StudyIcon } from '../../components/icons';
import { ANALYSIS_VIEWS, analysisView, analysisStudy, setAnalysisView, toggleAnalysisStudy, type AnalysisView } from './analysisView';

const VIEW_LABEL: Record<AnalysisView, string> = {
  simple:   'sessions.view.simple',
  detailed: 'sessions.view.detailed',
  editor:   'sessions.view.editor',
  focus:    'sessions.view.focus',
};

/** The room between the tabs and the switch (`gap-2`). */
const GAP_PX = 8;

const TAB_CLS = 'py-1 font-medium rounded whitespace-nowrap';
const TAB_ROOMY = 'px-3 text-xs';
const TAB_TIGHT = 'px-2 text-[11px]';
const STUDY_CLS = 'px-3 py-1 text-xs font-medium rounded-full border whitespace-nowrap inline-flex items-center gap-1.5';
const STUDY_ICON_ONLY = 'px-2 py-1 rounded-full border inline-flex items-center';

/** How tight the bar has to be: everything at ease; the switch down to its
 *  icon; and then the tabs too. In that order — the user's call: the tabs are
 *  what is read, the switch is known by its cap. */
type Fit = 'roomy' | 'icon' | 'tight';

/** How much of each tune is shown (analysisView.ts), as tabs — and "Study" on
 *  its own at the far end: it is not another view but a switch that holds in
 *  all of them. The same bar on the finished analysis and on the live and
 *  import feeds (2026-10-30), at the top of each screen's pinned bar.
 *
 *  32 px tall (`h-8`): the summary places its recording's icons by it — see
 *  `top-14` there.
 *
 *  Four tabs and the switch have to hold on a phone's width (see Fit).
 *  Measured, not guessed from the screen's width: the labels' lengths differ
 *  from one language to the next. The measures are invisible twins of the
 *  roomy tabs and of both forms of the switch, always laid out, so the answer
 *  never depends on which form happens to be on screen — the way a fit decided
 *  from the shown form itself flips back and forth at the threshold. They sit
 *  in a box of no size, so they can never widen the page. */
export function AnalysisViewBar() {
  const view = analysisView.value;
  const study = analysisStudy.value;
  const barRef = useRef<HTMLDivElement>(null);
  const tabsTwinRef = useRef<HTMLDivElement>(null);
  const studyTwinRef = useRef<HTMLSpanElement>(null);
  const iconTwinRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<Fit>('roomy');

  useLayoutEffect(() => {
    const bar = barRef.current;
    const tabs = tabsTwinRef.current;
    const full = studyTwinRef.current;
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
  const label = t('sessions.view.study');

  return (
    <div ref={barRef} class="relative flex items-center gap-2 h-8" data-tour="summary-views">
      <div class="absolute left-0 top-0 w-0 h-0 overflow-hidden invisible pointer-events-none" aria-hidden="true">
        <div ref={tabsTwinRef} class="flex gap-1 p-1 w-max">
          {ANALYSIS_VIEWS.map(v => <span key={v} class={`${TAB_CLS} ${TAB_ROOMY}`}>{t(VIEW_LABEL[v] as Parameters<typeof t>[0])}</span>)}
        </div>
        <span ref={studyTwinRef} class={`${STUDY_CLS} w-max`}><StudyIcon size={14} />{label}</span>
        <span ref={iconTwinRef} class={`${STUDY_ICON_ONLY} w-max`}><StudyIcon size={14} /></span>
      </div>

      <div class="flex gap-1 p-1 bg-elevated rounded-lg shrink-0" role="tablist" aria-label={t('sessions.view.label')}>
        {ANALYSIS_VIEWS.map(v => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            class={`${TAB_CLS} ${tabSize} transition-colors cursor-pointer ${
              view === v ? 'bg-accent text-white' : 'text-muted hover:text-primary hover:bg-surface'}`}
            onClick={() => setAnalysisView(v)}
          >
            {t(VIEW_LABEL[v] as Parameters<typeof t>[0])}
          </button>
        ))}
      </div>
      <button
        class={`ml-auto shrink-0 ${fit === 'roomy' ? STUDY_CLS : STUDY_ICON_ONLY} transition-colors cursor-pointer ${
          study ? 'border-accent/60 bg-accent/10 text-accent' : 'border-border text-muted hover:text-primary hover:border-accent/50'}`}
        title={t('sessions.view.study.hint')}
        aria-label={fit === 'roomy' ? undefined : label}
        aria-pressed={study}
        onClick={toggleAnalysisStudy}
      >
        <StudyIcon size={14} />
        {fit === 'roomy' && label}
      </button>
    </div>
  );
}
