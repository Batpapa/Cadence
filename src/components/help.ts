import type { AppContext, Route } from '../types';
import { showModal, closeModal } from './modal';

type HelpSection = { heading: string; items: string[] };

function getHelpContent(route: Route): { title: string; sections: HelpSection[] } {
  switch (route.view) {

    case 'folder':
      return {
        title: route.folderId ? 'Folder' : 'Home',
        sections: [
          ...(!route.folderId ? [{
            heading: 'Welcome to Cadence',
            items: [
              'Cadence is a spaced repetition app — it helps you organise your practice sessions and track what you know.',
              'Create cards for the things you want to learn, organise them into decks, and study regularly.',
              'The more you practise, the better Cadence understands what you know — and surfaces what you\'re most likely to have forgotten.',
              'Works for any learning topic. A dedicated module makes it easy to import tunes directly from TheSession.',
            ],
          }] : []),
          {
            heading: 'Navigation',
            items: [
              'Click a folder or deck to open it.',
              'Drag & drop folders and decks in the sidebar to reorganise them.',
              '← → in the top bar (or Alt+← / Alt+→) to navigate history.',
            ],
          },
          {
            heading: 'Creating content',
            items: [
              '+ Folder / + Deck at the bottom of the sidebar to create at the root.',
              'Use the "+ New folder" and "+ New deck" buttons inside a folder.',
              'Click a folder or deck name directly to rename it.',
            ],
          },
          {
            heading: 'Dashboard (Home only)',
            items: [
              'The dashboard shows your global study streak, sessions this week, and knowledge distribution.',
              '"Decks to review" highlights the decks with the lowest retention.',
              'Switch the activity chart between 7 days, 1 month, and 1 year.',
            ],
          },
        ],
      };

    case 'library':
      return {
        title: 'Card library',
        sections: [
          {
            heading: 'Browsing',
            items: [
              'Search by name or tag using the search bar.',
              'Click a tag pill to filter by that tag — multiple tags are combined (AND).',
              'The coloured dot shows current retention: red < 40%, yellow < 75%, green ≥ 75%.',
              'Hover a row to see which decks the card belongs to — click a deck chip to navigate.',
            ],
          },
          {
            heading: 'Selection & deletion',
            items: [
              'Tick the checkbox on a row (appears on hover) to select it.',
              '"Select all" selects all currently filtered cards.',
              'The trash button deletes all selected cards from the library and all decks.',
            ],
          },
          {
            heading: 'Adding cards',
            items: [
              '"+ New card" opens the creation modal — create a blank card or import from TheSession.',
            ],
          },
        ],
      };

    case 'deck':
      return {
        title: 'Deck',
        sections: [
          {
            heading: 'Studying',
            items: [
              '"Study" opens a session with the chosen strategy.',
              'Random — picks any non-mastered card at random.',
              'Optimal — picks the card with the highest urgency (importance × forgetting).',
              'Stochastic — weighted random, balancing urgency and variety.',
            ],
          },
          {
            heading: 'Managing cards',
            items: [
              'Drag a card row to reorder it in the deck.',
              'Click the ×N importance badge to override a card\'s weight for this deck.',
              'Click the broken-link icon to remove a card from the deck (card is not deleted).',
              'Click a card name to open its detail view.',
            ],
          },
          {
            heading: 'Knowledge bar',
            items: [
              'Red = not yet learned, yellow = learning, light green = good, green = mastered.',
              'A card is considered mastered when its retention exceeds your mastery threshold.',
            ],
          },
        ],
      };

    case 'card':
      return {
        title: 'Card',
        sections: [
          {
            heading: 'Editing',
            items: [
              'Click the card name to rename it inline.',
              'Click a tag to rename it; hover a tag and click ✕ to remove it.',
              'Type in the "+" input to add a new tag (Enter or comma to confirm).',
              'Click the broken-link icon on a deck chip to remove the card from that deck.',
              'Click "+" next to the deck chips to add the card to another deck.',
            ],
          },
          {
            heading: 'FSRS — Mastery window',
            items: [
              'The mastery window shows how long after a review the card stays above your mastery threshold.',
              'A longer mastery window means the card is solidly learned.',
            ],
          },
          {
            heading: 'Review history',
            items: [
              'Click "+" in the review history to manually log a past session.',
              'Hover an entry and click ✕ to remove it.'
            ],
          },
        ],
      };

    case 'study':
      return {
        title: 'Study session',
        sections: [
          {
            heading: 'Rating a card',
            items: [
              '✗ Failed (1) — you did not remember it at all.',
              '△ Struggled (2) — you recalled it with difficulty.',
              '○ Got it (3) — correct recall with some effort.',
              '✓ Nailed it (4) — perfect, effortless recall.',
            ],
          },
          {
            heading: 'Keyboard shortcuts',
            items: [
              '1 / 2 / 3 / 4 — rate the card.',
              'Tab — skip without rating (disabled when only one card remains).',
              'Esc — exit the session and return to the deck.',
            ],
          },
          {
            heading: 'FSRS algorithm',
            items: [
              'Each rating updates the card\'s Stability (S) and Difficulty (D).',
              'Higher grades increase stability — the card will be shown less often.',
              '"Failed" triggers a forgetting reset, strongly reducing stability.',
              'Cards above your mastery threshold are skipped automatically.',
            ],
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
  showModal(`Help — ${title}`, buildHelpBody(sections), [
    { label: 'Close', onClick: closeModal },
  ]);
}
