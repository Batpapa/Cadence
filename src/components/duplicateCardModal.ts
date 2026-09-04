import { mutate } from '../store';
import { showModal, closeModal } from './modal';
import { removeCards } from '../services/cardService';
import { t } from '../services/i18nService';
import type { Card } from '../types';

interface DuplicateModalOptions {
  /** Where clicking a listed card goes. Its presence is also what decides
   *  whether the cards are listed at all: naming them is only worth the room
   *  when you can go and look at one, and from the card page the single card
   *  concerned is the one already on screen. */
  onPick?: (card: Card) => void;
  /** Run after the cards are deleted, for a caller that was showing one. */
  onDeleted?: () => void;
}

/** What to do with IrishTuneInfo cards whose TheSession version is already in
 *  the library. Migrating them would leave two cards claiming the same
 *  `externalId` — a state nothing else in the app expects — so the migration
 *  holds them back and this asks what should become of them.
 *
 *  Picking for the user would be wrong either way: the IrishTuneInfo card may
 *  carry decks and a review history worth keeping, or may be the redundant
 *  half of a double import. So it names every card it is about, says what
 *  deleting costs, and leaves the choice.
 *
 *  Shared by the library's bulk migration — where it arrives at the end with
 *  everything that was held back — and by a single card's own migrate action,
 *  which lands here instead of migrating. */
export function showDuplicateCardsModal(cards: Card[], opts: DuplicateModalOptions = {}): void {
  const one = cards.length === 1;
  const body = document.createElement('div');
  body.className = 'space-y-3';

  const p = document.createElement('p');
  p.className = 'text-sm text-muted leading-relaxed';
  p.textContent = t(one ? 'card.duplicate.body' : 'card.duplicate.bodyPlural', { n: cards.length });
  body.appendChild(p);

  const onPick = opts.onPick;
  if (onPick) {
    const list = document.createElement('div');
    list.className = 'space-y-1 max-h-40 overflow-y-auto';
    for (const card of cards) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'w-full text-left text-xs truncate px-2 py-1.5 rounded text-muted hover:text-primary hover:bg-accent/10 transition-colors cursor-pointer';
      row.textContent = card.name;
      row.onclick = () => onPick(card);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  // The danger button IS the confirmation: the sentence says what deleting
  // costs and the cards are named right above it whenever there is more than
  // the one you are already looking at, so a second dialog on top of this one
  // would only be a speed bump.
  showModal(t('card.duplicate.title'), body, [
    { label: t(one ? 'card.duplicate.ignore' : 'card.duplicate.ignorePlural'), onClick: closeModal },
    {
      label: t(one ? 'card.duplicate.delete' : 'card.duplicate.deletePlural', { n: cards.length }),
      danger: true,
      onClick: () => {
        closeModal();
        void mutate(s => removeCards(s, cards.map(c => c.id)));
        opts.onDeleted?.();
      },
    },
  ]);
}
