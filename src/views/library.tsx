import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate, getContext } from '../store';
import { pct, availabilityColor, trashIcon, focusIfDesktop } from '../utils';
import { exportCards } from '../services/importExport';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { showNewCardModal } from '../components/theSessionImport';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardAvailability, replayFSRS } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';
import type { Card } from '../types';

const NO_DECK = '__no_deck__';

// Bridge: mounts a vanilla SVGSVGElement inside Preact's tree.
function SvgIcon({ icon }: { icon: SVGSVGElement }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { ref.current!.replaceChildren(icon); });
  return <span ref={ref} />;
}

// ── Collapsible filter section ────────────────────────────────────────────────

function FilterSection({ labelKey, items, activeSet, labelOf, titleOf, available, onToggle }: {
  labelKey: string;
  items: string[];
  activeSet: Set<string>;
  labelOf: (id: string) => string;
  titleOf: (id: string) => string;
  available: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        class="flex items-center gap-1.5 text-xs text-dim hover:text-primary transition-colors py-0.5"
        onClick={() => setOpen(o => !o)}
      >
        <span class="text-[10px]">{open ? '▾' : '▶'}</span>
        <span>{t(labelKey)}</span>
      </button>
      {open && (
        <div class="flex flex-wrap gap-1.5 pt-1">
          {items.map(id => {
            const isActive = activeSet.has(id);
            const isAvail  = isActive || available.has(id);
            return (
              <button
                key={id}
                disabled={!isAvail}
                class={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  isActive ? 'bg-accent text-white border-accent cursor-pointer' :
                  isAvail  ? 'border-border text-muted hover:border-accent hover:text-accent cursor-pointer' :
                             'border-border text-muted opacity-30 cursor-not-allowed'
                }`}
                title={titleOf(id)}
                onClick={() => onToggle(id)}
              >
                {labelOf(id)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Deck picker modal (vanilla) ───────────────────────────────────────────────

function showDeckPickerModal(
  titleKey: string,
  confirmKey: string,
  eligibleDecks: { id: string; info: string }[],
  onConfirm: (deckIds: string[]) => void,
): void {
  const state  = appState.value;
  const body   = document.createElement('div'); body.className = 'space-y-1';
  const checks = new Map<string, HTMLInputElement>();
  for (const { id, info } of eligibleDecks) {
    const deck = state.decks[id]; if (!deck) continue;
    const row    = document.createElement('label'); row.className = 'flex items-center gap-2 px-2 py-1.5 rounded hover:bg-elevated cursor-pointer';
    const chk    = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'card-checkbox'; chk.checked = true;
    const nameEl = document.createElement('span'); nameEl.className = 'text-sm text-primary flex-1 truncate'; nameEl.textContent = deck.name;
    const infoEl = document.createElement('span'); infoEl.className = 'text-xs text-dim shrink-0'; infoEl.textContent = info;
    checks.set(id, chk);
    row.append(chk, nameEl, infoEl);
    body.appendChild(row);
  }
  showModal(t(titleKey), body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: t(confirmKey), primary: true, onClick: () => {
      const chosen = [...checks.entries()].filter(([, chk]) => chk.checked).map(([id]) => id);
      if (chosen.length > 0) onConfirm(chosen);
      closeModal();
    }},
  ]);
}

// ── Main component ────────────────────────────────────────────────────────────

export function LibraryView() {
  const state    = appState.value;
  const user     = getCurrentUser(state);
  const allCards = Object.values(state.cards) as Card[];

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTags,  setActiveTags]  = useState<Set<string>>(new Set());
  const [activeDecks, setActiveDecks] = useState<Set<string>>(new Set());
  const [selected,    setSelected]    = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (searchRef.current) focusIfDesktop(searchRef.current); }, []);

  // ── Filter metadata ───────────────────────────────────────────────────────────
  const allTags    = [...new Set(allCards.flatMap(c => c.tags ?? []))].sort();
  const hasOrphans = allCards.some(c => decksContainingCard(c.id, state).length === 0);
  const deckItems  = [
    ...(hasOrphans ? [NO_DECK] : []),
    ...Object.values(state.decks)
      .filter(d => d.entries.some(e => state.cards[e.cardId]))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => d.id),
  ];

  // ── Filtered list (recomputed every render) ───────────────────────────────────
  const q        = searchQuery.toLowerCase();
  const filtered = allCards
    .filter(c => {
      const tags       = c.tags ?? [];
      const matchText  = !q || c.name.toLowerCase().includes(q) || tags.some(tg => tg.toLowerCase().includes(q));
      const matchTags  = activeTags.size === 0 || [...activeTags].every(at => tags.includes(at));
      const cardDecks  = decksContainingCard(c.id, state);
      const matchDecks = activeDecks.size === 0 || [...activeDecks].every(id =>
        id === NO_DECK ? cardDecks.length === 0 : cardDecks.includes(id)
      );
      return matchText && matchTags && matchDecks;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Available chips (derived from filtered) ───────────────────────────────────
  const availTags  = new Set(filtered.flatMap(c => c.tags ?? []));
  const availDecks = new Set<string>(filtered.flatMap(c => decksContainingCard(c.id, state)));
  if (filtered.some(c => decksContainingCard(c.id, state).length === 0)) availDecks.add(NO_DECK);

  // ── Toggle handlers ───────────────────────────────────────────────────────────
  const toggleTag  = (tag: string) =>
    setActiveTags(prev  => { const n = new Set(prev);  n.has(tag) ? n.delete(tag) : n.add(tag); return n; });
  const toggleDeck = (id: string)  =>
    setActiveDecks(prev => { const n = new Set(prev);  n.has(id)  ? n.delete(id)  : n.add(id);  return n; });

  // ── Selection toolbar data ────────────────────────────────────────────────────
  const selectedArr   = [...selected];
  const hasSelection  = selected.size > 0;

  const addEligible = Object.values(state.decks)
    .filter(d => selectedArr.some(cId => !d.entries.some(e => e.cardId === cId)))
    .map(d => ({
      id: d.id,
      info: t('library.deckInfo.add', {
        n: selectedArr.length - selectedArr.filter(cId => d.entries.some(e => e.cardId === cId)).length,
      }),
    }))
    .sort((a, b) => (state.decks[a.id]?.name ?? '').localeCompare(state.decks[b.id]?.name ?? ''));

  const removeEligible = Object.values(state.decks)
    .filter(d => selectedArr.some(cId => d.entries.some(e => e.cardId === cId)))
    .map(d => ({
      id: d.id,
      info: t('library.deckInfo.remove', {
        n: selectedArr.filter(cId => d.entries.some(e => e.cardId === cId)).length,
      }),
    }))
    .sort((a, b) => (state.decks[a.id]?.name ?? '').localeCompare(state.decks[b.id]?.name ?? ''));

  return (
    <div class="flex flex-col h-full view-enter">

      {/* ── Header ── */}
      <div class="flex items-center justify-between px-6 pt-6 pb-4 shrink-0">
        <div>
          <h1 class="text-xl font-semibold text-primary">{t('library.title')}</h1>
          <p class="text-xs text-muted mt-0.5">
            {t(allCards.length !== 1 ? 'library.cardCountPlural' : 'library.cardCount', { count: allCards.length })}
          </p>
        </div>
        <button class="btn-primary" onClick={() => showNewCardModal(getContext())}>
          {t('library.newCard')}
        </button>
      </div>

      {/* ── Search + filters ── */}
      <div class="px-6 pb-2 shrink-0 space-y-1">
        <input
          ref={searchRef}
          type="text"
          placeholder={t('library.search')}
          class="input"
          value={searchQuery}
          onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
        />
        {deckItems.length > 0 && (
          <FilterSection
            labelKey="library.filterDecks"
            items={deckItems}
            activeSet={activeDecks}
            labelOf={id => id === NO_DECK ? t('library.filterNoDecks') : (state.decks[id]?.name ?? id)}
            titleOf={id => id === NO_DECK ? '' : deckPath(id, state)}
            available={availDecks}
            onToggle={toggleDeck}
          />
        )}
        {allTags.length > 0 && (
          <FilterSection
            labelKey="library.filterTags"
            items={allTags}
            activeSet={activeTags}
            labelOf={tag => tag}
            titleOf={tag => tag}
            available={availTags}
            onToggle={toggleTag}
          />
        )}
      </div>

      {/* ── Selection toolbar ── */}
      <div class="flex items-center justify-between px-6 py-1.5 shrink-0">
        <span class="text-xs text-dim">
          {hasSelection ? t('library.selected', { count: selected.size }) : ''}
        </span>
        <div class="flex gap-1 items-center flex-wrap">
          <button class="btn-ghost text-xs" onClick={() => setSelected(new Set(filtered.map(c => c.id)))}>
            {t('library.selectAll')}
          </button>
          {hasSelection && <>
            <button class="btn-ghost text-xs" onClick={() => setSelected(new Set())}>
              {t('library.deselectAll')}
            </button>
            <button class="btn-ghost text-xs" onClick={() => exportCards(allCards.filter(c => selected.has(c.id)))}>
              {t('library.exportSelected')}
            </button>
            {addEligible.length > 0 && (
              <button class="btn-ghost text-xs" onClick={() => showDeckPickerModal(
                'library.addToDecks.title', 'library.addToDecks.confirm', addEligible,
                (deckIds) => mutate(s => {
                  for (const deckId of deckIds) {
                    const deck = s.decks[deckId]; if (!deck) continue;
                    for (const cardId of selectedArr)
                      if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
                  }
                }),
              )}>
                {t('library.addToDecks')}
              </button>
            )}
            {removeEligible.length > 0 && (
              <button class="btn-ghost text-xs" onClick={() => showDeckPickerModal(
                'library.removeFromDecks.title', 'library.removeFromDecks.confirm', removeEligible,
                (deckIds) => mutate(s => {
                  for (const deckId of deckIds) {
                    const deck = s.decks[deckId]; if (!deck) continue;
                    deck.entries = deck.entries.filter(e => !selectedArr.includes(e.cardId));
                  }
                }),
              )}>
                {t('library.removeFromDecks')}
              </button>
            )}
            <button
              class="btn-danger text-xs flex items-center gap-1.5"
              title={t('library.deleteSelected')}
              onClick={() => confirmModal(
                t('library.delete.title'),
                t(selected.size !== 1 ? 'library.delete.messagePlural' : 'library.delete.message', { count: selected.size }),
                t('common.delete'),
                () => {
                  setSelected(new Set());
                  mutate(s => {
                    for (const cardId of selectedArr) {
                      delete s.cards[cardId];
                      for (const deck of Object.values(s.decks)) deck.entries = deck.entries.filter(e => e.cardId !== cardId);
                      delete s.cardWorks[`${s.currentProfileId}:${cardId}`];
                    }
                  });
                },
              )}
            >
              <SvgIcon icon={trashIcon(12)} />
              <span>{selected.size}</span>
            </button>
          </>}
        </div>
      </div>

      {/* ── Card list ── */}
      <div class="flex-1 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <p class="text-sm text-dim italic">
            {(q || activeTags.size > 0 || activeDecks.size > 0) ? t('library.noMatch') : t('library.empty')}
          </p>
        ) : (
          <div class="space-y-1">
            {filtered.map(card => {
              const work     = state.cardWorks[`${state.currentProfileId}:${card.id}`];
              const k        = cardAvailability(user, work);
              const fsrs     = work ? replayFSRS(work.history) : undefined;
              const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
              const deckIds  = decksContainingCard(card.id, state);
              const isSel    = selected.has(card.id);

              return (
                <div
                  key={card.id}
                  class={`flex items-center gap-3 px-3 py-2.5 rounded transition-colors group cursor-pointer ${isSel ? 'bg-elevated' : 'hover:bg-elevated'}`}
                  onClick={() => navigate({ view: 'card', cardId: card.id })}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    class={`card-checkbox shrink-0 transition-opacity ${isSel ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const next = new Set(selected);
                      (e.target as HTMLInputElement).checked ? next.add(card.id) : next.delete(card.id);
                      setSelected(next);
                    }}
                  />

                  <span class="flex gap-0.5 items-center shrink-0">
                    <span class={`w-2 h-2 rounded-full ${availabilityColor(k)}`} title={`R: ${pct(k)}`} />
                    <span
                      class={`w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                      title={cardEase !== undefined ? `Ease: ${pct(cardEase)}` : 'Never reviewed'}
                    />
                  </span>

                  <span class="text-sm text-primary flex-1 truncate hover:text-accent transition-colors">
                    {card.name}
                  </span>

                  <div class="flex items-center gap-3 shrink-0">
                    {(card.tags ?? []).length > 0 && (
                      <div class="flex gap-1">
                        {(card.tags ?? []).slice(0, 3).map(tg => (
                          <span key={tg} class="text-xs px-1.5 py-0.5 rounded bg-border text-dim">{tg}</span>
                        ))}
                      </div>
                    )}
                    <span class="text-xs font-mono text-dim" title={t('library.baseImportance')}>
                      ×{card.importance}
                    </span>
                    <div class="hidden group-hover:flex gap-1">
                      {deckIds.slice(0, 2).map(dId => {
                        const deck = state.decks[dId]; if (!deck) return null;
                        return (
                          <span
                            key={dId}
                            class="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent cursor-pointer hover:bg-accent/20 transition-colors"
                            title={deckPath(dId, state)}
                            onClick={(e) => { e.stopPropagation(); navigate({ view: 'deck', deckId: dId }); }}
                          >
                            {deck.name}
                          </span>
                        );
                      })}
                      {deckIds.length > 2 && (
                        <span class="text-xs text-dim">+{deckIds.length - 2}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
