import { useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { AppContext, Route } from '../types';
import { showModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';
import { CARD_TYPE_TUNE, isTuneset } from '../services/cardTypeService';
import { isAbcFile } from '../services/abcService';
import { liveScreenActive, importScreenActive } from '../session/ui/sessionModule';

type SectionStyle = 'definition' | 'logic' | 'metrics';
type HelpSection = { heading: string; items: string[]; style?: SectionStyle };

// ── What each screen explains ────────────────────────────────────────────────
// Rewritten from the running app on 2026-09-15, for the public release: one
// help per screen a user can actually be looking at, and nothing about a
// screen they are not. That is why the analyser splits into four (its library,
// a live recording, a file import, a finished analysis all share one route)
// and why a card only explains tune sets, scores or imports when it IS one —
// a vocabulary card has no business teaching ABC notation.
//
// Every key is written out literally, never built: the i18n test can only check
// the keys it can read, and this file is almost nothing but keys.

/** How a recognised tune reads, wherever a list of them is shown — the live
 *  feed, a file import and a finished analysis all use the same card. */
function detectionSection(): HelpSection {
  return { style: 'metrics', heading: t('help.detection.heading'), items: [t('help.detection.1'), t('help.detection.2'), t('help.detection.3'), t('help.detection.4'), t('help.detection.5'), t('help.detection.6')] };
}

function cardSections(ctx: AppContext, cardId: string): HelpSection[] {
  const card = ctx.user.cards[cardId];
  const isSet = !!card && isTuneset(card);
  const isMusic = !!card && (card.type === CARD_TYPE_TUNE || isSet);
  const imported = !!card?.externalId;
  const hasScore = isMusic || !!card?.content.attachments.some(a => a.type === 'file' && isAbcFile(a));

  return [
    { style: 'definition', heading: t('help.card.what.heading'), items: [t('help.card.what.1'), t('help.card.what.2'), t('help.card.what.3')] },
    { style: 'metrics', heading: t('help.card.metrics.heading'), items: [t('help.card.metrics.1'), t('help.card.metrics.2'), t('help.card.metrics.3'), t('help.card.metrics.4'), t('help.card.metrics.5')] },
    ...(isSet ? [{ style: 'logic' as const, heading: t('help.card.set.heading'), items: [t('help.card.set.1'), t('help.card.set.2'), t('help.card.set.3'), t('help.card.set.4'), t('help.card.set.5')] }] : []),
    ...(imported ? [{ style: 'logic' as const, heading: t('help.card.imported.heading'), items: [t('help.card.imported.1'), t('help.card.imported.2'), t('help.card.imported.3'), t('help.card.imported.4')] }] : []),
    { style: 'logic', heading: t('help.card.content.heading'), items: [t('help.card.content.1'), t('help.card.content.2'), t('help.card.content.3'), t('help.card.content.4')] },
    { style: 'logic', heading: t('help.card.attach.heading'), items: [t('help.card.attach.1'), t('help.card.attach.2'), t('help.card.attach.3'), t('help.card.attach.4')] },
    ...(hasScore ? [{ style: 'logic' as const, heading: t('help.card.abc.heading'), items: [t('help.card.abc.1'), t('help.card.abc.2'), t('help.card.abc.3'), t('help.card.abc.4'), t('help.card.abc.5'), t('help.card.abc.6')] }] : []),
    { style: 'logic', heading: t('help.card.links.heading'), items: [t('help.card.links.1'), ...(isMusic ? [t('help.card.links.2'), t('help.card.links.3')] : [])] },
    { style: 'metrics', heading: t('help.card.history.heading'), items: [t('help.card.history.1'), t('help.card.history.2'), t('help.card.history.3')] },
  ];
}

function getInfoContent(ctx: AppContext): { title: string; sections: HelpSection[] } {
  const route: Route = ctx.route;
  switch (route.view) {

    case 'folder':
      return route.folderId ? {
        title: t('help.context.folder'),
        sections: [
          { style: 'definition', heading: t('help.folder.what.heading'),   items: [t('help.folder.what.1'), t('help.folder.what.2')] },
          { style: 'logic',      heading: t('help.folder.study.heading'),  items: [t('help.folder.study.1')] },
          { style: 'logic',      heading: t('help.folder.manage.heading'), items: [t('help.folder.manage.1'), t('help.folder.manage.2'), t('help.folder.manage.3'), t('help.folder.manage.4')] },
          { style: 'metrics',    heading: t('help.folder.list.heading'),   items: [t('help.folder.list.1')] },
        ],
      } : {
        title: t('help.context.home'),
        sections: [
          { style: 'definition', heading: t('help.home.start.heading'),    items: [t('help.home.start.1'), t('help.home.start.2'), t('help.home.start.3')] },
          { style: 'metrics',    heading: t('help.home.stats.heading'),    items: [t('help.home.stats.1'), t('help.home.stats.2'), t('help.home.stats.3'), t('help.home.stats.4'), t('help.home.stats.5')] },
          { style: 'logic',      heading: t('help.home.study.heading'),    items: [t('help.home.study.1'), t('help.home.study.2')] },
          { style: 'logic',      heading: t('help.home.organize.heading'), items: [t('help.home.organize.1'), t('help.home.organize.2'), t('help.home.organize.3'), t('help.home.organize.4')] },
          { style: 'metrics',    heading: t('help.home.dots.heading'),     items: [t('help.home.dots.1'), t('help.home.dots.2'), t('help.home.dots.3')] },
        ],
      };

    case 'library':
      return {
        title: t('help.context.library'),
        sections: [
          { style: 'definition', heading: t('help.library.what.heading'),   items: [t('help.library.what.1'), t('help.library.what.2'), t('help.library.what.3'), t('help.library.what.4')] },
          { style: 'logic',      heading: t('help.library.search.heading'), items: [t('help.library.search.1'), t('help.library.search.2'), t('help.library.search.3'), t('help.library.search.4'), t('help.library.search.5'), t('help.library.search.6')] },
          { style: 'logic',      heading: t('help.library.sort.heading'),   items: [t('help.library.sort.1'), t('help.library.sort.2'), t('help.library.sort.3')] },
          { style: 'logic',      heading: t('help.library.select.heading'), items: [t('help.library.select.1'), t('help.library.select.2'), t('help.library.select.3')] },
        ],
      };

    case 'deck':
      return {
        title: t('help.context.deck'),
        sections: [
          { style: 'definition', heading: t('help.deck.what.heading'),       items: [t('help.deck.what.1'), t('help.deck.what.2'), t('help.deck.what.3'), t('help.deck.what.4')] },
          { style: 'metrics',    heading: t('help.deck.metrics.heading'),    items: [t('help.deck.metrics.1'), t('help.deck.metrics.2'), t('help.deck.metrics.3'), t('help.deck.metrics.4'), t('help.deck.metrics.5')] },
          { style: 'logic',      heading: t('help.deck.cards.heading'),      items: [t('help.deck.cards.1'), t('help.deck.cards.2'), t('help.deck.cards.3'), t('help.deck.cards.4')] },
          { style: 'logic',      heading: t('help.deck.importance.heading'), items: [t('help.deck.importance.1'), t('help.deck.importance.2'), t('help.deck.importance.3')] },
        ],
      };

    case 'card':
      return { title: t('help.context.card'), sections: cardSections(ctx, route.cardId) };

    case 'study':
      return {
        title: t('help.context.study'),
        sections: [
          { style: 'definition', heading: t('help.study.how.heading'),     items: [t('help.study.how.1'), t('help.study.how.2'), t('help.study.how.3')] },
          { style: 'definition', heading: t('help.study.ratings.heading'), items: [t('help.study.ratings.1'), t('help.study.ratings.2'), t('help.study.ratings.3'), t('help.study.ratings.4'), t('help.study.ratings.5')] },
          { style: 'logic',      heading: t('help.study.during.heading'),  items: [t('help.study.during.1'), t('help.study.during.2'), t('help.study.during.3'), t('help.study.during.4')] },
          { style: 'logic',      heading: t('help.study.options.heading'), items: [t('help.study.options.1'), t('help.study.options.2'), t('help.study.options.3'), t('help.study.options.4'), t('help.study.options.5')] },
          { style: 'metrics',    heading: t('help.study.end.heading'),     items: [t('help.study.end.1'), t('help.study.end.2'), t('help.study.end.3')] },
        ],
      };

    case 'modules':
      return {
        title: t('help.context.modules'),
        sections: [
          // A picker: what each module is for, and a pointer to its own help.
          // The detail lives in the 'sessions' and 'trending' cases below.
          { style: 'definition', heading: t('help.modules.what.heading'), items: [t('help.modules.what.1'), t('help.modules.what.2')] },
          { style: 'logic',      heading: t('help.modules.list.heading'), items: [t('help.modules.list.1'), t('help.modules.list.2'), t('help.modules.list.3')] },
          { style: 'logic',      heading: t('help.modules.pin.heading'),  items: [t('help.modules.pin.1'), t('help.modules.pin.2')] },
        ],
      };

    case 'sessions':
      // The same order sessions.tsx decides its screen in: an analysis named in
      // the route wins over a job running in the background.
      if (route.sessionId) {
        return {
          title: t('help.context.sessionSummary'),
          sections: [
            { style: 'definition', heading: t('help.sessionSummary.screen.heading'),    items: [t('help.sessionSummary.screen.1'), t('help.sessionSummary.screen.2'), t('help.sessionSummary.screen.3'), t('help.sessionSummary.screen.4')] },
            detectionSection(),
            { style: 'logic',      heading: t('help.sessionSummary.recording.heading'), items: [t('help.sessionSummary.recording.1'), t('help.sessionSummary.recording.2'), t('help.sessionSummary.recording.3'), t('help.sessionSummary.recording.4')] },
            { style: 'logic',      heading: t('help.sessionSummary.edit.heading'),      items: [t('help.sessionSummary.edit.1')] },
            { style: 'logic',      heading: t('help.sessionSummary.share.heading'),     items: [t('help.sessionSummary.share.1')] },
          ],
        };
      }
      if (liveScreenActive()) {
        return {
          title: t('help.context.sessionsLive'),
          sections: [
            { style: 'definition', heading: t('help.sessionsLive.during.heading'), items: [t('help.sessionsLive.during.1'), t('help.sessionsLive.during.2'), t('help.sessionsLive.during.3'), t('help.sessionsLive.during.4'), t('help.sessionsLive.during.5'), t('help.sessionsLive.during.6')] },
            detectionSection(),
          ],
        };
      }
      if (importScreenActive()) {
        return {
          title: t('help.context.sessionsImport'),
          sections: [
            { style: 'definition', heading: t('help.sessionsImport.during.heading'), items: [t('help.sessionsImport.during.1'), t('help.sessionsImport.during.2'), t('help.sessionsImport.during.3'), t('help.sessionsImport.during.4'), t('help.sessionsImport.during.5')] },
            detectionSection(),
          ],
        };
      }
      return {
        title: t('help.context.sessions'),
        sections: [
          { style: 'definition', heading: t('help.sessions.what.heading'),     items: [t('help.sessions.what.1'), t('help.sessions.what.2'), t('help.sessions.what.3')] },
          { style: 'logic',      heading: t('help.sessions.start.heading'),    items: [t('help.sessions.start.1'), t('help.sessions.start.2'), t('help.sessions.start.3'), t('help.sessions.start.4'), t('help.sessions.start.5')] },
          { style: 'logic',      heading: t('help.sessions.analyses.heading'), items: [t('help.sessions.analyses.1'), t('help.sessions.analyses.2'), t('help.sessions.analyses.3'), t('help.sessions.analyses.4'), t('help.sessions.analyses.5')] },
          { style: 'logic',      heading: t('help.sessions.tunes.heading'),    items: [t('help.sessions.tunes.1'), t('help.sessions.tunes.2'), t('help.sessions.tunes.3'), t('help.sessions.tunes.4'), t('help.sessions.tunes.5')] },
        ],
      };

    case 'trending':
      return {
        title: t('help.context.trending'),
        sections: [
          { style: 'definition', heading: t('help.trending.what.heading'),     items: [t('help.trending.what.1'), t('help.trending.what.2'), t('help.trending.what.3')] },
          { style: 'logic',      heading: t('help.trending.settings.heading'), items: [t('help.trending.settings.1'), t('help.trending.settings.2'), t('help.trending.settings.3'), t('help.trending.settings.4')] },
          { style: 'logic',      heading: t('help.trending.list.heading'),     items: [t('help.trending.list.1'), t('help.trending.list.2')] },
        ],
      };
  }
}

function getGuideSteps(): HelpSection[] {
  return [
    { heading: t('help.guide.s1.heading'),  items: [t('help.guide.s1.1'), t('help.guide.s1.2'), t('help.guide.s1.3'), t('help.guide.s1.4')] },
    { heading: t('help.guide.s2.heading'),  items: [t('help.guide.s2.1'), t('help.guide.s2.2'), t('help.guide.s2.3'), t('help.guide.s2.4'), t('help.guide.s2.5')] },
    { heading: t('help.guide.s3.heading'),  items: [t('help.guide.s3.1'), t('help.guide.s3.2'), t('help.guide.s3.3'), t('help.guide.s3.4')] },
    { heading: t('help.guide.s4.heading'),  items: [t('help.guide.s4.1'), t('help.guide.s4.2'), t('help.guide.s4.3'), t('help.guide.s4.4'), t('help.guide.s4.5')] },
    { heading: t('help.guide.s5.heading'),  items: [t('help.guide.s5.1'), t('help.guide.s5.2'), t('help.guide.s5.3'), t('help.guide.s5.4')] },
    { heading: t('help.guide.s6.heading'),  items: [t('help.guide.s6.1'), t('help.guide.s6.2'), t('help.guide.s6.3'), t('help.guide.s6.4')] },
    { heading: t('help.guide.s7.heading'),  items: [t('help.guide.s7.1'), t('help.guide.s7.2'), t('help.guide.s7.3'), t('help.guide.s7.4')] },
    { heading: t('help.guide.s8.heading'),  items: [t('help.guide.s8.1'), t('help.guide.s8.2'), t('help.guide.s8.3'), t('help.guide.s8.4')] },
    { heading: t('help.guide.s9.heading'),  items: [t('help.guide.s9.1'), t('help.guide.s9.2'), t('help.guide.s9.3'), t('help.guide.s9.4'), t('help.guide.s9.5'), t('help.guide.s9.6')] },
    { heading: t('help.guide.s10.heading'), items: [t('help.guide.s10.1'), t('help.guide.s10.2'), t('help.guide.s10.3'), t('help.guide.s10.4'), t('help.guide.s10.5')] },
    { heading: t('help.guide.s11.heading'), items: [t('help.guide.s11.1'), t('help.guide.s11.2'), t('help.guide.s11.3')] },
  ];
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Help strings carry two marks and nothing else: `**bold**` for what a reader
 *  scans for — a button's label, the term being defined — and a backtick span
 *  for something typed or pressed exactly as written, a key or a bit of markup.
 *  Backtick spans are cut out first and never parsed further, which is what
 *  lets a line show `**gras**` literally. Built as nodes rather than HTML: these
 *  are translations, and nothing in them should be able to become markup. */
function Rich({ text }: { text: string }) {
  const out: ComponentChildren[] = [];
  text.split(/(`[^`]+`)/).forEach((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push(
        <code key={i} class="px-1 py-px rounded bg-elevated border border-border font-mono text-[11px] text-primary whitespace-nowrap">
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    part.split(/(\*\*[^*]+\*\*)/).forEach((seg, j) => {
      if (seg.length > 4 && seg.startsWith('**') && seg.endsWith('**')) {
        out.push(<strong key={`${i}-${j}`} class="font-semibold text-primary">{seg.slice(2, -2)}</strong>);
      } else if (seg) {
        out.push(seg);
      }
    });
  });
  return <>{out}</>;
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
                  <span class="shrink-0 flex items-center mt-0.5 self-start pt-1" style={{ color: accent }} dangerouslySetInnerHTML={{ __html: CHECK_SVG }} />
                  <span><Rich text={item} /></span>
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
                  <span><Rich text={item} /></span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
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

type HelpTabId = 'info' | 'guide';

function HelpModalContent({ sections, initialTab }: { sections: HelpSection[]; initialTab: HelpTabId }) {
  const [activeTab, setActiveTab] = useState<HelpTabId>(initialTab);
  const rootRef = useRef<HTMLDivElement>(null);

  // The guide runs long. Switching tabs while scrolled down it would otherwise
  // land the other tab halfway through, with its top out of sight — so the
  // dialog's own scroller goes back to the top on every switch.
  //
  // Found by its overflow style, not by "taller inside than out": the tab row
  // itself overflows by the 1 px its underlined buttons hang below it, and a
  // size test stopped there and scrolled nothing (measured in a browser).
  const switchTo = (tab: HelpTabId) => {
    setActiveTab(tab);
    let node = rootRef.current?.parentElement ?? null;
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
    node?.scrollTo({ top: 0 });
  };

  return (
    <div ref={rootRef} class="flex flex-col gap-4 -mx-5 -my-4">
      <div class="flex border-b border-border px-5">
        <HelpTab label={t('help.tabInfo')}  active={activeTab === 'info'}  onClick={() => switchTo('info')} />
        <HelpTab label={t('help.tabGuide')} active={activeTab === 'guide'} onClick={() => switchTo('guide')} />
      </div>
      <div class="px-5 pb-4">
        {activeTab === 'info' ? <InfoBody sections={sections} /> : <GuideBody steps={getGuideSteps()} />}
      </div>
    </div>
  );
}

/** `tab: 'guide'` opens straight on the user guide — what a brand-new user
 *  is shown on arrival, when a page they have not used yet has nothing to
 *  explain to them. The ? button keeps opening on the page it is pressed on. */
export function showHelpModal(ctx: AppContext, opts: { tab?: HelpTabId } = {}): void {
  const { title, sections } = getInfoContent(ctx);
  const { el, cleanup } = renderModalBody(<HelpModalContent sections={sections} initialTab={opts.tab ?? 'info'} />);
  showModal(t('help.title', { context: title }), el, [], { maxWidth: '36rem', expandable: true, onDismiss: cleanup });
}
