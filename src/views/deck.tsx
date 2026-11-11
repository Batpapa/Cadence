import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate, getContext, leaveDeletedPage } from '../store';
import { pct, timeAgo, availabilityColor, addTouchDragSupport } from '../utils';
import { CardSearchField } from '../components/cardSearchField';
import { TrashIcon, StarIcon, PlusIcon, LibraryIcon, ChevronDownIcon } from '../components/icons';
import { IconButton, Metric, EmptyState } from '../components/ui';
import { confirmModal, confirmModalWithOption } from '../components/modal';
import { CustomSelect } from '../components/customSelect';
import { findParentFolder, orphanedCardsAfterDeckRemoval, folderPath, moveDeckToParent } from '../services/deckService';
import { removeCards } from '../services/cardService';
import { deckAvailability, cardAvailability, effectiveImportance, isAvailable, deckStability, deckEase, replayFSRS, retentionWindowDays } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import { StudyButton, useRoomForStudyLabel } from '../components/studyModal';
import { showNewCardModal } from '../components/theSessionImport';


function formatDays(d: number): string {
  if (d >= 365) return t('common.durationYears',    { n: (d / 365).toFixed(1) });
  if (d >= 30)  return t('common.durationMonths',   { n: Math.round(d / 30) });
  if (d >= 1)   return t('common.durationDays',     { n: Math.round(d) });
  return t('common.durationLessThanDay');
}



export function DeckView({ deckId }: { deckId: string }) {
  const user      = appState.value;
  const deck      = user.decks[deckId];
  const profileId = user.currentProfileId;
  const w         = user.weightByImportance ?? true;

  // Inline name editing
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName]           = useState('');
  // Study's label in the header, while the name fits beside it on one line.
  const headerRef    = useRef<HTMLDivElement>(null);
  const roomForLabel = useRoomForStudyLabel(headerRef, [deck?.name, isEditingName]);

  // Inline deck importance editing
  const [editingImportanceId, setEditingImportanceId] = useState<string | null>(null);
  const [importanceDraft, setImportanceDraft] = useState('');
  const importanceInputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (editingImportanceId && importanceInputRef.current) {
      importanceInputRef.current.focus();
      importanceInputRef.current.select();
    }
  }, [editingImportanceId]);

  // Drag-and-drop — ref for active drag id (avoids re-renders on every dragover)
  const draggedId = useRef<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget]     = useState<{ cardId: string; zone: 'before' | 'after' } | null>(null);

  if (!deck) return <div class="flex flex-col h-full view-enter">{t('deck.notFound')}</div>;

  // ── Metrics ──────────────────────────────────────────────────────────────────
  const avail       = deckAvailability(user, profileId, deck, user.cards, user.cardWorks, w);
  const stab        = deckStability(profileId, deck, user.cards, user.cardWorks, w);
  const ease        = deckEase(profileId, deck, user.cards, user.cardWorks, w);
  const stabWindow  = stab > 0 ? retentionWindowDays(stab, user.availabilityThreshold, user.forgettingRate ?? 1) : 0;
  const candidates  = deck.entries.filter(e => !isAvailable(user, user.cardWorks[`${profileId}:${e.cardId}`])).length;
  const noCards     = deck.entries.length === 0;
  const allMastered = !noCards && candidates === 0;

  // ── Quick link: the cards not in this deck yet ───────────────────────────────
  const alreadyInDeck = new Set(deck.entries.map(e => e.cardId));

  // ── Drag handlers ─────────────────────────────────────────────────────────────
  const onDragStart = (cardId: string, e: DragEvent) => {
    draggedId.current = cardId;
    e.dataTransfer?.setData('text/plain', cardId);
    setTimeout(() => setActiveDragId(cardId), 0);
  };
  const onDragEnd = () => { draggedId.current = null; setActiveDragId(null); setDropTarget(null); };
  const onDragOver = (cardId: string, e: DragEvent) => {
    if (!draggedId.current || draggedId.current === cardId) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone: 'before' | 'after' = (e.clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after';
    if (dropTarget?.cardId !== cardId || dropTarget?.zone !== zone) setDropTarget({ cardId, zone });
  };
  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget(null);
  };
  const onDrop = (cardId: string, e: DragEvent) => {
    const fromId = draggedId.current;
    if (!fromId || fromId === cardId) return;
    e.preventDefault();
    const rect   = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = (e.clientY - rect.top) / rect.height < 0.5;
    setDropTarget(null);
    draggedId.current = null;
    mutate(s => {
      const entries = s.decks[deckId]!.entries;
      const from    = entries.findIndex(en => en.cardId === fromId);
      if (from === -1) return;
      const [moved] = entries.splice(from, 1);
      const to      = entries.findIndex(en => en.cardId === cardId);
      if (to === -1) { entries.push(moved); return; }
      entries.splice(before ? to : to + 1, 0, moved);
    });
  };

  const parentId = findParentFolder(deckId, 'deck', user);
  const parentOptions = [
    { value: '', label: t('folder.title.home') },
    ...Object.values(user.folders)
      .map(f => ({ value: f.id, label: folderPath(f.id, user) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  return (
    <div class="overflow-y-auto h-full view-enter">

      {/* ── Top section ── */}
      <div class="px-6 pt-6 pb-4 space-y-6">

        {/* Header */}
        {/* The actions stay top right, always (the author, 2026-11-11). When
            the row runs short, Study's label goes first, then the name wraps
            (useRoomForStudyLabel). */}
        <div ref={headerRef} class="flex items-start justify-between gap-4">
          <div class="flex-auto min-w-0">
            <div class="flex items-center gap-2">
              <IconButton
                data-tour="deck-star"
                class={`-ml-1.5 ${deck.favorite ? 'text-gold hover:text-gold' : 'hover:text-gold'}`}
                label={deck.favorite ? t('deck.unfavorite') : t('deck.favorite')}
                aria-pressed={!!deck.favorite}
                onClick={() => mutate(s => { const d = s.decks[deckId]; if (d) d.favorite = !d.favorite; })}
              >
                <StarIcon size={20} filled={!!deck.favorite} />
              </IconButton>
              <div class="flex-1 min-w-0">
            {isEditingName ? (
              <input
                type="text"
                value={editName}
                autoFocus
                class="text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full"
                onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
                onBlur={() => {
                  const val = editName.trim();
                  if (val && val !== deck.name) mutate(s => { s.decks[deckId]!.name = val; });
                  setIsEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setIsEditingName(false);
                }}
              />
            ) : (
              <h1
                class="text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors"
                title={t('common.clickToRename')}
                onClick={() => { setEditName(deck.name); setIsEditingName(true); }}
              >
                {deck.name}
              </h1>
            )}
              </div>
            </div>
            <div class="flex items-center gap-1 mt-1" data-tour="deck-location">
              <span class="text-2xs font-medium uppercase tracking-wider text-dim">{t('folder.parent.label')}</span>
              <CustomSelect
                value={parentId ?? ''}
                options={parentOptions}
                onChange={(v) => mutate(s => moveDeckToParent(s, deckId, v || null))}
                renderTrigger={(label, open, toggle) => (
                  <button
                    type="button"
                    class="text-2xs font-medium text-dim cursor-pointer hover:text-accent transition-colors flex items-center gap-0.5 shrink-0 whitespace-nowrap"
                    onClick={toggle}
                  >
                    {label}
                    <span class={`shrink-0 flex transition-transform ${open ? 'rotate-180' : ''}`}><ChevronDownIcon size={12} /></span>
                  </button>
                )}
              />
            </div>
          </div>
          <div class="flex gap-2 shrink-0">
            {/* Stays clickable when all cards are mastered: the study modal
                hosts the "exclude mastered" toggle that unlocks that case,
                and one press opens it when nothing would come up. */}
            <StudyButton
              opts={{ entries: deck.entries, title: deck.name, defaultContext: deckId, deckId }}
              label={t('deck.study')}
              title={t('deck.studyTitle')}
              disabled={noCards}
              showLabel={roomForLabel}
            />
            <IconButton
              variant="danger"
              label={t('deck.deleteTitle')}
              onClick={() => {
                const doDelete = (deleteOrphans: boolean) => {
                  const parent = findParentFolder(deckId, 'deck', user);
                  mutate(s => {
                    if (deleteOrphans) removeCards(s, orphanedCardsAfterDeckRemoval([deckId], s));
                    delete s.decks[deckId];
                    if (parent) s.folders[parent]!.deckIds = s.folders[parent]!.deckIds.filter(id => id !== deckId);
                    else s.rootDeckIds = s.rootDeckIds.filter(id => id !== deckId);
                  });
                  leaveDeletedPage();
                };
                const orphans = orphanedCardsAfterDeckRemoval([deckId], user);
                if (orphans.length > 0) {
                  confirmModalWithOption(
                    t('deck.delete.title'),
                    t('deck.delete.message', { name: deck.name }),
                    t('common.delete'),
                    t(orphans.length !== 1 ? 'common.deleteOrphanCardsPlural' : 'common.deleteOrphanCards', { count: orphans.length }),
                    doDelete,
                  );
                } else {
                  confirmModal(
                    t('deck.delete.title'),
                    t('deck.delete.message', { name: deck.name }),
                    t('common.delete'),
                    () => doDelete(false),
                  );
                }
              }}
            >
              <TrashIcon size={14} />
            </IconButton>
          </div>
        </div>

        {/* Metrics — single evenly-spaced inline row */}
        <div class="stats-container border-y border-border" data-tour="deck-stats">
        <div class="stats-grid py-3 px-4 gap-x-4 gap-y-3 justify-items-center">
          {/* A zero reads in the muted grey, as on the card page: nothing yet,
              not a figure to take in. */}
          <Metric
            label={t('deck.section.availability')}
            value={pct(avail)}
            colorClass={avail >= 0.75 ? 'text-success' : avail >= 0.4 ? 'text-warn' : avail > 0 ? 'text-danger' : 'text-dim'}
          />
          <Metric
            label={t('deck.section.stability')}
            value={stabWindow > 0 ? formatDays(stabWindow) : '—'}
          />
          <Metric
            label={t('deck.section.ease')}
            value={ease > 0 ? pct(ease) : '—'}
            colorClass={ease >= 0.6 ? 'text-success' : ease >= 0.35 ? 'text-warn' : ease > 0 ? 'text-danger' : 'text-dim'}
          />
          <Metric
            label={t('deck.section.mastery')}
            value={noCards ? '—' : `${deck.entries.length - candidates}/${deck.entries.length}`}
            colorClass={allMastered ? 'text-success' : 'text-primary'}
          />
        </div>
        </div>

      </div>

      {/* The cards, header and list: one block for the walkthrough to light
          (walkthrough/), the field's list of matches hanging over the rows. */}
      <div data-tour="deck-cards">
      {/* ── Cards header + quick-link ── */}
      {/* Wraps: on a phone the title, the field and its two buttons did not
          fit on one line, and the + ran off the screen's right edge
          (measured on an iPhone 14, before and after the 32 px targets). */}
      <div class="flex flex-wrap items-center justify-between gap-2 px-6 pb-2">
        <div class="flex items-center gap-2">
          <span class="section-title">{t('deck.section.cards', { count: deck.entries.length })}</span>
          <IconButton
            variant="outline"
            data-tour="deck-library-btn"
            label={t('deck.viewInLibrary')}
            onClick={() => navigate({ view: 'library', decks: [[deckId, 'include']] })}
          >
            <LibraryIcon size={14} />
          </IconButton>
        </div>

        <div class="flex items-center gap-2 ml-auto">
          {/* The field every card search uses (cardSearchField.tsx), with the
              wording of this one: it links, it does not just search. */}
          <div class="w-44">
            <CardSearchField
              floating
              compact
              placeholder={t('deck.quickLink.placeholder')}
              noMatch={t('deck.quickLink.noMatch')}
              eligible={(c) => !alreadyInDeck.has(c.id)}
              onPick={(card) => mutate(s => { s.decks[deckId]!.entries.push({ cardId: card.id }); })}
            />
          </div>
          <IconButton
            variant="outline"
            data-tour="deck-add-btn"
            label={t('deck.addCards')}
            onClick={() => showNewCardModal(getContext(), [deckId])}
          >
            <PlusIcon size={14} />
          </IconButton>
        </div>
      </div>

      {/* ── Cards list ── */}
      <div class="px-6 pb-6" data-tour="deck-card-list">
        <div class="space-y-3">
          {deck.entries.length === 0 ? (
            <EmptyState>{t('deck.empty')}</EmptyState>
          ) : (
            <div class="lib-list space-y-1">
              {(() => {
                const impColWidth = Math.max(...deck.entries.map(e => {
                  const c = user.cards[e.cardId]; if (!c) return 2;
                  return String(`×${effectiveImportance(c, e)}`).length;
                }));
                return deck.entries.map(entry => {
                const card   = user.cards[entry.cardId];
                if (!card) return null;
                const work     = user.cardWorks[`${profileId}:${entry.cardId}`];
                const k        = cardAvailability(user, work);
                const fsrs     = work ? replayFSRS(work.history) : undefined;
                const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
                const imp      = effectiveImportance(card, entry);
                const lastTs   = work?.history.at(-1)?.ts;
                const isDrop   = dropTarget?.cardId === entry.cardId;

                return (
                  <div
                    key={entry.cardId}
                    draggable
                    ref={(el) => { if (el) addTouchDragSupport(el as HTMLElement); }}
                    class={[
                      'flex items-center gap-3 px-3 py-2 rounded hover:bg-elevated transition-colors group',
                      activeDragId === entry.cardId ? 'opacity-40' : '',
                      isDrop && dropTarget?.zone === 'before' ? 'drop-before' : '',
                      isDrop && dropTarget?.zone === 'after'  ? 'drop-after'  : '',
                    ].join(' ')}
                    onDragStart={(e) => onDragStart(entry.cardId, e as unknown as DragEvent)}
                    onDragEnd={() => onDragEnd()}
                    onDragOver={(e) => onDragOver(entry.cardId, e as unknown as DragEvent)}
                    onDragLeave={(e) => onDragLeave(e as unknown as DragEvent)}
                    onDrop={(e) => onDrop(entry.cardId, e as unknown as DragEvent)}
                  >
                    <span class="text-dim opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity">⠿</span>

                    <span class="flex gap-0.5 items-center shrink-0">
                      <span class={`w-2 h-2 rounded-full ${availabilityColor(k, cardEase === undefined)}`} title={cardEase === undefined ? t('card.neverReviewed') : t('card.dot.recall', { pct: pct(k) })} />
                      <span
                        class={`w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                        title={cardEase !== undefined ? t('card.dot.ease', { pct: pct(cardEase) }) : t('card.neverReviewed')}
                      />
                    </span>

                    <span
                      class="text-sm text-primary flex-1 truncate cursor-pointer hover:text-accent"
                      data-tour="deck-row-name"
                      onClick={() => navigate({ view: 'card', cardId: card.id, contextDeckId: deckId })}
                    >
                      {card.name}
                    </span>

                    <span class="lib-date text-xs font-mono text-dim shrink-0">
                      {lastTs ? timeAgo(lastTs) : t('card.neverReviewed')}
                    </span>

                    {/* The field and the value it replaces, one box for the
                        walkthrough to light (walkthrough/). */}
                    <span class="shrink-0 flex" data-tour="deck-importance">
                    {editingImportanceId === entry.cardId ? (
                      <input
                        ref={importanceInputRef}
                        type="number" min="0" step="0.1"
                        value={importanceDraft}
                        style={{ width: `${impColWidth}ch` }}
                        class="text-xs font-mono text-right p-0 bg-transparent border-b border-accent outline-none text-primary shrink-0 leading-none"
                        onInput={(e) => setImportanceDraft((e.target as HTMLInputElement).value)}
                        onBlur={() => {
                          const val = parseFloat(importanceDraft);
                          mutate(s => {
                            const e = s.decks[deckId]!.entries.find(e => e.cardId === entry.cardId);
                            if (!e) return;
                            if (isNaN(val) || importanceDraft.trim() === '') delete e.importance;
                            else e.importance = val;
                          });
                          setEditingImportanceId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') setEditingImportanceId(null);
                        }}
                      />
                    ) : (
                      <span
                        style={{ width: `${impColWidth}ch` }}
                        class={`text-xs font-mono shrink-0 text-right cursor-pointer hover:text-accent transition-colors ${entry.importance !== undefined ? 'text-accent' : 'text-dim'}`}
                        title={entry.importance !== undefined ? t('deck.importanceTitleDeck') : t('deck.importanceTitleDefault')}
                        onClick={() => { setImportanceDraft(entry.importance !== undefined ? String(entry.importance) : ''); setEditingImportanceId(entry.cardId); }}
                      >
                        ×{imp}
                      </span>
                    )}
                    </span>

                  </div>
                );
              });
              })()}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
