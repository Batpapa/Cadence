import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { appState, navigate, mutate, getContext, replaceRoute, routeSignal } from '../store';
import { pct, availabilityColor, focusIfDesktop, sortByRelevance, timeAgo } from '../utils';
import { TrashIcon, SortAlphaIcon, ClockIcon, CalendarPlusIcon, StarIcon, CheckIcon, ScatterPlotIcon, GaugeIcon, FlameIcon } from '../components/icons';
import { CardMap } from '../components/cardMap';
import { exportCards, exportCardsCSV, cardPackageText } from '../services/importExport';
import { uploadShare } from '../services/shareService';
import { confirmModal, closeAllModals } from '../components/modal';
import { showDuplicateCardsModal } from '../components/duplicateCardModal';
import { removeCards } from '../services/cardService';
import { showDeckPickerModal, showAddTagModal, showRemoveTagModal, showImportanceModal, showRefreshModal } from '../components/batchEdit';
import { fetchTuneById, applyTheSessionName, applyTheSessionAbc, applyTheSessionImportance, applyTheSessionMigration, fetchSet, buildSetCards, parseSetExternalId, findByExternalId } from '../services/theSessionService';
import { ensureItiMapping } from '../services/itiMappingService';
import { defaultTuneRepeat } from '../services/abcService';
import type { ItiMappingDb, ItiMappingEntry } from '../services/itiMappingDb';
import { useContextMenu } from '../components/contextMenu';
import { showStudyModal } from '../components/studyModal';
import { showNewCardModal } from '../components/theSessionImport';
import { decksContainingCard, deckPath } from '../services/deckService';
import { cardAvailability, replayFSRS } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import type { AppState, Card, LibrarySort } from '../types';
import { FilterSection, cycleFilter, type FilterMap } from '../components/filterSection';
import { createLongPressHandlers } from '../components/longPress';

/** The numeric source id inside an `externalId`. Throws rather than returning
 *  NaN: the bulk runner turns a throw into "this card was skipped", named in
 *  the report — which is exactly what an unreadable id deserves. */
function sourceIdOf(card: Card, prefix: string): number {
  const id = parseInt((card.externalId ?? '').slice(prefix.length), 10);
  if (isNaN(id)) throw new Error(`unreadable ${prefix} id: ${card.externalId ?? ''}`);
  return id;
}


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
const SORT_MODES: LibrarySort[] = ['alpha', 'lastReviewed', 'lastAdded', 'importance', 'recall', 'difficulty'];
const SORT_ICON: Record<LibrarySort, ComponentType<{ size?: number }>> = {
  alpha: SortAlphaIcon,
  lastReviewed: ClockIcon,
  lastAdded: CalendarPlusIcon,
  importance: StarIcon,
  recall: GaugeIcon,
  difficulty: FlameIcon,
};

/** The sort the user last *chose*, per user and per device. Local only, never
 *  synced: it is a habit of this device's UI, not user data.
 *
 *  Written ONLY from the sort controls' click handlers — deliberately not from
 *  an effect on `sortMode`. An effect would also fire when the view mounts on a
 *  route that carries its own sort (the back button, or the route restored at
 *  boot), which would silently overwrite the remembered default with wherever
 *  the user happened to navigate back to. */
const SORT_PREF_KEY = 'cadence_library_sort';

type SortPref = { sort: LibrarySort; asc: boolean };

function loadSortPref(userId: string): SortPref | null {
  try {
    const raw = localStorage.getItem(`${SORT_PREF_KEY}:${userId}`);
    if (!raw) return null;
    const pref = JSON.parse(raw) as SortPref;
    // A stored mode may have been renamed or dropped since it was written.
    return SORT_MODES.includes(pref?.sort) ? { sort: pref.sort, asc: !!pref.asc } : null;
  } catch {
    return null;
  }
}

function saveSortPref(userId: string, sort: LibrarySort, asc: boolean): void {
  try {
    localStorage.setItem(`${SORT_PREF_KEY}:${userId}`, JSON.stringify({ sort, asc }));
  } catch {
    // Private mode, quota exhausted — losing a UI preference must never break sorting.
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export function LibraryView() {
  const user     = appState.value;
  const allCards = Object.values(user.cards) as Card[];

  const savedRoute = routeSignal.value.view === 'library' ? routeSignal.value : null;
  const [searchQuery, setSearchQuery] = useState(savedRoute?.search ?? '');
  const [activeTags,  setActiveTags]  = useState<FilterMap>(() => new Map(savedRoute?.tags ?? []));
  const [activeDecks, setActiveDecks] = useState<FilterMap>(() => new Map(savedRoute?.decks ?? []));
  // `sort` and `sortAsc` are written to the route as a pair, so a route carries
  // both or neither. A history entry (back/forward, or the route restored at
  // boot) therefore replays exactly what was on screen; a fresh navigation here
  // — the header button, or a deck's "show these cards" — carries neither, and
  // falls back to what the user last chose. Lazy initialisers: this reads
  // localStorage at mount, not on every keystroke in the search box.
  const [sortMode,    setSortMode]    = useState<LibrarySort>(() => savedRoute?.sort ?? loadSortPref(user.id)?.sort ?? 'alpha');
  const [sortAsc,     setSortAsc]     = useState(() => savedRoute?.sortAsc ?? loadSortPref(user.id)?.asc ?? false);
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
    // externalId match is EXACT (whole "source:id", or just the id part),
    // not a substring — "729" must not also pull in "thesession:7290".
    const extId      = c.externalId?.toLowerCase();
    const extIdOnly  = extId?.slice(extId.indexOf(':') + 1);
    const matchExternalId = q !== '' && (extId === q || extIdOnly === q);
    const matchText = !q || c.name.toLowerCase().includes(q) || matchExternalId;
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
  // Ties resolve alphabetically. The tie-break lives inside the comparator, so
  // the global sortAsc reverse below flips it together with the primary key.
  const byName = (a: Card, b: Card) => a.name.localeCompare(b.name);
  const numCmp = (x: number, y: number) => x === y ? 0 : x - y; // −∞ vs −∞ would give NaN
  if (sortMode === 'lastAdded') {
    // user.cards preserves insertion order (oldest → newest); filter() keeps relative order, so reverse for newest-first.
    filtered = [...filteredUnsorted].reverse();
  } else if (sortMode === 'lastReviewed') {
    const lastTs = (c: Card) => user.cardWorks[`${user.currentProfileId}:${c.id}`]?.history.at(-1)?.ts ?? -1;
    filtered = [...filteredUnsorted].sort((a, b) => numCmp(lastTs(b), lastTs(a)) || byName(a, b));
  } else if (sortMode === 'importance') {
    filtered = [...filteredUnsorted].sort((a, b) => numCmp(b.defaultImportance, a.defaultImportance) || byName(a, b));
  } else if (sortMode === 'recall') {
    // Weakest first: never-reviewed cards count as recall 0 and lead the list.
    // Precomputed: cardAvailability replays the whole FSRS history per card.
    const kOf = new Map(filteredUnsorted.map(c =>
      [c.id, cardAvailability(user, user.cardWorks[`${user.currentProfileId}:${c.id}`])]));
    filtered = [...filteredUnsorted].sort((a, b) => numCmp(kOf.get(a.id)!, kOf.get(b.id)!) || byName(a, b));
  } else if (sortMode === 'difficulty') {
    // FSRS difficulty D (1–10) ascending; never-reviewed = −∞, so they lead.
    const dOf = new Map(filteredUnsorted.map(c => {
      const work = user.cardWorks[`${user.currentProfileId}:${c.id}`];
      const fsrs = work ? replayFSRS(work.history) : undefined;
      return [c.id, fsrs?.difficulty ?? Number.NEGATIVE_INFINITY];
    }));
    filtered = [...filteredUnsorted].sort((a, b) => numCmp(dOf.get(a.id)!, dOf.get(b.id)!) || byName(a, b));
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
  // Shared long-press state (one row touched at a time) — created once here,
  // not per-row, since createLongPressHandlers is a plain function (not a
  // hook) precisely so it can be called per-row inside the .map() below
  // without breaking the Rules of Hooks.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressFiredRef = useRef(false);
  useLayoutEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = selected.size > 0 && selected.size < filtered.length;
  });

  useEffect(() => {
    if (selected.size === 0) return;
    const visible = new Set(filtered.map(c => c.id));
    const next = new Set([...selected].filter(id => visible.has(id)));
    if (next.size !== selected.size) setSelected(next);
  }, [q, activeTags, activeDecks]);

  // A selected card can vanish without the selection being told: the toolbar's
  // delete clears it by hand, but the duplicate cleanup at the end of a
  // migration deletes cards from inside a modal, and so could anything else.
  // A selection holding ghosts counts them in the toolbar and hands dead ids
  // to every bulk action, so it is pruned wherever the deletion came from.
  // Deliberately narrower than the filter pass above — only cards that no
  // longer EXIST are dropped, never ones a rename has merely hidden.
  useEffect(() => {
    if (selected.size === 0) return;
    const next = new Set([...selected].filter(id => user.cards[id]));
    if (next.size !== selected.size) setSelected(next);
  }, [user.cards]);

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

  // Every bulk edit lives behind one ⋯ menu: the toolbar keeps only what you
  // reach for constantly (export, study, delete), so it stays readable on a
  // portrait phone. Declared after the eligibility lists above so the deck
  // entries can be dropped when no selected card can join or leave a deck —
  // same condition that used to hide their toolbar buttons. Reuses the
  // right-click menu's hook (anchoring, dismissal, zoom) on a left click.
  // Three disjoint families, each with its own upstream and its own verb.
  // `thesession:` and `thesession-set:` never overlap — the dash form is
  // deliberately not a prefix of the colon form (see setExternalId).
  const theSessionIds = selectedArr.filter(id => user.cards[id]?.externalId?.startsWith('thesession:'));
  const setIds        = selectedArr.filter(id => user.cards[id]?.externalId?.startsWith('thesession-set:'));
  const itiIds        = selectedArr.filter(id => user.cards[id]?.externalId?.startsWith('irishtuneinfo:'));

  const bulkMenu = useContextMenu([
    ...(addEligible.length > 0 ? [{
      label: t('library.batch.addToDecks'),
      onClick: () => showDeckPickerModal(
        'library.addToDecks.title', 'library.addToDecks.confirm', addEligible,
        (deckIds) => mutate(s => {
          for (const deckId of deckIds) {
            const deck = s.decks[deckId]; if (!deck) continue;
            for (const cardId of selectedArr)
              if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
          }
        }),
      ),
    }] : []),
    ...(removeEligible.length > 0 ? [{
      label: t('library.batch.removeFromDecks'),
      onClick: () => showDeckPickerModal(
        'library.removeFromDecks.title', 'library.removeFromDecks.confirm', removeEligible,
        (deckIds) => mutate(s => {
          for (const deckId of deckIds) {
            const deck = s.decks[deckId]; if (!deck) continue;
            deck.entries = deck.entries.filter(e => !selectedArr.includes(e.cardId));
          }
        }),
      ),
    }] : []),
    { label: t('library.batch.addTag'), onClick: () => showAddTagModal(selectedArr) },
    // Nothing to offer when the selection carries no tags at all — the modal
    // would open on an empty list.
    ...(selectedArr.some(cId => (user.cards[cId]?.tags ?? []).length > 0) ? [{
      label: t('library.batch.removeTag'), onClick: () => showRemoveTagModal(selectedArr),
    }] : []),
    { label: t('library.batch.importance'), onClick: () => showImportanceModal(selectedArr) },
    // One block per SOURCE, listing the families of card that source can act
    // on — the menu says where the cards come from and what kind they are, the
    // dialog says what will be done to them. Each dialog then words its
    // actions exactly as that card's own pin menu words them: one act, one
    // name, whether you reach it from a single card or from forty.
    //
    // A block appears only when the selection actually holds such cards, and
    // the count moves to the dialog title, since one source now covers two
    // families with counts of their own.
    ...(theSessionIds.length > 0 || setIds.length > 0 ? [
      { heading: t('library.batch.source.thesession') },
    ] : []),
    ...(theSessionIds.length > 0 ? [
      { label: t('library.batch.family.tunes'), onClick: () => showRefreshModal({
        cardIds: theSessionIds,
        title: t('library.batch.refresh.title', { n: theSessionIds.length }),
        confirmKey: 'library.batch.refresh.confirm',
        fetch: (card) => fetchTuneById(sourceIdOf(card, 'thesession:')),
        // Ticked together, written from a single fetch per card — the whole
        // reason this is one entry rather than three.
        fields: [
          { key: 'name',       labelKey: 'card.contextMenu.refreshName',       apply: applyTheSessionName },
          { key: 'abc',        labelKey: 'card.contextMenu.refreshAbc',        apply: applyTheSessionAbc },
          { key: 'importance', labelKey: 'card.contextMenu.refreshImportance', apply: applyTheSessionImportance },
        ],
      }) },
    ] : []),
    // A set has exactly one refreshable thing, and IrishTuneInfo exactly one
    // action — but both still go through the same picker as the tunes above.
    // A single tickbox reads as an odd list of one; it is worth it for what it
    // brings with it: the same count line, the same overwrite warning, the same
    // progress bar and the same named list of what got skipped.
    ...(setIds.length > 0 ? [
      { label: t('library.batch.family.sets'), onClick: () => showRefreshModal({
        cardIds: setIds,
        title: t('library.batch.refreshSet.title', { n: setIds.length }),
        confirmKey: 'library.batch.refreshSet.confirm',
        fetch: async (card) => {
          const parsed = parseSetExternalId(card.externalId);
          if (!parsed) throw new Error(`not a set id: ${card.externalId ?? ''}`);
          const set = await fetchSet(parsed.memberId, parsed.setId);
          // Resolved against live state, so a tune pulled in for an earlier set
          // in the same run is reused rather than created a second time.
          return buildSetCards(set, appState.value.cards, defaultTuneRepeat(appState.value));
        },
        fields: [
          { key: 'tunes', labelKey: 'card.contextMenu.refreshSetTunes', apply: (card, { setCard, newTunes }, s) => {
            for (const tune of newTunes) s.cards[tune.id] = tune;
            card.tunes = setCard.tunes;
          } },
        ],
      }) },
    ] : []),
    ...(itiIds.length > 0 ? [
      { heading: t('library.batch.source.irishtuneinfo') },
      { label: t('library.batch.family.tunes'), onClick: () => {
        // One mapping sync for the whole run: ensureItiMapping re-checks the
        // collection's `total` on every call, so asking per card would add as
        // many round trips as there are cards. Started on the first lookup
        // rather than here, so merely opening the dialog costs nothing.
        let mapping: Promise<ItiMappingDb> | null = null;
        const equivalentOf = async (card: Card): Promise<ItiMappingEntry | undefined> => {
          mapping ??= ensureItiMapping();
          return (await mapping).byItiId[sourceIdOf(card, 'irishtuneinfo:')];
        };
        showRefreshModal({
          cardIds: itiIds,
          title: t('library.batch.migrate.title', { n: itiIds.length }),
          // No confirm line: "Migrer vers TheSession" with a count beside it
          // says the whole thing on its own.
          // Not "removed upstream" here: a card lands in this list because
          // TheSession's IrishTuneInfo collection knows no equivalent for it.
          skippedKey: 'library.batch.migrate.skipped',
          // The library ALREADY holds the TheSession version of this tune, as
          // a card of its own. Migrating would leave two cards claiming the
          // same externalId — a state nothing else in the app expects, and one
          // no undo would untangle. So it is not migrated, and what becomes of
          // it is the user's call, asked once at the end for all of them.
          setAside: async (card) => {
            const entry = await equivalentOf(card);
            // No mapping at all is a plain skip, and `fetch` says so below —
            // holding it back here would file it under the wrong heading.
            if (!entry) return false;
            const twin = findByExternalId(`thesession:${entry.sessionId}`, appState.value.cards);
            return !!twin && twin.id !== card.id;
          },
          onSetAside: (cards) => showDuplicateCardsModal(cards, {
            // Reached from the library, so going to look at one is a real way
            // out — and it means leaving both this dialog and the report
            // behind rather than stranding them over the card page.
            onPick: (card) => { closeAllModals(); navigate({ view: 'card', cardId: card.id }); },
          }),
          fetch: async (card) => {
            const entry = await equivalentOf(card);
            if (!entry) throw new Error(`no TheSession equivalent for ${card.externalId ?? ''}`);
            return fetchTuneById(entry.sessionId);
          },
          fields: [
            { key: 'migrate', labelKey: 'card.contextMenu.migrate', apply: applyTheSessionMigration,
              // How many of them TheSession knows an equivalent for — the
              // others cannot be migrated at all. Cards whose equivalent is
              // ALREADY a card here still count: they are exactly what the
              // duplicate dialog at the end is for, and excluding them would
              // grey the action out and take that dialog away with it.
              eligible: async (ids) => {
                const db = await ensureItiMapping();
                let n = 0;
                for (const id of ids) {
                  // Parsed leniently, unlike sourceIdOf: an id this cannot
                  // read is one card that will not migrate, not a reason to
                  // give up on counting the rest.
                  const itiId = parseInt((appState.value.cards[id]?.externalId ?? '').slice('irishtuneinfo:'.length), 10);
                  if (!isNaN(itiId) && db.byItiId[itiId]) n++;
                }
                return n;
              } },
          ],
        });
      } },
    ] : []),
  ]);

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
                      onClick={() => { setSortMode(m); saveSortPref(user.id, m, sortAsc); setSortOpen(false); }}
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
            onClick={() => { const next = !sortAsc; setSortAsc(next); saveSortPref(user.id, sortMode, next); }}
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
            <button
              class="btn-ghost text-xs inline-flex items-center justify-center"
              title={t('library.batch.more')}
              onClick={(e) => bulkMenu.open(e.clientX, e.clientY)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
            </button>
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
                  mutate(s => removeCards(s, selectedArr));
                },
              )}
            >
              <TrashIcon size={13} />
            </button>
          </>}
        </div>
      </div>
      {bulkMenu.menu}

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
              // Shared by the row's click handler (treatAsShift = e.shiftKey)
              // and its long-press handler (treatAsShift = always true, long-press
              // being mobile's equivalent of holding Shift while clicking).
              const selectRange = (card: Card, treatAsShift: boolean): void => {
                if (treatAsShift && lastClickRef.current) {
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
              };
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
                    selectRange(card, e.shiftKey);
                  }}
                  {...createLongPressHandlers(
                    { timer: longPressTimerRef, start: longPressStartRef, fired: longPressFiredRef },
                    // Long-press = mobile's Shift+click: always ranges from the
                    // last-touched card (or just selects this one if there
                    // isn't one yet) — unlike a plain tap, never navigates,
                    // since that's the whole point of a long-press here.
                    () => selectRange(card, true),
                  )}
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
