import type { AppContext, Route } from '../types';
import { showModal } from './modal';
import { t } from '../services/i18nService';

type SectionStyle = 'definition' | 'logic' | 'metrics';
type HelpSection = { heading: string; items: string[]; style?: SectionStyle };

function getInfoContent(route: Route): { title: string; sections: HelpSection[] } {
  switch (route.view) {

    case 'folder':
      return route.folderId ? {
        title: t('help.context.folder'),
        sections: [
          { style: 'definition', heading: t('help.folder.what.heading'), items: [t('help.folder.what.1'), t('help.folder.what.2'), t('help.folder.what.3')] },
        ],
      } : {
        title: t('help.context.home'),
        sections: [
          { style: 'definition', heading: t('help.home.welcome.heading'), items: [t('help.home.welcome.1'), t('help.home.welcome.2'), t('help.home.welcome.3')] },
          { style: 'logic',      heading: t('help.home.nav.heading'),     items: [t('help.home.nav.1'), t('help.home.nav.2'), t('help.home.nav.3')] },
        ],
      };

    case 'library':
      return {
        title: t('help.context.library'),
        sections: [
          { style: 'definition', heading: t('help.library.browse.heading'), items: [t('help.library.browse.1'), t('help.library.browse.2'), t('help.library.browse.3'), t('help.library.browse.4')] },
        ],
      };

    case 'deck':
      return {
        title: t('help.context.deck'),
        sections: [
          { style: 'definition', heading: t('help.deck.study.heading'),  items: [t('help.deck.study.1'), t('help.deck.study.2'), t('help.deck.study.3')] },
          { style: 'logic',      heading: t('help.deck.manage.heading'), items: [t('help.deck.manage.1'), t('help.deck.manage.2'), t('help.deck.manage.3'), t('help.deck.manage.4')] },
          { style: 'metrics',    heading: t('help.deck.bar.heading'),    items: [t('help.deck.bar.1'), t('help.deck.bar.2'), t('help.deck.bar.3'), t('help.deck.bar.4')] },
        ],
      };

    case 'card':
      return {
        title: t('help.context.card'),
        sections: [
          { style: 'definition', heading: t('help.card.edit.heading'),  items: [t('help.card.edit.1'), t('help.card.edit.2'), t('help.card.edit.3'), t('help.card.edit.4')] },
          { style: 'metrics', heading: t('help.card.fsrs.heading'),  items: [t('help.card.fsrs.1'), t('help.card.fsrs.2'), t('help.card.fsrs.3')] },
        ],
      };

    case 'study':
      return {
        title: t('help.context.study'),
        sections: [
          { style: 'definition', heading: t('help.study.rating.heading'),   items: [t('help.study.rating.1'), t('help.study.rating.2'), t('help.study.rating.3'), t('help.study.rating.4')] },
          { style: 'logic',      heading: t('help.study.shortcuts.heading'), items: [t('help.study.shortcuts.1'), t('help.study.shortcuts.2'), t('help.study.shortcuts.3'), t('help.study.shortcuts.4')] },
          { style: 'metrics',    heading: t('help.study.fsrs.heading'),      items: [t('help.study.fsrs.1'), t('help.study.fsrs.2'), t('help.study.fsrs.3')] },
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

function buildInfoBody(sections: HelpSection[]): HTMLElement {
  const body = document.createElement('div');
  body.className = 'flex flex-col gap-3';

  sections.forEach((section, i) => {
    const sectionStyle = section.style ?? FALLBACK_STYLES[i % FALLBACK_STYLES.length]!;
    const accent  = STYLE_ACCENTS[sectionStyle];
    const iconSvg = STYLE_ICONS[sectionStyle];

    const card = document.createElement('div');
    card.className = 'bg-bg border border-border rounded-lg p-3.5';
    card.style.borderLeft = `3px solid ${accent}`;

    const header = document.createElement('div');
    header.className = 'flex items-center gap-2 mb-2';

    const iconEl = document.createElement('span');
    iconEl.className = 'shrink-0 flex items-center';
    iconEl.style.color = accent;
    iconEl.innerHTML = iconSvg;

    const headingEl = document.createElement('span');
    headingEl.className = 'text-sm font-semibold text-primary';
    headingEl.textContent = section.heading;

    header.append(iconEl, headingEl);
    card.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'flex flex-col gap-1.5 list-none';

    for (const item of section.items) {
      const li = document.createElement('li');
      li.className = 'flex gap-2 text-xs leading-relaxed text-primary/75';

      const check = document.createElement('span');
      check.className = 'shrink-0 flex items-center mt-0.5';
      check.style.color = accent;
      check.innerHTML = CHECK_SVG;

      const text = document.createElement('span');
      text.textContent = item;

      li.append(check, text);
      list.appendChild(li);
    }

    card.appendChild(list);
    body.appendChild(card);
  });

  return body;
}

const STEP_COLORS = [
  'var(--color-accent)',
  'var(--color-success)',
  'var(--color-warn)',
];

function buildGuideBody(steps: HelpSection[]): HTMLElement {
  const body = document.createElement('div');
  body.className = 'flex flex-col gap-3';

  steps.forEach((step, i) => {
    const color = STEP_COLORS[i % STEP_COLORS.length]!;

    const card = document.createElement('div');
    card.className = 'bg-bg border border-border rounded-lg p-3.5';
    card.style.borderLeft = `3px solid ${color}`;

    const header = document.createElement('div');
    header.className = 'flex items-center gap-2 mb-2';

    const badge = document.createElement('span');
    badge.className = 'shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold';
    badge.style.cssText = `background:${color};color:#fff;`;
    badge.textContent = String(i + 1);

    const headingEl = document.createElement('span');
    headingEl.className = 'text-sm font-semibold text-primary';
    headingEl.textContent = step.heading;

    header.append(badge, headingEl);
    card.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'flex flex-col gap-1.5 list-none';

    for (const item of step.items) {
      const li = document.createElement('li');
      li.className = 'flex gap-2 text-xs leading-relaxed text-primary/75';
      const dot = document.createElement('span'); dot.className = 'text-dim shrink-0 mt-0.5'; dot.textContent = '·';
      const text = document.createElement('span'); text.textContent = item;
      li.append(dot, text);
      list.appendChild(li);
    }

    card.appendChild(list);
    body.appendChild(card);
  });

  return body;
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

function mkTab(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.className = `px-3 py-2.5 text-xs font-medium cursor-pointer transition-colors border-none bg-transparent ${
    active ? 'text-accent' : 'text-dim hover:text-primary'
  }`;
  btn.style.borderBottom = active ? '2px solid var(--color-accent)' : '2px solid transparent';
  btn.style.marginBottom = '-1px';
  btn.onclick = onClick;
  return btn;
}

export function showHelpModal(ctx: AppContext): void {
  const { title, sections } = getInfoContent(ctx.route);
  let activeTab: 'info' | 'guide' = 'info';

  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col gap-4 -mx-5 -my-4';

  const tabBar = document.createElement('div');
  tabBar.className = 'flex border-b border-border px-5';

  const content = document.createElement('div');
  content.className = 'px-5 pb-4';

  const renderTabs = () => {
    tabBar.innerHTML = '';
    tabBar.appendChild(mkTab(t('help.tabInfo'),  activeTab === 'info',  () => { activeTab = 'info';  renderTabs(); renderContent(); }));
    tabBar.appendChild(mkTab(t('help.tabGuide'), activeTab === 'guide', () => { activeTab = 'guide'; renderTabs(); renderContent(); }));
  };

  const renderContent = () => {
    content.innerHTML = '';
    if (activeTab === 'info') {
      content.appendChild(buildInfoBody(sections));
    } else {
      content.appendChild(buildGuideBody(getGuideSteps()));
    }
  };

  renderTabs();
  renderContent();
  wrap.append(tabBar, content);

  showModal(t('help.title', { context: title }), wrap, [], true, '36rem');
}
