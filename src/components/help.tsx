import { useState } from 'preact/hooks';
import type { AppContext, Route } from '../types';
import { showModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';

type SectionStyle = 'definition' | 'logic' | 'metrics';
type HelpSection = { heading: string; items: string[]; style?: SectionStyle };

function getInfoContent(route: Route): { title: string; sections: HelpSection[] } {
  switch (route.view) {

    case 'folder':
      return route.folderId ? {
        title: t('help.context.folder'),
        sections: [
          { style: 'definition', heading: t('help.folder.what.heading'),    items: [t('help.folder.what.1'), t('help.folder.what.2'), t('help.folder.what.3')] },
          { style: 'logic',      heading: t('help.folder.actions.heading'), items: [t('help.folder.actions.1'), t('help.folder.actions.2'), t('help.folder.actions.3')] },
        ],
      } : {
        title: t('help.context.home'),
        sections: [
          { style: 'definition', heading: t('help.home.welcome.heading'),  items: [t('help.home.welcome.1'), t('help.home.welcome.2'), t('help.home.welcome.3')] },
          { style: 'logic',      heading: t('help.home.nav.heading'),      items: [t('help.home.nav.1'), t('help.home.nav.2'), t('help.home.nav.3')] },
          { style: 'metrics',    heading: t('help.home.organize.heading'), items: [t('help.home.organize.1'), t('help.home.organize.2'), t('help.home.organize.3'), t('help.home.organize.4')] },
        ],
      };

    case 'library':
      return {
        title: t('help.context.library'),
        sections: [
          { style: 'definition', heading: t('help.library.browse.heading'), items: [t('help.library.browse.1'), t('help.library.browse.2'), t('help.library.browse.3'), t('help.library.browse.4')] },
          { style: 'logic',      heading: t('help.library.tools.heading'),  items: [t('help.library.tools.1'), t('help.library.tools.2'), t('help.library.tools.3'), t('help.library.tools.4')] },
        ],
      };

    case 'deck':
      return {
        title: t('help.context.deck'),
        sections: [
          { style: 'definition', heading: t('help.deck.study.heading'),    items: [t('help.deck.study.1'), t('help.deck.study.2'), t('help.deck.study.3')] },
          { style: 'logic',      heading: t('help.deck.manage.heading'),   items: [t('help.deck.manage.1'), t('help.deck.manage.2'), t('help.deck.manage.3'), t('help.deck.manage.4')] },
          { style: 'metrics',    heading: t('help.deck.bar.heading'),      items: [t('help.deck.bar.1'), t('help.deck.bar.2'), t('help.deck.bar.3'), t('help.deck.bar.4')] },
          { style: 'logic',      heading: t('help.deck.location.heading'), items: [t('help.deck.location.1'), t('help.deck.location.2'), t('help.deck.location.3'), t('help.deck.location.4')] },
        ],
      };

    case 'card':
      return {
        title: t('help.context.card'),
        sections: [
          { style: 'definition', heading: t('help.card.edit.heading'),    items: [t('help.card.edit.1'), t('help.card.edit.2'), t('help.card.edit.3'), t('help.card.edit.4')] },
          { style: 'logic',      heading: t('help.card.manage.heading'),  items: [t('help.card.manage.1'), t('help.card.manage.2'), t('help.card.manage.3'), t('help.card.manage.4'), t('help.card.manage.5')] },
          { style: 'logic',      heading: t('help.card.abc.heading'),     items: [t('help.card.abc.1'), t('help.card.abc.2'), t('help.card.abc.3')] },
          { style: 'logic',      heading: t('help.card.notes.heading'),   items: [t('help.card.notes.1'), t('help.card.notes.2'), t('help.card.notes.3')] },
          { style: 'metrics',    heading: t('help.card.history.heading'), items: [t('help.card.history.1'), t('help.card.history.2')] },
          { style: 'metrics',    heading: t('help.card.fsrs.heading'),    items: [t('help.card.fsrs.1'), t('help.card.fsrs.2'), t('help.card.fsrs.3')] },
        ],
      };

    case 'study':
      return {
        title: t('help.context.study'),
        sections: [
          { style: 'definition', heading: t('help.study.launch.heading'),    items: [t('help.study.launch.1'), t('help.study.launch.2'), t('help.study.launch.3')] },
          { style: 'definition', heading: t('help.study.rating.heading'),    items: [t('help.study.rating.1'), t('help.study.rating.2'), t('help.study.rating.3'), t('help.study.rating.4')] },
          { style: 'logic',      heading: t('help.study.shortcuts.heading'), items: [t('help.study.shortcuts.1'), t('help.study.shortcuts.2'), t('help.study.shortcuts.3'), t('help.study.shortcuts.4')] },
          { style: 'metrics',    heading: t('help.study.fsrs.heading'),      items: [t('help.study.fsrs.1'), t('help.study.fsrs.2'), t('help.study.fsrs.3'), t('help.study.fsrs.4')] },
          { style: 'metrics',    heading: t('help.study.end.heading'),       items: [t('help.study.end.1'), t('help.study.end.2'), t('help.study.end.3')] },
        ],
      };

    case 'modules':
      return {
        title: t('help.context.modules'),
        sections: [
          { style: 'definition', heading: t('help.modules.what.heading'),      items: [t('help.modules.what.1'), t('help.modules.what.2'), t('help.modules.what.3')] },
          // This page is a picker: it lists what each module is for and sends
          // you to its own help. The per-module detail lives in the 'sessions'
          // and 'trending' cases below — don't duplicate it here.
          { style: 'logic',      heading: t('help.modules.available.heading'), items: [t('help.modules.available.1'), t('help.modules.available.2'), t('help.modules.available.3')] },
        ],
      };

    case 'sessions':
      return {
        title: t('help.context.sessions'),
        sections: [
          { style: 'definition', heading: t('help.sessions.recording.heading'), items: [t('help.sessions.recording.1'), t('help.sessions.recording.2'), t('help.sessions.recording.3'), t('help.sessions.recording.4'), t('help.sessions.recording.5')] },
          { style: 'logic',      heading: t('help.sessions.import.heading'),    items: [t('help.sessions.import.1'), t('help.sessions.import.2')] },
          { style: 'logic',      heading: t('help.sessions.results.heading'),   items: [t('help.sessions.results.1'), t('help.sessions.results.2'), t('help.sessions.results.3'), t('help.sessions.results.4')] },
          { style: 'metrics',    heading: t('help.sessions.summary.heading'),   items: [t('help.sessions.summary.1'), t('help.sessions.summary.2'), t('help.sessions.summary.3'), t('help.sessions.summary.4'), t('help.sessions.summary.5')] },
        ],
      };

    case 'trending':
      return {
        title: t('help.context.trending'),
        sections: [
          { style: 'definition', heading: t('help.trending.what.heading'),    items: [t('help.trending.what.1'), t('help.trending.what.2'), t('help.trending.what.3')] },
          { style: 'logic',      heading: t('help.trending.actions.heading'), items: [t('help.trending.actions.1'), t('help.trending.actions.2'), t('help.trending.actions.3')] },
        ],
      };
  }
}

const STYLE_ACCENTS: Record<SectionStyle, string> = {
  definition: 'var(--color-accent)',
  logic:      'var(--color-success)',
  metrics:    'var(--color-warn)',
};

const STYLE_ICONS: Record<SectionStyle, string> = {
  definition: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  logic:      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  metrics:    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>`,
};

const FALLBACK_STYLES: SectionStyle[] = ['definition', 'logic', 'metrics'];

const CHECK_SVG = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function InfoBody({ sections }: { sections: HelpSection[] }) {
  return (
    <div class="flex flex-col gap-3">
      {sections.map((section, i) => {
        const sectionStyle = section.style ?? FALLBACK_STYLES[i % FALLBACK_STYLES.length]!;
        const accent = STYLE_ACCENTS[sectionStyle];
        return (
          <div key={section.heading} class="bg-bg border border-border rounded-lg p-3.5" style={{ borderLeft: `3px solid ${accent}` }}>
            <div class="flex items-center gap-2 mb-2">
              <span class="shrink-0 flex items-center" style={{ color: accent }} dangerouslySetInnerHTML={{ __html: STYLE_ICONS[sectionStyle] }} />
              <span class="text-sm font-semibold text-primary">{section.heading}</span>
            </div>
            <ul class="flex flex-col gap-1.5 list-none">
              {section.items.map(item => (
                <li key={item} class="flex gap-2 text-xs leading-relaxed text-primary/75">
                  <span class="shrink-0 flex items-center mt-0.5" style={{ color: accent }} dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const STEP_COLORS = [
  'var(--color-accent)',
  'var(--color-success)',
  'var(--color-warn)',
];

function GuideBody({ steps }: { steps: HelpSection[] }) {
  return (
    <div class="flex flex-col gap-3">
      {steps.map((step, i) => {
        const color = STEP_COLORS[i % STEP_COLORS.length]!;
        return (
          <div key={step.heading} class="bg-bg border border-border rounded-lg p-3.5" style={{ borderLeft: `3px solid ${color}` }}>
            <div class="flex items-center gap-2 mb-2">
              <span class="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: color, color: '#fff' }}>{i + 1}</span>
              <span class="text-sm font-semibold text-primary">{step.heading}</span>
            </div>
            <ul class="flex flex-col gap-1.5 list-none">
              {step.items.map(item => (
                <li key={item} class="flex gap-2 text-xs leading-relaxed text-primary/75">
                  <span class="text-dim shrink-0 mt-0.5">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function getGuideSteps(): HelpSection[] {
  return [
    { heading: t('help.guide.step1.heading'), items: [t('help.guide.step1.1'), t('help.guide.step1.2'), t('help.guide.step1.3'), t('help.guide.step1.4')] },
    { heading: t('help.guide.step2.heading'), items: [t('help.guide.step2.1'), t('help.guide.step2.2'), t('help.guide.step2.3')] },
    { heading: t('help.guide.step3.heading'), items: [t('help.guide.step3.1'), t('help.guide.step3.2'), t('help.guide.step3.3'), t('help.guide.step3.4')] },
    { heading: t('help.guide.step4.heading'), items: [t('help.guide.step4.1'), t('help.guide.step4.2'), t('help.guide.step4.3')] },
    { heading: t('help.guide.step5.heading'), items: [t('help.guide.step5.1'), t('help.guide.step5.2'), t('help.guide.step5.3'), t('help.guide.step5.4')] },
    { heading: t('help.guide.step6.heading'), items: [t('help.guide.step6.1'), t('help.guide.step6.2'), t('help.guide.step6.3')] },
  ];
}

function HelpTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      class={`px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors border-none bg-transparent ${active ? 'text-accent' : 'text-dim hover:text-primary'}`}
      style={{ borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent', marginBottom: '-1px' }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function HelpModalContent({ sections }: { sections: HelpSection[] }) {
  const [activeTab, setActiveTab] = useState<'info' | 'guide'>('info');

  return (
    <div class="flex flex-col gap-4 -mx-5 -my-4">
      <div class="flex border-b border-border px-5">
        <HelpTab label={t('help.tabInfo')}  active={activeTab === 'info'}  onClick={() => setActiveTab('info')} />
        <HelpTab label={t('help.tabGuide')} active={activeTab === 'guide'} onClick={() => setActiveTab('guide')} />
      </div>
      <div class="px-5 pb-4">
        {activeTab === 'info' ? <InfoBody sections={sections} /> : <GuideBody steps={getGuideSteps()} />}
      </div>
    </div>
  );
}

export function showHelpModal(ctx: AppContext): void {
  const { title, sections } = getInfoContent(ctx.route);
  const { el, cleanup } = renderModalBody(<HelpModalContent sections={sections} />);
  showModal(t('help.title', { context: title }), el, [], true, '36rem', cleanup);
}
