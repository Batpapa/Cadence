import type { ComponentChild } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { appState, navigate } from '../../store';
import { showModal, closeModalOf, renderModalBody, updateTopModal, MODAL_W } from '../../components/modal';
import { showDeckChoiceModal } from '../../components/deckSelector';
import { CardSearchField } from '../../components/cardSearchField';
import { ChoiceCard } from '../../components/ui';
import { ArrowRightIcon, SearchIcon } from '../../components/icons';
import { ICON_CREATE } from '../../components/theSessionImport';
import { successLine, errorLine } from '../../components/importAtoms';
import { transcriptionModuleOf, type TranscriptionRecord } from '../model';
import { createCard, addToCard } from '../cards';

// ── Into the cards ───────────────────────────────────────────────────────────
// One way in, "Add to a card" (2026-11-28, the user: one button for both), as
// the app's own "New card" dialog is laid out (theSessionImport.tsx): a choice,
// then its step, back to the choice by the header's arrow.
//   - A new card: its name, Create, the deck choice every new card asks
//     (deckSelector.tsx) — the transcription's ABC its score.
//   - An existing card: picked in the search, which is the whole act — the
//     ABC added as a new file of its own (the user: no version into one of
//     its files; the card's own editor is where versions are made).
// Either way the dialog stays, saying what was done, the card's name the way to
// it — no going there of itself: the transcription is what is on screen. The
// transcription is read afresh at each act — a correction saved since is what
// goes.

const fresh = (id: string): TranscriptionRecord | undefined => transcriptionModuleOf(appState.value)?.transcriptions[id];

/** "« X » created." with X the way to the card. */
function doneLine(key: string, name: string, onOpenCard: () => void): ComponentChild {
  const [before, after] = t(key, { name: '\x00' }).split('\x00');
  return successLine(<>{before}<span class="text-accent cursor-pointer hover:underline" onClick={onOpenCard}>{name}</span>{after}</>);
}

type Step = 'root' | 'create' | 'existing';

function ToCard({ record, onOpenCard }: { record: TranscriptionRecord; onOpenCard: (cardId: string) => void }) {
  const [step, setStep] = useState<Step>('root');
  useEffect(() => {
    if (step === 'root') updateTopModal({ title: t('transcription.toCard.add'), onBack: undefined });
    else updateTopModal({ title: t(step === 'create' ? 'transcription.toCard.newCard' : 'transcription.toCard.existing'), onBack: () => setStep('root') });
  }, [step]);
  if (step === 'create') return <CreateStep record={record} onOpenCard={onOpenCard} />;
  if (step === 'existing') return <ExistingStep record={record} onOpenCard={onOpenCard} />;
  return (
    <div class="flex flex-col gap-3">
      {/* The "New card" dialog's first row, its icon too; no line under
          either: the names say it (2026-11-28, the user). */}
      <ChoiceCard icon={<span class="flex" dangerouslySetInnerHTML={{ __html: ICON_CREATE }} />} label={t('transcription.toCard.newCard')} trailing={<ArrowRightIcon size={16} />} onClick={() => setStep('create')} />
      <ChoiceCard icon={<SearchIcon size={20} />} label={t('transcription.toCard.existing')} trailing={<ArrowRightIcon size={16} />} onClick={() => setStep('existing')} />
    </div>
  );
}

/** A new card, as the app's own card creation (CreateStep). */
function CreateStep({ record, onOpenCard }: { record: TranscriptionRecord; onOpenCard: (cardId: string) => void }) {
  const [name, setName] = useState(record.name);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ComponentChild>('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const create = () => {
    const chosen = name.trim();
    if (!chosen || busy) { inputRef.current?.focus(); return; }
    showDeckChoiceModal({
      pinned: new Set(),
      onConfirm: (deckIds) => {
        const r = fresh(record.id);
        if (!r) { setStatus(errorLine(t('transcription.notFound'))); return; }
        setBusy(true);
        void createCard(r, chosen, deckIds)
          .then((cardId) => setStatus(doneLine('newCard.create.done', chosen, () => onOpenCard(cardId))))
          .catch((e: unknown) => { console.warn('[transcription] card not made', e); setStatus(errorLine(t('transcription.toCard.failed'))); })
          .finally(() => setBusy(false));
      },
    });
  };

  return (
    <div class="flex flex-col gap-3">
      <label class="label" for="transcription-card-name">{t('newCard.nameLabel')}</label>
      <input
        ref={inputRef}
        id="transcription-card-name"
        type="text"
        class="input"
        placeholder={t('newCard.namePlaceholder')}
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
      />
      <button type="button" class="btn-primary w-full mt-1" disabled={busy || !name.trim()} onClick={create}>
        {t('newCard.createBtn')}
      </button>
      <div class="text-xs text-muted min-h-[1.25rem]">{status}</div>
    </div>
  );
}

/** An existing card: the one picked gets the ABC, as a file of its own. */
function ExistingStep({ record, onOpenCard }: { record: TranscriptionRecord; onOpenCard: (cardId: string) => void }) {
  const [status, setStatus] = useState<ComponentChild>('');
  return (
    <div class="flex flex-col gap-3">
      <CardSearchField
        placeholder={t('transcription.toCard.search')}
        autoFocus
        onPick={(card) => {
          const r = fresh(record.id);
          if (!r) { setStatus(errorLine(t('transcription.notFound'))); return; }
          void addToCard(r, card.id)
            .then(() => setStatus(doneLine('transcription.toCard.added', card.name, () => onOpenCard(card.id))))
            .catch((e: unknown) => {
              console.warn('[transcription] not added', e);
              setStatus(errorLine(t(appState.value.cards[card.id] ? 'transcription.toCard.failed' : 'transcription.toCard.cardGone')));
            });
        }}
      />
      <div class="text-xs text-muted min-h-[1.25rem]">{status}</div>
    </div>
  );
}

export function showAddToCard(record: TranscriptionRecord): void {
  const holder: { el?: HTMLElement } = {};
  const { el, cleanup } = renderModalBody(
    <ToCard record={record} onOpenCard={(cardId) => { if (holder.el) closeModalOf(holder.el); cleanup(); navigate({ view: 'card', cardId }); }} />,
  );
  holder.el = el;
  showModal(t('transcription.toCard.add'), el, [], { maxWidth: MODAL_W.m, onDismiss: cleanup });
}
