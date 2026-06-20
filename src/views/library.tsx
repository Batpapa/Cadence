import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { appState, navigate, mutate, getContext, replaceRoute, routeSignal } from '../store';
import { pct, availabilityColor, focusIfDesktop, sortByRelevance, timeAgo } from '../utils';
import { TrashIcon, SortAlphaIcon, ClockIcon, CalendarPlusIcon, StarIcon, CheckIcon, ScatterPlotIcon } from '../components/icons';
import { CardMap } from '../components/cardMap';
import { exportCards } from '../services/importExport';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { showNewCardModal } from '../components/theSessionImport';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardAvailability, replayFSRS } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import type { Card, LibrarySort } from '../types';
import { FilterSection, cycleFilter, type FilterMap } from '../components/filterSection';

const NO_DECK = '__no_deck__';
const SORT_MODES: LibrarySort[] = ['alpha', 'lastReviewed', 'lastAdded', 'importance'];
const SORT_ICON: Record<LibrarySort, ComponentType<{ size?: number }>> = {
  alpha: SortAlphaIcon,
  lastReviewed: ClockIcon,
  lastAdded: CalendarPlusIcon,
  importance: StarIcon,
};

// ── Deck picker modal (vanilla) ───────────────────────────────────────────────

function showDeckPickerModal(
  titleKey: string,
  confirmKey: string,
  eligibleDecks: { id: string; info: string }[],
  onConfirm: (deckIds: string[]) => void,
): void {
  const user   = appState.value;
  const body   = document.createElement('div'); body.className = 'space-y-1';
  const checks = new Map<string, HTMLInputElement>();
  for (const { id, info } of eligibleDecks) {
    const deck = user.decks[id]; if (!deck) continue;
    const row    = document.createElement('label'); row.className = 'flex items-center gap-2 px-2 py-1.5 rounded hover:bg-elevated cursor-pointer';
    const chk    = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'card-checkbox'; chk.checked = false;
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
  const user     = appState.value;
  const allCards = Object.values(user.cards) as Card[];

  const savedRoute = routeSignal.value.view === 'library' ? routeSignal.value : null;
  const [searchQuery, setSearchQuery] = useState(savedRoute?.search ?? '');
  const [activeTags,  setActiveTags]  = useState<FilterMap>(() => new Map(savedRoute?.tags ?? []));
  const [activeDecks, setActiveDecks] = useState<FilterMap>(() => new Map(savedRoute?.decks ?? []));
  const [sortMode,    setSortMode]    = useState<LibrarySort>(savedRoute?.sort ?? 'alpha');
  const [sortAsc,     setSortAsc]     = useState(savedRoute?.sortAsc ?? false);
  const [sortOpen,    setSortOpen]    = useState(false);
  const [mapOpen,     setMapOpen]     = useState(false);
  const [selected,    setSelected]    = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const sortRef   = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sortOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (!sortRef.current?.contains(e.target as Node)) setSortOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [sortOpen]);

  useEffect(() => {
    replaceRoute({ view: 'library', search: searchQuery, tags: [...activeTags], decks: [...activeDecks], sort: sortMode, sortAsc });
  }, [searchQuery, activeTags, activeDecks, sortMode, sortAsc]);

  useEffect(() => { if (searchRef.current) focusIfDesktop(searchRef.current); }, []);

  // ── Filter metadata ───────────────────────────────────────────────────────────
  const allTags    = [...new Set(allCards.flatMap(c => c.tags ?? []))].sort();
  const hasOrphans = allCards.some(c => decksContainingCard(c.id, user).length === 0);
  const deckItems  = [
    ...(hasOrphans ? [NO_DECK] : []),
    ...Object.values(user.decks)
      .filter(d => d.entries.some(e => user.cards[e.cardId]))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => d.id),
  ];

  // ── Filtered list (recomputed every render) ───────────────────────────────────
  const q = searchQuery.toLowerCase();
  const filteredUnsorted = allCards.filter(c => {
    const tags       = c.tags ?? [];
    const matchText  = !q || c.name.toLowerCase().includes(q);
    const matchTags  = activeTags.size  === 0 || [...activeTags].every(([tag, fs]) =>
      fs === 'include' ? tags.includes(tag) : !tags.includes(tag)
    );
    const cardDecks  = decksContainingCard(c.id, user);
    const matchDecks = activeDecks.size === 0 || [...activeDecks].every(([id, fs]) => {
      const has = id === NO_DECK ? cardDecks.length === 0 : cardDecks.includes(id);
      return fs === 'include' ? has : !has;
    });
    return matchText && matchTags && matchDecks;
  });
  let filtered: Card[];
  if (sortMode === 'lastAdded') {
    // user.cards preserves insertion order (oldest → newest); filter() keeps relative order, so reverse for newest-first.
    filtered = [...filteredUnsorted].reverse();
  } else if (sortMode === 'lastReviewed') {
    const lastTs = (c: Card) => user.cardWorks[`${user.currentProfileId}:${c.id}`]?.history.at(-1)?.ts ?? -1;
    filtered = [...filteredUnsorted].sort((a, b) => lastTs(b) - lastTs(a));
  } else if (sortMode === 'importance') {
    filtered = [...filteredUnsorted].sort((a, b) => b.importance - a.importance);
  } else {
    filtered = q
      ? sortByRelevance(filteredUnsorted, searchQuery)
      : [...filteredUnsorted].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sortAsc) filtered = filtered.slice().reverse();

  // ── Available chips (derived from filtered) ───────────────────────────────────
  const availTags  = new Set(filtered.flatMap(c => c.tags ?? []));
  const availDecks = new Set<string>(filtered.flatMap(c => decksContainingCard(c.id, user)));
  if (filtered.some(c => decksContainingCard(c.id, user).length === 0)) availDecks.add(NO_DECK);

  // ── Toggle handlers ───────────────────────────────────────────────────────────
  const toggleTag  = (tag: string) => setActiveTags(prev  => cycleFilter(prev, tag));
  const toggleDeck = (id: string)  => setActiveDecks(prev => cycleFilter(prev, id));

  // ── Selection toolbar data ────────────────────────────────────────────────────
  const selectedArr   = [...selected];
  const hasSelection  = selected.size > 0;
  const masterRef     = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = selected.size > 0 && selected.size < filtered.length;
  });

  useEffect(() => {
    if (selected.size === 0) return;
    const visible = new Set(filtered.map(c => c.id));
    const next = new Set([...selected].filter(id => visible.has(id)));
    if (next.size !== selected.size) setSelected(next);
  }, [q, activeTags, activeDecks]);

  const addEligible = Object.values(user.decks)
    .filter(d => selectedArr.some(cId => !d.entries.some(e => e.cardId === cId)))
    .map(d => ({
      id: d.id,
      info: t('library.deckInfo.add', {
        n: selectedArr.length - selectedArr.filter(cId => d.entries.some(e => e.cardId === cId)).length,
      }),
    }))
    .sort((a, b) => (user.decks[a.id]?.name ?? '').localeCompare(user.decks[b.id]?.name ?? ''));

  const removeEligible = Object.values(user.decks)
    .filter(d => selectedArr.some(cId => d.entries.some(e => e.cardId === cId)))
    .map(d => ({
      id: d.id,
      info: t('library.deckInfo.remove', {
        n: selectedArr.filter(cId => d.entries.some(e => e.cardId === cId)).length,
      }),
    }))
    .sort((a, b) => (user.decks[a.id]?.name ?? '').localeCompare(user.decks[b.id]?.name ?? ''));

  return (
    <div class="overflow-y-auto h-full view-enter">

      {/* ── Header ── */}
      <div class="flex items-center justify-between px-6 pt-6 pb-4">
        <div>
          <h1 class="text-xl font-semibold text-primary">{t('library.title')}</h1>
          <p class="text-xs text-muted mt-0.5">
            {t(allCards.length !== 1 ? 'library.cardCountPlural' : 'library.cardCount', { count: allCards.length })}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class={`w-8 h-8 shrink-0 flex items-center justify-center rounded-md border transition-colors cursor-pointer ${
              mapOpen ? 'bg-accent text-white border-accent' : 'border-border text-muted hover:border-accent hover:text-accent'
            }`}
            title={t('dashboard.cardMap')}
            onClick={() => setMapOpen(o => !o)}
          >
            <ScatterPlotIcon size={16} />
          </button>
          <button class="btn-primary" onClick={() => showNewCardModal(getContext())}>
            {t('library.newCard')}
          </button>
        </div>
      </div>

      {/* ── Card map ── */}
      {mapOpen && (
        <div class="px-6 pb-4">
          <CardMap user={user} cards={hasSelection ? allCards.filter(c => selected.has(c.id)) : filtered} />
        </div>
      )}

      {/* ── Search + filters ── */}
      <div class="px-6 pb-2 space-y-1">
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
            activeMap={activeDecks}
            labelOf={id => id === NO_DECK ? t('library.filterNoDecks') : (user.decks[id]?.name ?? id)}
            titleOf={id => id === NO_DECK ? '' : deckPath(id, user)}
            available={availDecks}
            onToggle={toggleDeck}
          />
        )}
        {allTags.length > 0 && (
          <FilterSection
            labelKey="library.filterTags"
            items={allTags}
            activeMap={activeTags}
            labelOf={tag => tag}
            titleOf={tag => tag}
            available={availTags}
            onToggle={toggleTag}
          />
        )}
      </div>

      {/* ── Selection toolbar ── */}
      <div class="flex items-center justify-between px-6 h-9">
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            class="card-checkbox"
            checked={filtered.length > 0 && selected.size === filtered.length}
            ref={masterRef}
            onChange={() => {
              if (selected.size === filtered.length && filtered.length > 0) setSelected(new Set());
              else setSelected(new Set(filtered.map(c => c.id)));
            }}
          />
          <span class="text-xs text-dim">
            {hasSelection
              ? t('library.masterSelected', { count: selected.size, total: filtered.length })
              : t('library.masterSelectAll', { count: filtered.length })}
          </span>
        </label>
        <div class="flex gap-1 items-center">
          <div ref={sortRef} class="relative">
            <button
              type="button"
              class="btn-ghost text-xs inline-flex items-center justify-center"
              title={t(`library.sort.${sortMode}`)}
              onClick={() => setSortOpen(o => !o)}
            >
              {(() => { const Icon = SORT_ICON[sortMode]; return <Icon size={13} />; })()}
            </button>
            {sortOpen && (
              <div class="absolute top-full right-0 mt-1 z-30 bg-elevated border border-border rounded-lg overflow-hidden shadow-2xl py-1 min-w-[170px]">
                {SORT_MODES.map(m => {
                  const Icon   = SORT_ICON[m];
                  const active = m === sortMode;
                  return (
                    <button
                      key={m}
                      class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-none bg-transparent text-left transition-colors ${active ? 'text-accent' : 'text-muted hover:bg-surface'}`}
                      onClick={() => { setSortMode(m); setSortOpen(false); }}
                    >
                      <span class="shrink-0 flex items-center"><Icon size={12} /></span>
                      <span class="flex-1">{t(`library.sort.${m}`)}</span>
                      {active && <span class="text-accent flex items-center"><CheckIcon size={11} /></span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            class="btn-ghost text-xs inline-flex items-center justify-center"
            title={sortAsc ? t('library.sort.ascending') : t('library.sort.descending')}
            onClick={() => setSortAsc(a => !a)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={`transition-transform ${sortAsc ? 'rotate-180' : ''}`}>
              <line x1="12" y1="5" x2="12" y2="19"/>
              <polyline points="19 12 12 19 5 12"/>
            </svg>
          </button>
          {hasSelection && <>
            <div class="w-px h-4 bg-border mx-1" />
            <button class="btn-ghost text-xs inline-flex items-center justify-center" title={t('library.exportSelected')} onClick={() => exportCards(allCards.filter(c => selected.has(c.id)))}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </button>
            {addEligible.length > 0 && (
              <button class="btn-ghost text-xs flex items-center gap-1" title={t('library.addToDecks')} onClick={() => showDeckPickerModal(
                'library.addToDecks.title', 'library.addToDecks.confirm', addEligible,
                (deckIds) => mutate(s => {
                  for (const deckId of deckIds) {
                    const deck = s.decks[deckId]; if (!deck) continue;
                    for (const cardId of selectedArr)
                      if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
                  }
                }),
              )}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </button>
            )}
            {removeEligible.length > 0 && (
              <button class="btn-ghost text-xs flex items-center gap-1" title={t('library.removeFromDecks')} onClick={() => showDeckPickerModal(
                'library.removeFromDecks.title', 'library.removeFromDecks.confirm', removeEligible,
                (deckIds) => mutate(s => {
                  for (const deckId of deckIds) {
                    const deck = s.decks[deckId]; if (!deck) continue;
                    deck.entries = deck.entries.filter(e => !selectedArr.includes(e.cardId));
                  }
                }),
              )}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
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
              <TrashIcon size={12} />
            </button>
          </>}
        </div>
      </div>

      {/* ── Card list ── */}
      <div class="px-6 pb-6">
        {filtered.length === 0 ? (
          <p class="text-sm text-dim italic">
            {(q || activeTags.size > 0 || activeDecks.size > 0) ? t('library.noMatch') : t('library.empty')}
          </p>
        ) : (
          <div class="space-y-1">
            {(() => {
              const impColWidth = Math.max(...filtered.map(c => String(`×${c.importance}`).length));
              return filtered.map(card => {
              const work     = user.cardWorks[`${user.currentProfileId}:${card.id}`];
              const k        = cardAvailability(user, work);
              const fsrs     = work ? replayFSRS(work.history) : undefined;
              const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
              const deckIds  = decksContainingCard(card.id, user);
              const isSel    = selected.has(card.id);

              return (
                <div
                  key={card.id}
                  class={`flex items-center gap-3 px-3 py-2.5 rounded transition-colors group cursor-pointer ${isSel ? 'bg-elevated' : 'hover:bg-elevated'}`}
                  onClick={() => { if (selected.size === 0) navigate({ view: 'card', cardId: card.id }); }}
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
                    <span class={`w-2 h-2 rounded-full ${availabilityColor(k)}`} title={t('card.dot.recall', { pct: pct(k) })} />
                    <span
                      class={`w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                      title={cardEase !== undefined ? t('card.dot.ease', { pct: pct(cardEase) }) : t('card.neverReviewed')}
                    />
                  </span>

                  <span class={`text-sm text-primary flex-1 truncate ${selected.size === 0 ? 'hover:text-accent transition-colors' : ''}`}>
                    {card.name}
                  </span>

                  <div class="flex items-center gap-3 shrink-0">
                    <span class="text-xs font-mono text-dim shrink-0">
                      {work?.history.at(-1)?.ts ? timeAgo(work.history.at(-1)!.ts) : t('card.neverReviewed')}
                    </span>
                    <span
                      style={{ width: `${impColWidth}ch` }}
                      class="text-xs font-mono text-dim shrink-0 text-right"
                      title={t('library.baseImportance')}
                    >
                      ×{card.importance}
                    </span>
                    <div class="hidden group-hover:flex gap-1">
                      {deckIds.slice(0, 2).map(dId => {
                        const deck = user.decks[dId]; if (!deck) return null;
                        return (
                          <span
                            key={dId}
                            class="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent cursor-pointer hover:bg-accent/20 transition-colors"
                            title={deckPath(dId, user)}
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
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
