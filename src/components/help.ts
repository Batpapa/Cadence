import type { AppContext, Route } from '../types';
import { showModal, closeModal } from './modal';
import { t } from '../services/i18nService';

type HelpSection = { heading: string; items: string[] };

function getHelpContent(route: Route): { title: string; sections: HelpSection[] } {
  switch (route.view) {

    case 'folder':
      return route.folderId ? {
        title: t('help.context.folder'),
        sections: [
          {
            heading: t('help.folder.what.heading'),
            items: [t('help.folder.what.1'), t('help.folder.what.2'), t('help.folder.what.3')],
          },
        ],
      } : {
        title: t('help.context.home'),
        sections: [
          {
            heading: t('help.home.welcome.heading'),
            items: [t('help.home.welcome.1'), t('help.home.welcome.2'), t('help.home.welcome.3')],
          },
          {
            heading: t('help.home.nav.heading'),
            items: [t('help.home.nav.1'), t('help.home.nav.2'), t('help.home.nav.3')],
          },
        ],
      };

    case 'library':
      return {
        title: t('help.context.library'),
        sections: [
          {
            heading: t('help.library.browse.heading'),
            items: [
              t('help.library.browse.1'),
              t('help.library.browse.2'),
              t('help.library.browse.3'),
              t('help.library.browse.4'),
            ],
          },
        ],
      };

    case 'deck':
      return {
        title: t('help.context.deck'),
        sections: [
          {
            heading: t('help.deck.study.heading'),
            items: [t('help.deck.study.1'), t('help.deck.study.2'), t('help.deck.study.3')],
          },
          {
            heading: t('help.deck.manage.heading'),
            items: [t('help.deck.manage.1'), t('help.deck.manage.2'), t('help.deck.manage.3'), t('help.deck.manage.4')],
          },
          {
            heading: t('help.deck.bar.heading'),
            items: [t('help.deck.bar.1'), t('help.deck.bar.2'), t('help.deck.bar.3'), t('help.deck.bar.4')],
          },
        ],
      };

    case 'card':
      return {
        title: t('help.context.card'),
        sections: [
          {
            heading: t('help.card.edit.heading'),
            items: [t('help.card.edit.1'), t('help.card.edit.2'), t('help.card.edit.3'), t('help.card.edit.4')],
          },
          {
            heading: t('help.card.fsrs.heading'),
            items: [t('help.card.fsrs.1'), t('help.card.fsrs.2'), t('help.card.fsrs.3')],
          },
        ],
      };

    case 'study':
      return {
        title: t('help.context.study'),
        sections: [
          {
            heading: t('help.study.rating.heading'),
            items: [t('help.study.rating.1'), t('help.study.rating.2'), t('help.study.rating.3'), t('help.study.rating.4')],
          },
          {
            heading: t('help.study.shortcuts.heading'),
            items: [t('help.study.shortcuts.1'), t('help.study.shortcuts.2'), t('help.study.shortcuts.3'), t('help.study.shortcuts.4')],
          },
          {
            heading: t('help.study.fsrs.heading'),
            items: [t('help.study.fsrs.1'), t('help.study.fsrs.2'), t('help.study.fsrs.3')],
          },
        ],
      };
  }
}

function buildHelpBody(sections: HelpSection[]): HTMLElement {
  const body = document.createElement('div');
  body.className = 'space-y-4';

  for (const section of sections) {
    const block = document.createElement('div');
    block.className = 'space-y-1.5';

    const heading = document.createElement('div');
    heading.className = 'section-title';
    heading.textContent = section.heading;
    block.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'space-y-1';
    for (const item of section.items) {
      const li = document.createElement('li');
      li.className = 'text-xs text-muted leading-relaxed flex gap-2';
      const dot = document.createElement('span'); dot.className = 'text-dim shrink-0 mt-0.5'; dot.textContent = '·';
      const text = document.createElement('span'); text.textContent = item;
      li.append(dot, text);
      list.appendChild(li);
    }
    block.appendChild(list);
    body.appendChild(block);
  }

  return body;
}

export function showHelpModal(ctx: AppContext): void {
  const { title, sections } = getHelpContent(ctx.route);
  showModal(t('help.title', { context: title }), buildHelpBody(sections), [
    { label: t('common.close'), onClick: closeModal },
  ]);
}
