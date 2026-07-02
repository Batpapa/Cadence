import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { appState, navigate, mutate, getContext, replaceRoute, routeSignal } from '../store';
import { pct, availabilityColor, focusIfDesktop, sortByRelevance, timeAgo } from '../utils';
import { TrashIcon, SortAlphaIcon, ClockIcon, CalendarPlusIcon, StarIcon, CheckIcon, ScatterPlotIcon } from '../components/icons';
import { CardMap } from '../components/cardMap';
import { exportCards, exportCardsCSV, cardPackageText } from '../services/importExport';
import { uploadShare } from '../services/shareService';
import { confirmModal, showModal, closeModal } from '../components/modal';
import { showStudyModal } from '../components/studyModal';
import { showNewCardModal } from '../components/theSessionImport';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardAvailability, replayFSRS } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import type { AppState, Card, LibrarySort } from '../types';
import { FilterSection, cycleFilter, type FilterMap } from '../components/filterSection';

// ── Export modal ──────────────────────────────────────────────────────────────

function showExportModal(cards: Card[], user: AppState): void {
  const iconCdc   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
  const iconCsv   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>`;
  const iconFile  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
  const iconShare = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

  // ── Build modal manually for navigation support ───────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col';
  dialog.style.cssText = `max-width:min(28rem, 90vw); max-height:85vh;`;

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-4 border-b border-border shrink-0';
  const headerLeft = document.createElement('div');
  headerLeft.className = 'flex items-center gap-2 min-w-0';
  const backBtn = document.createElement('button');
  backBtn.className = 'text-dim hover:text-primary transition-colors cursor-pointer shrink-0 hidden';
  backBtn.textContent = '←';
  const titleEl = document.createElement('h2');
  titleEl.className = 'text-xs font-semibold text-muted uppercase tracking-widest';
  headerLeft.append(backBtn, titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0';
  closeBtn.textContent = '✕';
  header.append(headerLeft, closeBtn);

  const body = document.createElement('div');
  body.className = 'px-5 py-4 space-y-2 overflow-y-auto flex-1';

  dialog.append(header, body);
  overlay.appendChild(dialog);

  const close = () => overlay.remove();
  closeBtn.onclick = close;
  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', e => { mouseDownOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', e => { if (e.target === overlay && mouseDownOnOverlay) close(); });

  const mkChoice = (icon: string, label: string, desc: string, accentColor: string, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.className = 'flex items-center gap-3.5 w-full px-4 py-3.5 rounded-xl border border-border bg-bg text-left cursor-pointer';
    btn.style.cssText = 'transition: border-color 0.15s, background 0.15s;';
    btn.title = desc;
    const iconWrap = document.createElement('span');
    iconWrap.style.color = accentColor;
    iconWrap.className = 'shrink-0 flex items-center';
    iconWrap.innerHTML = icon;
    const labelEl = document.createElement('span');
    labelEl.className = 'flex-1 text-sm font-medium text-primary';
    labelEl.textContent = label;
    const arrow = document.createElement('span');
    arrow.className = 'text-dim text-base leading-none shrink-0';
    arrow.textContent = '›';
    btn.append(iconWrap, labelEl, arrow);
    btn.addEventListener('mouseenter', () => { btn.style.borderColor = accentColor; btn.style.background = `${accentColor}12`; });
    btn.addEventListener('mouseleave', () => { btn.style.borderColor = ''; btn.style.background = ''; });
    btn.onclick = onClick;
    return btn;
  };

  const renderRoot = () => {
    titleEl.textContent = t('library.exportSelected');
    backBtn.classList.add('hidden');
    body.innerHTML = '';
    body.appendChild(mkChoice(iconCdc, t('library.export.cdc'), t('library.export.cdcDesc'), 'var(--color-warn)', renderCdc));
    body.appendChild(mkChoice(iconCsv, 'CSV', t('library.export.csvDesc'), 'var(--color-success)', () => { close(); exportCardsCSV(cards, user); }));
  };

  const renderCdc = () => {
    titleEl.textContent = t('library.export.cdc');
    backBtn.classList.remove('hidden');
    backBtn.onclick = renderRoot;
    body.innerHTML = '';
    body.appendChild(mkChoice(iconFile,  t('library.export.file'),  t('library.export.cdcDesc'),  'var(--color-warn)',   () => { close(); exportCards(cards); }));
    body.appendChild(mkChoice(iconShare, t('library.share.label'),  t('library.share.desc'),       'var(--color-accent)', () => { void renderShareResult(); }));
  };

  const renderShareResult = async () => {
    backBtn.classList.add('hidden');
    body.innerHTML = '';
    const status = document.createElement('p');
    status.className = 'text-xs text-muted text-center py-2';
    status.textContent = t('library.share.uploading');
    body.appendChild(status);
    try {
      const { key, secondsRemaining } = await uploadShare(cardPackageText(cards));
      body.innerHTML = '';
      const keyEl = document.createElement('div');
      keyEl.className = 'text-center font-mono text-3xl font-bold tracking-[0.3em] text-primary py-2';
      keyEl.textContent = key;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-primary w-full text-sm';
      copyBtn.textContent = t('library.share.copy');
      copyBtn.onclick = () => {
        void navigator.clipboard.writeText(key);
        copyBtn.textContent = t('library.share.copied');
        setTimeout(() => { copyBtn.textContent = t('library.share.copy'); }, 2000);
      };
      const validity = document.createElement('p');
      validity.className = 'text-xs text-muted text-center';
      validity.textContent = t('library.share.validity', { minutes: Math.floor(secondsRemaining / 60) });
      body.append(keyEl, copyBtn, validity);
    } catch (e) {
      status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      backBtn.classList.remove('hidden');
      backBtn.onclick = renderCdc;
    }
  };

  document.body.appendChild(overlay);
  renderRoot();
}

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
  const [tagFilterOr, setTagFilterOr] = useState(savedRoute?.tagOr ?? false);
  const [deckFilterOr, setDeckFilterOr] = useState(savedRoute?.deckOr ?? false);
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
    replaceRoute({ view: 'library', search: searchQuery, tags: [...activeTags], decks: [...activeDecks], sort: sortMode, sortAsc, tagOr: tagFilterOr, deckOr: deckFilterOr });
  }, [searchQuery, activeTags, activeDecks, sortMode, sortAsc, tagFilterOr, deckFilterOr]);

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
    const matchText = !q || c.name.toLowerCase().includes(q);
    const cardDecks = decksContainingCard(c.id, user);

    const tagEntries  = [...activeTags];
    const inclTags    = tagEntries.filter(([, fs]) => fs === 'include').map(([t]) => t);
    const exclTags    = tagEntries.filter(([, fs]) => fs === 'exclude').map(([t]) => t);
    const matchTags   = activeTags.size === 0 || (
      (inclTags.length === 0 || (tagFilterOr ? inclTags.some(t => tags.includes(t)) : inclTags.every(t => tags.includes(t)))) &&
      exclTags.every(t => !tags.includes(t))
    );

    const deckEntries = [...activeDecks];
    const inclDecks   = deckEntries.filter(([, fs]) => fs === 'include').map(([id]) => id);
    const exclDecks   = deckEntries.filter(([, fs]) => fs === 'exclude').map(([id]) => id);
    const hasDeck     = (id: string) => id === NO_DECK ? cardDecks.length === 0 : cardDecks.includes(id);
    const matchDecks  = activeDecks.size === 0 || (
      (inclDecks.length === 0 || (deckFilterOr ? inclDecks.some(hasDeck) : inclDecks.every(hasDeck))) &&
      exclDecks.every(id => !hasDeck(id))
    );
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
    filtered = [...filteredUnsorted].sort((a, b) => b.defaultImportance - a.defaultImportance);
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
  const lastClickRef  = useRef<{ cardId: string; wasSelected: boolean } | null>(null);
  const shiftActiveRef = useRef(false);
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
            highlight={q}
            orMode={deckFilterOr}
            onToggleOr={() => setDeckFilterOr(o => !o)}
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
            highlight={q}
            orMode={tagFilterOr}
            onToggleOr={() => setTagFilterOr(o => !o)}
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
            <button class="btn-ghost text-xs inline-flex items-center justify-center" title={t('library.exportSelected')} onClick={() => showExportModal(allCards.filter(c => selected.has(c.id)), user)}>
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
              class="btn bg-success/80 hover:bg-success text-white text-xs flex items-center"
              title={t('library.study')}
              onClick={() => {
                const pool = [...selected].map(id => ({ cardId: id }));
                showStudyModal({ entries: pool, title: t('library.title'), defaultContext: null });
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5,3 19,12 5,21"/></svg>
            </button>
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
              <TrashIcon size={13} />
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
          <div class="lib-list space-y-1">
            {(() => {
              const impColWidth = Math.max(...filtered.map(c => String(`×${c.defaultImportance}`).length));
              return filtered.map(card => {
              const work     = user.cardWorks[`${user.currentProfileId}:${card.id}`];
              const k        = cardAvailability(user, work);
              const fsrs     = work ? replayFSRS(work.history) : undefined;
              const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
              const isSel    = selected.has(card.id);

              return (
                <div
                  key={card.id}
                  class={`flex items-center gap-3 px-3 py-2.5 rounded transition-colors group cursor-pointer ${isSel ? 'bg-elevated' : 'hover:bg-elevated'}`}
                  onMouseDown={(e) => { if (selected.size > 0 && e.shiftKey) e.preventDefault(); }}
                  onClick={(e) => {
                    if (selected.size === 0) { navigate({ view: 'card', cardId: card.id }); return; }
                    if (e.shiftKey && lastClickRef.current) {
                      const { cardId: lastId, wasSelected } = lastClickRef.current;
                      const lastIdx = filtered.findIndex(c => c.id === lastId);
                      const currIdx = filtered.findIndex(c => c.id === card.id);
                      if (lastIdx !== -1 && currIdx !== -1) {
                        const from = Math.min(lastIdx, currIdx);
                        const to   = Math.max(lastIdx, currIdx);
                        const next = new Set(selected);
                        for (let i = from; i <= to; i++) {
                          wasSelected ? next.add(filtered[i]!.id) : next.delete(filtered[i]!.id);
                        }
                        setSelected(next);
                        return;
                      }
                    }
                    const nowSelected = !selected.has(card.id);
                    const next = new Set(selected);
                    nowSelected ? next.add(card.id) : next.delete(card.id);
                    setSelected(next);
                    lastClickRef.current = { cardId: card.id, wasSelected: nowSelected };
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    class={`card-checkbox shrink-0 transition-opacity ${isSel ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'}`}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      shiftActiveRef.current = e.shiftKey;
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      const next = new Set(selected);
                      if (shiftActiveRef.current && lastClickRef.current) {
                        shiftActiveRef.current = false;
                        const { cardId: lastId, wasSelected } = lastClickRef.current;
                        const lastIdx = filtered.findIndex(c => c.id === lastId);
                        const currIdx = filtered.findIndex(c => c.id === card.id);
                        if (lastIdx !== -1 && currIdx !== -1) {
                          const from = Math.min(lastIdx, currIdx);
                          const to   = Math.max(lastIdx, currIdx);
                          for (let i = from; i <= to; i++) {
                            wasSelected ? next.add(filtered[i]!.id) : next.delete(filtered[i]!.id);
                          }
                          setSelected(next);
                          return;
                        }
                      }
                      shiftActiveRef.current = false;
                      checked ? next.add(card.id) : next.delete(card.id);
                      setSelected(next);
                      lastClickRef.current = { cardId: card.id, wasSelected: checked };
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
                    <span class="lib-date text-xs font-mono text-dim shrink-0">
                      {work?.history.at(-1)?.ts ? timeAgo(work.history.at(-1)!.ts) : t('card.neverReviewed')}
                    </span>
                    <span
                      style={{ width: `${impColWidth}ch` }}
                      class="text-xs font-mono text-dim shrink-0 text-right"
                      title={t('library.baseImportance')}
                    >
                      ×{card.defaultImportance}
                    </span>
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
