import { useState } from 'preact/hooks';
import { cardOfTuneId } from '../detections';
import type { AppContext, Card } from '../../types';
import { t } from '../../services/i18nService';
import { PlusIcon } from '../../components/icons';
import { IconButton } from '../../components/ui';
import { findByExternalId, fetchTuneById, tuneResultToCard } from '../../services/theSessionService';
import { addCardsToDecks } from '../../services/deckService';
import { isCardId } from '../recognition/cardIndex';
import { showDeckChoiceModal, decksContainingCard, isInEveryDeck, deckAddIcon } from '../../components/deckSelector';
import { mutateWithRule } from '../../services/attachmentStore';
import { getContext } from '../../store';
import { hasLibrary } from '../../services/pageMode';

// Out of sessionUiShared.tsx since 2026-11-26.

// ── The one button that turns a recognised tune into a card ──────────────────
// Lifted out of DetectionCard (2026-09-12) when the tune ranking needed the
// same control: this is a subtle enough flow — fetch, then ask, then write,
// with a re-check inside the transaction — that a second copy of it would be
// a second thing to get wrong. DetectionCard renders it per DETECTION, the
// ranking per TUNE; neither knows anything the other does not.

export interface TuneDeckButtonProps {
  tuneId: string;
  ctx: AppContext;
  /** Decks pinned on the page this belongs to — they come back ticked in the
   *  deck choice modal. */
  getPinnedDeckIds?: () => Set<string>;
  onCardAdded?: () => void;
  /** As tuneName's: given by a list drawing one button per row. */
  cardOf?: (tuneId: string) => Card | undefined;
}

export function TuneDeckButton({ tuneId, ctx, getPinnedDeckIds, onCardAdded, cardOf }: TuneDeckButtonProps) {
  const known = cardOf ? cardOf(tuneId) : cardOfTuneId(tuneId, getContext().user.cards);
  const [busy, setBusy] = useState(false);

  /** Writes the already-fetched card. Split from the fetch on purpose: the tune
   *  is downloaded BEFORE the deck question is asked, so a failed lookup never
   *  wastes the user's answer, and dismissing the modal imports nothing at all.
   *
   *  The gap between fetch and commit is wide enough for the same tune to have
   *  arrived by another route in the meantime, so the externalId is re-checked
   *  inside the transaction rather than trusted from before it. */
  const commitAdd = async (card: Card, deckIds: string[]) => {
    setBusy(true);
    try {
      await mutateWithRule(s => {
        const existing = card.externalId ? findByExternalId(card.externalId, s.cards) : undefined;
        const id = existing?.id ?? card.id;
        if (!existing) s.cards[id] = card;
        addCardsToDecks(s, deckIds, [id]);
      });
      onCardAdded?.();
    } finally {
      setBusy(false);
    }
  };

  const doLink = async (deckIds: string[]) => {
    if (!known) return;
    setBusy(true);
    try {
      await ctx.mutate(s => { addCardsToDecks(s, deckIds, [known.id]); });
    } finally {
      setBusy(false);
    }
  };

  // Every add and every link asks where the card goes. With no deck at all
  // there is nothing to ask, so creating goes straight through — and the link
  // button is not rendered in the first place, since linking to nothing is not
  // an action.
  const onAddClick = (e: MouseEvent) => {
    e.stopPropagation();
    void (async () => {
      setBusy(true);
      let card: Card;
      try {
        card = tuneResultToCard(await fetchTuneById(Number(tuneId)));
      } catch {
        setBusy(false);   // nothing was fetched, so nothing is asked and nothing is written
        return;
      }
      setBusy(false);
      showDeckChoiceModal({
        pinned: getPinnedDeckIds?.() ?? new Set(),
        onConfirm: (deckIds) => { void commitAdd(card, deckIds); },
      });
    })();
  };

  const onLinkClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!known) return;
    showDeckChoiceModal({
      pinned: getPinnedDeckIds?.() ?? new Set(),
      alreadyIn: decksContainingCard(known.id),
      onConfirm: (deckIds) => { void doLink(deckIds); },
    });
  };

  // The 24 px disc is the drawing; the button around it is the 32 px target
  // (styles.css, .icon-disc).

  // The standalone analyser has no library to add to (pageMode.ts).
  if (!hasLibrary()) return null;
  // A card's own tune (cardIndex.ts) whose card is gone: nothing to fetch it
  // from, so nothing to add.
  if (!known && isCardId(tuneId)) return null;
  if (!known) {
    return (
      <IconButton label={t('sessions.addCard')} class="hover:bg-transparent" disabled={busy} onClick={onAddClick}>
        <span class="icon-disc"><PlusIcon size={12} /></span>
      </IconButton>
    );
  }
  // Dimmed, not disabled, once the card is in every deck: there is nothing
  // left to add, but this is also the only place that shows WHERE it already
  // sits, so it stays open for a look.
  const everyDeck = isInEveryDeck(known.id);
  return (
    <IconButton
      label={everyDeck ? t('deckChoice.inEveryDeck') : t('sessions.linkToDeck')}
      class={`hover:bg-transparent ${everyDeck ? 'opacity-40' : ''}`}
      disabled={busy}
      onClick={onLinkClick}
    >
      <span class="icon-disc" dangerouslySetInnerHTML={{ __html: deckAddIcon }} />
    </IconButton>
  );
}
