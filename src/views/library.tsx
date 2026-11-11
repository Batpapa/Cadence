import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { appState, navigate, mutate, getContext, replaceRoute, routeSignal } from '../store';
import { pct, availabilityColor, scoreWithAliases, NO_SCORE_MATCH, timeAgo, copyText, type AliasMatch } from '../utils';
import { TrashIcon, SortAlphaIcon, ClockIcon, CalendarPlusIcon, StarIcon, CheckIcon, ScatterPlotIcon, GaugeIcon, FlameIcon, StudyIcon, ArrowLeftIcon, ArrowRightIcon, CrossIcon, PlusIcon, MoreHorizontalIcon, UploadIcon, NotesIcon, CopyIcon, ShareIcon, iconElement } from '../components/icons';
import { CARD_TYPES, cardTypeLabelKey, knownCardType, isTune } from '../services/cardTypeService';
import { CARD_SOURCES, cardSource, cardSourceLabel } from '../services/cardSourceService';
import { buildTunesetCard } from '../services/tunesetCard';
import { showDeckChoiceModal } from '../components/deckSelector';
import { generateId } from '../utils';
import { tagsWithTunes, setsMatchTuneTags } from '../services/cardRefService';
import { CardMap } from '../components/cardMap';
import { exportCards, exportCardsCSV, exportCardsTXT, cardsTextReport, cardPackageText } from '../services/importExport';
import { uploadShare } from '../services/shareService';
import { confirmModal, closeAllModals, MODAL_BACKDROP, MODAL_TITLE_CLASS, MODAL_W } from '../components/modal';
import { modalMaxW, modalMaxH } from '../services/zoomService';
import { askIncompleteExport } from '../components/incompleteExportModal';
import { showDuplicateCardsModal } from '../components/duplicateCardModal';
import { removeCards } from '../services/cardService';
import { localDayRange, hasReviewInRange } from '../services/reviewRange';
import { showDeckPickerModal, showAddTagModal, showRemoveTagModal, showImportanceModal, showCardTypeModal, showRefreshModal } from '../components/batchEdit';
import { fetchTuneById, applyTheSessionName, applyTheSessionAliases, applyTheSessionAbc, applyTheSessionImportance, applyTheSessionMigration, fetchSet, buildSetCards, parseSetExternalId, findByExternalId } from '../services/theSessionService';
import { ensureItiMapping } from '../services/itiMappingService';
import { defaultTuneRepeat, addTunesetAbcOnConvert, tunesetAbcPlaceholder } from '../services/abcService';
import type { ItiMappingDb, ItiMappingEntry } from '../services/itiMappingDb';
import { useContextMenu } from '../components/contextMenu';
import { showStudyModal } from '../components/studyModal';
import { showNewCardModal } from '../components/theSessionImport';
import { deckIdsByCard } from '../services/deckService';
import { knownChips } from '../components/filterChips';
import { coveredByTagGroups, dropTagNodeChips, renameTagNodeChips, tagChipValues, tagDisplay, tagLabel, tagNodeExists, tagTree } from '../services/tagGroups';
import { deckChipKnown, deckChipSection } from '../components/deckChips';
import { showRenameTagEverywhereModal } from '../components/tagModal';
import { availabilityOfState, replayFSRS } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import type { AppState, Card, LibrarySort } from '../types';
import { IconButton, EmptyState } from '../components/ui';
import { FilterSection, FiltersButton, ReviewedRangeSection, cycleFilter, useFiltersPanel, type FilterMap } from '../components/filterSection';
import { SearchField } from '../components/searchField';
import { createLongPressHandlers } from '../components/longPress';
import { registerOverlay } from '../components/overlayStack';

/** The one figure a row shows on its right: whatever the current sort is
 *  sorting by.
 *
 *  Two columns of statistics on every line were two answers to a question
 *  nobody had asked. The sort mode IS the question, so the row answers that one
 *  and stays quiet otherwise — and the reader never has to remember which
 *  column the list is ordered by, because it is the only one there.
 *
 *  `alpha` and `lastAdded` return null: their criterion is the order itself,
 *  and neither has a per-card value to print. Showing something else there
 *  would be showing something irrelevant. */
function sortReadout(
  sort: LibrarySort, card: Card, lastTs: number | undefined, recall: number, ease: number | undefined,
): string | null {
  if (sort === 'lastReviewed') return lastTs ? timeAgo(lastTs) : t('card.neverReviewed');
  if (sort === 'importance')   return `×${card.defaultImportance}`;
  if (sort === 'recall')       return pct(recall);
  // Never reviewed: FSRS has said nothing about this card, and a 0% would be a
  // claim rather than a blank.
  if (sort === 'difficulty')   return ease === undefined ? '—' : pct(ease);
  return null;
}

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
  // Built per row: an Element can only sit in one place of the DOM.
  const iconCdc   = () => iconElement(UploadIcon, 20);
  // A spreadsheet grid: no icon of icons.tsx draws one, so it stays drawn here.
  const iconCsv   = () => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>`;
  const iconTxt   = () => iconElement(NotesIcon, 20);
  const iconClip  = () => iconElement(CopyIcon, 20);
  const iconFile  = () => iconElement(UploadIcon, 20);
  const iconShare = () => iconElement(ShareIcon, 20);

  // ── Build modal manually for navigation support ───────────────────────────
  // The modal shell's backdrop, title and close button, so this frame reads as
  // every other dialog; sized through the zoom correction like them (a raw
  // 90vw/85vh ignored the app zoom).
  const overlay = document.createElement('div');
  overlay.className = `fixed inset-0 z-50 flex items-center justify-center ${MODAL_BACKDROP}`;

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col';
  dialog.style.cssText = `max-width:min(${MODAL_W.m}, ${modalMaxW(0.9)}); max-height:${modalMaxH(0.85)};`;

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-3 border-b border-border shrink-0';
  const headerLeft = document.createElement('div');
  headerLeft.className = 'flex items-center gap-1 min-w-0';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'icon-btn -ml-2 hidden';
  backBtn.append(iconElement(ArrowLeftIcon, 16));
  backBtn.setAttribute('aria-label', t('modal.back'));
  backBtn.title = t('modal.back');
  const titleEl = document.createElement('h2');
  titleEl.className = MODAL_TITLE_CLASS;
  headerLeft.append(backBtn, titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn -mr-2';
  closeBtn.append(iconElement(CrossIcon, 16));
  closeBtn.setAttribute('aria-label', t('common.close'));
  closeBtn.title = t('common.close');
  header.append(headerLeft, closeBtn);

  const body = document.createElement('div');
  body.className = 'px-5 py-4 space-y-2 overflow-y-auto flex-1';
  body.dataset.tour = 'export-body';

  dialog.append(header, body);
  overlay.appendChild(dialog);

  let unregister = () => {};
  const close = () => { unregister(); overlay.remove(); };
  unregister = registerOverlay(close);
  closeBtn.onclick = close;
  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', e => { mouseDownOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', e => { if (e.target === overlay && mouseDownOnOverlay) close(); });

  // The `.choice-card` row (ChoiceCard's vanilla twin): accent icon, the
  // description on screen rather than in a tooltip a finger never sees, and
  // the hover from the class instead of a per-row colour painted in JS.
  const mkChoice = (makeIcon: () => Element | string, label: string, desc: string, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-card';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'shrink-0 flex items-center text-accent';
    const icon = makeIcon();
    if (typeof icon === 'string') iconWrap.innerHTML = icon; else iconWrap.append(icon);
    const text = document.createElement('span');
    text.className = 'flex-1 min-w-0';
    const labelEl = document.createElement('span');
    labelEl.className = 'js-choice-label block text-sm font-medium text-primary';
    labelEl.textContent = label;
    const descEl = document.createElement('span');
    descEl.className = 'block text-xs text-muted mt-0.5 leading-snug';
    descEl.textContent = desc;
    text.append(labelEl, descEl);
    const arrow = document.createElement('span');
    arrow.className = 'text-dim shrink-0 flex items-center';
    arrow.append(iconElement(ArrowRightIcon, 16));
    btn.append(iconWrap, text, arrow);
    btn.onclick = onClick;
    return btn;
  };

  const renderRoot = () => {
    titleEl.textContent = t('library.exportSelected');
    backBtn.classList.add('hidden');
    body.innerHTML = '';
    const cdc = mkChoice(iconCdc, t('library.export.cdc'), t('library.export.cdcDesc'), renderCdc);
    cdc.dataset.tour = 'export-cdc';
    body.appendChild(cdc);
    body.appendChild(mkChoice(iconCsv, 'CSV', t('library.export.csvDesc'), () => { close(); exportCardsCSV(cards, user); }));
    body.appendChild(mkChoice(iconTxt, 'TXT', t('library.export.txtDesc'), renderTxt));
  };

  // Same two-level shape as renderCdc: one format, two destinations. The
  // clipboard row reports back in place rather than closing silently — a
  // copy leaves nothing on screen to prove it happened.
  const renderTxt = () => {
    titleEl.textContent = 'TXT';
    backBtn.classList.remove('hidden');
    backBtn.onclick = renderRoot;
    body.innerHTML = '';
    body.appendChild(mkChoice(iconTxt, t('library.export.file'), t('library.export.txtDesc'),
      () => { close(); exportCardsTXT(cards, user); }));
    const copyRow = mkChoice(iconClip, t('common.copyToClipboard'), t('common.copyToClipboardDesc'), () => {
      void copyText(cardsTextReport(cards, user)).then(ok => {
        const label = copyRow.querySelector('.js-choice-label');
        if (label) label.textContent = t(ok ? 'common.copied' : 'common.copyFailed');
        label?.classList.toggle('text-primary', ok);
        label?.classList.toggle('text-danger', !ok);
        // A failure keeps the modal open: nothing reached the clipboard, so
        // closing would read as success.
        if (ok) setTimeout(close, 900);
      });
    });
    body.appendChild(copyRow);
  };

  const renderCdc = () => {
    titleEl.textContent = t('library.export.cdc');
    backBtn.classList.remove('hidden');
    backBtn.onclick = renderRoot;
    body.innerHTML = '';
    body.appendChild(mkChoice(iconFile,  t('library.export.file'),  t('library.export.cdcDesc'),  () => { close(); void exportCards(cards, askIncompleteExport); }));
    body.appendChild(mkChoice(iconShare, t('library.share.label'),  t('library.share.desc'),       () => { void renderShareResult(); }));
  };

  const renderShareResult = async () => {
    backBtn.classList.add('hidden');
    body.innerHTML = '';
    const status = document.createElement('p');
    status.className = 'text-xs text-muted text-center py-2';
    status.textContent = t('library.share.uploading');
    body.appendChild(status);
    try {
      // Built before anything is sent: a share is the one export that leaves
      // this device for good, so an attachment it could not fetch back has to
      // be settled here rather than discovered by whoever receives the key.
      const text = await cardPackageText(cards, askIncompleteExport);
      if (text === null) { renderCdc(); return; }
      const { key, secondsRemaining } = await uploadShare(text);
      body.innerHTML = '';
      const keyEl = document.createElement('div');
      keyEl.className = 'text-center font-mono text-3xl font-bold tracking-[0.3em] text-primary py-2';
      keyEl.textContent = key;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-primary w-full text-sm';
      copyBtn.textContent = t('library.share.copy');
      copyBtn.onclick = () => {
        void copyText(key).then(ok => {
          if (!ok) return;
          copyBtn.textContent = t('common.copied');
          setTimeout(() => { copyBtn.textContent = t('library.share.copy'); }, 2000);
        });
      };
      const validity = document.createElement('p');
      validity.className = 'text-xs text-muted text-center';
      validity.textContent = t('library.share.validity', { minutes: Math.floor(secondsRemaining / 60) });
      body.append(keyEl, copyBtn, validity);
    } catch (e) {
      status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      status.classList.replace('text-muted', 'text-danger');
      backBtn.classList.remove('hidden');
      backBtn.onclick = renderCdc;
    }
  };

  document.body.appendChild(overlay);
  renderRoot();
}

/** The "no type" chip. A sentinel rather than the empty string so it can never
 *  be confused with a real, if unlikely, type value — same reasoning as
 *  NO_DECK (deckChips.ts), and the same shape so the two read alike. */
const NO_TYPE = '__no_type__';
/** The "no source" chip: a card made by hand, or from a source this build does
 *  not know (cardSource). Same shape as NO_TYPE. Stored in routes: never
 *  rename it. */
const NO_SOURCE = '__no_source__';
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
  const [activeTypes, setActiveTypes] = useState<FilterMap>(() => new Map(savedRoute?.types ?? []));
  const [activeSources, setActiveSources] = useState<FilterMap>(() => new Map(savedRoute?.sources ?? []));
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
  const [revFrom,     setRevFrom]     = useState(savedRoute?.reviewedFrom ?? '');
  const [revTo,       setRevTo]       = useState(savedRoute?.reviewedTo ?? '');
  const [mapOpen,     setMapOpen]     = useState(false);
  const [selected,    setSelected]    = useState<Set<string>>(new Set());
  /** Decks pinned in the deck choice of "Create a set" — kept for as long as
   *  the library is on screen, as an import keeps them for its own screen. */
  const setDeckPinsRef = useRef<Set<string>>(new Set());
  /** The cards another screen limited the library to (see Route's `cards`);
   *  null = every card. */
  const [onlyCards,   setOnlyCards]   = useState<string[] | null>(savedRoute?.cards ?? null);
  // The cards in play: the whole library, or the ones it was limited to. Ids of
  // cards deleted since simply match nothing.
  const onlySet = onlyCards ? new Set(onlyCards) : null;
  const inPool  = (cardId: string) => !!user.cards[cardId] && (!onlySet || onlySet.has(cardId));
  const pool    = onlySet ? allCards.filter(c => onlySet.has(c.id)) : allCards;
  const sortRef   = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sortOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (!sortRef.current?.contains(e.target as Node)) setSortOpen(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [sortOpen]);

  useEffect(() => {
    replaceRoute({ view: 'library', search: searchQuery, tags: [...activeTags], decks: [...activeDecks], types: [...activeTypes], sources: [...activeSources], sort: sortMode, sortAsc, tagOr: tagFilterOr, deckOr: deckFilterOr, reviewedFrom: revFrom, reviewedTo: revTo, cards: onlyCards ?? undefined });
  }, [searchQuery, activeTags, activeDecks, activeTypes, activeSources, sortMode, sortAsc, tagFilterOr, deckFilterOr, revFrom, revTo, onlyCards]);

  // No autofocus on the search field (2026-09-08). Every other focusIfDesktop
  // call in the app is in something the user just opened IN ORDER to type — a
  // modal, a rename, the command palette. This one fired on a page merely
  // navigated to, which meant arriving at the library swallowed the keyboard
  // and, because focusing scrolls a container to reveal its target, threw away
  // the scroll position restored a frame earlier.

  // ── Filter metadata ───────────────────────────────────────────────────────────
  // Types come from what this BUILD knows, not from what the library happens to
  // hold: `Card.type` is an open string, and a value from a future build would
  // otherwise get a chip of its own instead of falling under "no type", where
  // its label already puts it. "No type" leads, as NO_DECK does below and as
  // "Aucun" does in the card view's own type selector.
  const typeItems  = [NO_TYPE, ...CARD_TYPES];
  // Sources: this build's list (cardSourceService), "no source" first, read
  // off the externalId, which replaced the "TheSession" tag (2026-11-09).
  // Unlike the types, only the ones the cards in play actually have are
  // offered (the user's call, 2026-11-09), plus a pinned chip, so a filter
  // never narrows the list from a chip nobody can see.
  const sourceKeyOf = (c: Card) => cardSource(c) ?? NO_SOURCE;
  const sourceKnown = (source: string) => source === NO_SOURCE || (CARD_SOURCES as readonly string[]).includes(source);
  const sourcesInPool = new Set<string>(pool.map(sourceKeyOf));
  const sourceItems = [NO_SOURCE, ...CARD_SOURCES]
    .filter(s => sourcesInPool.has(s) || activeSources.has(s));

  // What the tag section matches a card on: a set is also found by its tunes'
  // tags, unless that is switched off in Misc. (see tagsWithTunes). Every tag
  // read of the section goes through this — the chips offered, whether the
  // section shows, the filter, the chips still available — or ticking `reel`
  // would list a set without lighting the chip that let it in. Built once per
  // render: the sets' tune lists are resolved here and nowhere else.
  const tuneTagsOn = setsMatchTuneTags(user);
  // Each tag together with the groups above it (tagGroups.ts): a card tagged
  // "key::A::minor" answers to the chips "key" and "key::A" too, as a card
  // answers to its deck's folders.
  const filterTags = new Map(pool.map(c => [c.id, tagChipValues(tuneTagsOn ? tagsWithTunes(c, user.cards) : c.tags ?? [])]));
  const filterTagsOf = (c: Card) => filterTags.get(c.id) ?? [];

  // A pinned chip naming a deck or a folder deleted since, a tag no card
  // carries any more, or a type this build does not know, is IGNORED rather
  // than left filtering the list with no chip on screen to explain it (a back
  // navigation after a deletion on another device used to give an empty
  // library, cause unseen). Read through these, never written back: the stored
  // maps keep whatever the route carried. A pinned chip that does name
  // something is always offered, even with nothing in the pool behind it.
  const deckKnown = (key: string) => deckChipKnown(user, key);
  const tagKnown  = (tag: string) => tagNodeExists(allCards, tag);
  const typeKnown = (type: string) => typeItems.includes(type);
  const liveTags  = knownChips(activeTags, tagKnown);
  const liveTypes = knownChips(activeTypes, typeKnown);
  const liveSources = knownChips(activeSources, sourceKnown);

  const allTags    = [...new Set([...pool.flatMap(filterTagsOf), ...liveTags.keys()])].sort();
  const tagGroupTree = tagTree(allTags);
  // What an included group chip takes in, drawn as covered (deck folders' rule).
  const coveredTags = coveredByTagGroups(allTags, [...liveTags].filter(([, s]) => s === 'include').map(([k]) => k));
  // One pass over the decks, not every deck searched per card (deckIdsByCard).
  const decksByCard = deckIdsByCard(user);
  const hasOrphans = pool.some(c => !decksByCard.has(c.id));
  // The decks and their folders, as chips (deckChips.ts, shared with the
  // analyser's tunes tab).
  const deckSection = deckChipSection(user, activeDecks, inPool, hasOrphans);
  const liveDecks   = deckSection.live;

  // ── Which sections are worth a line ───────────────────────────────────────────
  // A section earns its place only if clicking in it could actually split the
  // library; offering to sort a pile of identical things is noise. All three are
  // read from ALL the cards in play — the library, or the cards it was limited
  // to — never from the filtered ones, or a section would vanish at the moment
  // it did its job.
  //
  // Types and decks are exhaustive partitions — every card falls in exactly one
  // bucket, "no type" and "no deck" included — so one occupied bucket means
  // every card matches and nothing can be split. Tags are NOT a partition: a
  // card may carry several or none, so a lone tag still splits the library,
  // unless every single card happens to carry it.
  //
  // And each stays visible while it holds an active filter, whatever the
  // library looks like: a route can arrive carrying one (a back navigation, a
  // shared link), and a filter narrowing the list from a section nobody can see
  // would be unexplainable.
  const hasDeckMix = deckSection.hasMix;
  const hasTagMix  = liveTags.size > 0 || allTags.length > 1
    || (allTags.length === 1 && pool.some(c => !filterTagsOf(c).includes(allTags[0]!)));
  const hasTypeMix = liveTypes.size > 0
    || new Set(pool.map(c => knownCardType(c) ?? NO_TYPE)).size > 1;
  // Sources are a partition too, "no source" included.
  const hasSourceMix = liveSources.size > 0 || sourcesInPool.size > 1;
  // The rule above stops at the chip sections. The review dates stay whatever
  // the library holds: with no review anywhere they still answer two different
  // questions — everything, or the empty set that proves nothing was revised in
  // that window — and unlike a chip, an unset date range shows nothing about
  // what it would match, so hiding it would hide the question itself.

  /** The filters the funnel counts, opens on and clears (useFiltersPanel): the
   *  live chips, never the pinned ones, and the dates as one. The AND/OR
   *  toggles filter nothing on their own; the search and the "N cards" limit
   *  each have their own cross. The clear empties the pinned maps whole, so a
   *  chip of a deck deleted since does not ride along in the route. */
  const filterCount = liveDecks.size + liveTypes.size + liveSources.size + liveTags.size
    + (revFrom !== '' || revTo !== '' ? 1 : 0);
  const filters = useFiltersPanel(filterCount, () => {
    setActiveDecks(new Map());
    setActiveTypes(new Map());
    setActiveSources(new Map());
    setActiveTags(new Map());
    setRevFrom('');
    setRevTo('');
  });

  // ── Filtered list (recomputed every render) ───────────────────────────────────
  const q = searchQuery.toLowerCase();
  const revRange = localDayRange(revFrom, revTo);
  // Name AND aliases, scored once per card: the filter, the relevance order and
  // the "Alias: …" line under a row found by one all read this.
  const textMatch = new Map<string, AliasMatch>();
  const filteredUnsorted = pool.filter(c => {
    const tags       = filterTagsOf(c);
    // externalId match is EXACT (whole "source:id", or just the id part),
    // not a substring — "729" must not also pull in "thesession:7290".
    const extId      = c.externalId?.toLowerCase();
    const extIdOnly  = extId?.slice(extId.indexOf(':') + 1);
    const matchExternalId = q !== '' && (extId === q || extIdOnly === q);
    const nameMatch  = q ? scoreWithAliases(c.name, c.aliases, q) : null;
    if (nameMatch) textMatch.set(c.id, nameMatch);
    const matchText = !nameMatch || nameMatch.score < NO_SCORE_MATCH || matchExternalId;
    const deckValues = deckSection.valuesOf(c.id);

    const tagEntries  = [...liveTags];
    const inclTags    = tagEntries.filter(([, fs]) => fs === 'include').map(([t]) => t);
    const exclTags    = tagEntries.filter(([, fs]) => fs === 'exclude').map(([t]) => t);
    const matchTags   = liveTags.size === 0 || (
      (inclTags.length === 0 || (tagFilterOr ? inclTags.some(t => tags.includes(t)) : inclTags.every(t => tags.includes(t)))) &&
      exclTags.every(t => !tags.includes(t))
    );

    const deckEntries = [...liveDecks];
    const inclDecks   = deckEntries.filter(([, fs]) => fs === 'include').map(([id]) => id);
    const exclDecks   = deckEntries.filter(([, fs]) => fs === 'exclude').map(([id]) => id);
    // A folder chip: in any deck below that folder (valuesOf lists those
    // folders). Excluding it therefore removes a card that is in one of those
    // decks, whatever else holds it — the excludes are a hard AND, as everywhere.
    const hasDeck     = (id: string) => deckValues.includes(id);
    const matchDecks  = liveDecks.size === 0 || (
      (inclDecks.length === 0 || (deckFilterOr ? inclDecks.some(hasDeck) : inclDecks.every(hasDeck))) &&
      exclDecks.every(id => !hasDeck(id))
    );
    // ALWAYS "any of", never "all of": a card holds exactly one type, so an AND
    // over two included types matches nothing and reads as a broken filter.
    // That is also why this section shows no AND/OR toggle — there is no second
    // reading to offer. Excludes still apply on top, and "exclude sets" is the
    // gesture that earns this filter its place: a set repeats its tunes' names
    // in the list, and hiding them de-clutters it.
    const typeKey     = knownCardType(c) ?? NO_TYPE;
    const typeEntries = [...liveTypes];
    const inclTypes   = typeEntries.filter(([, fs]) => fs === 'include').map(([id]) => id);
    const exclTypes   = typeEntries.filter(([, fs]) => fs === 'exclude').map(([id]) => id);
    const matchTypes  = liveTypes.size === 0 || (
      (inclTypes.length === 0 || inclTypes.includes(typeKey)) && !exclTypes.includes(typeKey)
    );

    // "Any of", like the types and for the same reason: one source per card.
    const sourceKey     = sourceKeyOf(c);
    const sourceEntries = [...liveSources];
    const inclSources   = sourceEntries.filter(([, fs]) => fs === 'include').map(([id]) => id);
    const exclSources   = sourceEntries.filter(([, fs]) => fs === 'exclude').map(([id]) => id);
    const matchSources  = liveSources.size === 0 || (
      (inclSources.length === 0 || inclSources.includes(sourceKey)) && !exclSources.includes(sourceKey)
    );

    const matchReviewed = hasReviewInRange(user.cardWorks[`${user.currentProfileId}:${c.id}`]?.history, revRange);

    return matchText && matchTags && matchDecks && matchTypes && matchSources && matchReviewed;
  });
  // Each card's FSRS state, replayed from its whole history at most once per
  // render — the sorts and every row's two dots read it, which used to replay
  // it two or three times per card. Kept for this render only: a review
  // arriving by sync is read on the next one.
  const fsrsOfCard = new Map<string, ReturnType<typeof replayFSRS>>();
  const workOf = (c: Card) => user.cardWorks[`${user.currentProfileId}:${c.id}`];
  const fsrsOf = (c: Card): ReturnType<typeof replayFSRS> => {
    if (fsrsOfCard.has(c.id)) return fsrsOfCard.get(c.id);
    const work = workOf(c);
    const fsrs = work ? replayFSRS(work.history) : undefined;
    fsrsOfCard.set(c.id, fsrs);
    return fsrs;
  };
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
    // Precomputed: the comparator would ask it twice per comparison.
    const kOf = new Map(filteredUnsorted.map(c => [c.id, availabilityOfState(user, fsrsOf(c))]));
    filtered = [...filteredUnsorted].sort((a, b) => numCmp(kOf.get(a.id)!, kOf.get(b.id)!) || byName(a, b));
  } else if (sortMode === 'difficulty') {
    // FSRS difficulty D (1–10) ascending; never-reviewed = −∞, so they lead.
    const dOf = new Map(filteredUnsorted.map(c => [c.id, fsrsOf(c)?.difficulty ?? Number.NEGATIVE_INFINITY]));
    filtered = [...filteredUnsorted].sort((a, b) => numCmp(dOf.get(a.id)!, dOf.get(b.id)!) || byName(a, b));
  } else {
    // Relevance as rankByRelevance orders it: best tier, then a name match
    // before an alias match, then alphabetical.
    const scoreOf = (c: Card) => textMatch.get(c.id)?.score ?? NO_SCORE_MATCH;
    const viaOf   = (c: Card) => Number(textMatch.get(c.id)?.via !== undefined);
    filtered = q
      ? [...filteredUnsorted].sort((a, b) => scoreOf(a) - scoreOf(b) || viaOf(a) - viaOf(b) || byName(a, b))
      : [...filteredUnsorted].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sortAsc) filtered = filtered.slice().reverse();

  // ── Available chips (derived from filtered) ───────────────────────────────────
  const availTags  = new Set(filtered.flatMap(filterTagsOf));
  const availDecks = new Set(filtered.flatMap(c => deckSection.valuesOf(c.id)));
  const availTypes = new Set(filtered.map(c => knownCardType(c) ?? NO_TYPE));
  const availSources = new Set(filtered.map(sourceKeyOf));

  // ── Toggle handlers ───────────────────────────────────────────────────────────
  // Cycled from the known chips, so the first click after a deletion also drops
  // the dead key from the stored map — and from the route with it.
  const toggleTag  = (tag: string, back?: boolean) => setActiveTags(prev  => cycleFilter(knownChips(prev, tagKnown), tag, back));
  const toggleDeck = (id: string,  back?: boolean) => setActiveDecks(prev => cycleFilter(knownChips(prev, deckKnown), id, back));
  const toggleType = (id: string,  back?: boolean) => setActiveTypes(prev => cycleFilter(knownChips(prev, typeKnown), id, back));
  const toggleSource = (id: string, back?: boolean) => setActiveSources(prev => cycleFilter(knownChips(prev, sourceKnown), id, back));
  // A chip pinned on the old name follows the rename instead of vanishing.
  const renameTag  = (tag: string) => showRenameTagEverywhereModal(
    tag,
    // A group's chips follow it, the ones under it included.
    to => setActiveTags(prev => renameTagNodeChips(prev, tag, to)),
    // A deleted tag's chip goes with it (a dissolved group's, with those under
    // it), rather than lying in the route until a tag of that name comes back
    // and finds itself filtered.
    () => setActiveTags(prev => dropTagNodeChips(prev, tag)),
  );

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
  }, [q, activeTags, activeDecks, onlyCards]);

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

  // How many of the selected cards each deck holds, counted once per deck
  // through a set of its cards — not every selected card searched in every
  // deck, twice per menu, which a "select all" paid on every render (bench,
  // 2026-11-10). `selectedArr` comes from a Set: no card counts twice.
  const deckShares = selectedArr.length === 0 ? [] : Object.values(user.decks).map(d => {
    const inDeck = new Set(d.entries.map(e => e.cardId));
    return { d, n: selectedArr.filter(cId => inDeck.has(cId)).length };
  });

  const addEligible = deckShares
    .filter(({ n }) => n < selectedArr.length)
    .map(({ d, n }) => ({
      id: d.id,
      info: t('library.deckInfo.add', { n: selectedArr.length - n }),
    }))
    .sort((a, b) => (user.decks[a.id]?.name ?? '').localeCompare(user.decks[b.id]?.name ?? ''));

  const removeEligible = deckShares
    .filter(({ n }) => n > 0)
    .map(({ d, n }) => ({
      id: d.id,
      info: t('library.deckInfo.remove', { n }),
    }))
    .sort((a, b) => (user.decks[a.id]?.name ?? '').localeCompare(user.decks[b.id]?.name ?? ''));

  // Every bulk edit lives behind one ⋯ menu: the toolbar keeps only what you
  // reach for constantly (export, study, delete), so it stays readable on a
  // portrait phone. Declared after the eligibility lists above so "remove from
  // decks" can be dropped when no selected card is in any deck — same
  // condition that used to hide its toolbar button. Reuses the
  // right-click menu's hook (anchoring, dismissal, zoom) on a left click.
  // Three disjoint families, each with its own upstream and its own verb.
  // `thesession:` and `thesession-set:` never overlap — the dash form is
  // deliberately not a prefix of the colon form (see setExternalId).
  const theSessionIds = selectedArr.filter(id => user.cards[id]?.externalId?.startsWith('thesession:'));
  const setIds        = selectedArr.filter(id => user.cards[id]?.externalId?.startsWith('thesession-set:'));
  const itiIds        = selectedArr.filter(id => user.cards[id]?.externalId?.startsWith('irishtuneinfo:'));

  // A set made of the selection (a tester's request, 2026-10-29) — the six
  // steps of a new card, its type and one + per tune, in one gesture. Offered
  // only when there is a set to make: two tunes at least, and nothing else,
  // since a set holds tunes only (canBeTuneOf). Retyping on the way was ruled
  // out; the type stays something the user sets, from a card or in bulk.
  //
  // The tunes go in in the order they were ticked: `selected` is a Set, which
  // keeps insertion order. A Shift range or a long press adds in list order,
  // and the card page reorders by dragging afterwards.
  //
  // A set with the same tunes in the same order may already exist; another is
  // made all the same — two can differ in repeats, decks or notes. The
  // analyser files a heard set on the first one it finds (setCardFor), which
  // the user accepted as is.
  const canMakeSet = selectedArr.length >= 2 && selectedArr.every(id => isTune(user.cards[id]));
  const createSet = (deckIds: string[]) => {
    const tuneIds = selectedArr;
    let setId: string | undefined;
    void mutate(s => {
      const tunes = tuneIds.map(id => s.cards[id]).filter((c): c is Card => !!c && isTune(c));
      // Re-checked inside the write: a tune deleted or retyped meanwhile makes
      // it a different set from the one asked for, so nothing is made at all.
      if (tunes.length !== tuneIds.length) return;
      const card = buildTunesetCard(tunes, {
        defaultRepeat: defaultTuneRepeat(s),
        attachments: addTunesetAbcOnConvert(s) ? [tunesetAbcPlaceholder()] : [],
        newId: generateId,
      });
      s.cards[card.id] = card;
      setId = card.id;
      for (const deckId of deckIds) s.decks[deckId]?.entries.push({ cardId: card.id });
    }).then(() => {
      if (!setId) return;
      setSelected(new Set());
      navigate({ view: 'card', cardId: setId });
    });
  };

  const bulkMenu = useContextMenu([
    ...(canMakeSet ? [{
      label: t('library.batch.createSet'),
      onClick: () => showDeckChoiceModal({ pinned: setDeckPinsRef.current, onConfirm: createSet }),
    }] : []),
    // Always offered, even with no deck the selection could join: the dialog's
    // "+ new deck" makes one (the user's rule, 2026-10-30).
    {
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
        t('library.deckInfo.add', { n: selectedArr.length }),
      ),
    },
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
    // Importance, then type, then tags — the order the card page presents the
    // same three fields in, so the bulk menu and a single card teach the same
    // sequence rather than two.
    { label: t('library.batch.importance'), onClick: () => showImportanceModal(selectedArr) },
    { label: t('library.batch.type'), onClick: () => showCardTypeModal(selectedArr) },
    { label: t('library.batch.addTag'), onClick: () => showAddTagModal(selectedArr) },
    // Nothing to offer when the selection carries no tags at all — the modal
    // would open on an empty list.
    ...(selectedArr.some(cId => (user.cards[cId]?.tags ?? []).length > 0) ? [{
      label: t('library.batch.removeTag'), onClick: () => showRemoveTagModal(selectedArr),
    }] : []),
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
        // reason this is one entry rather than several. Applied in this order:
        // aliases after the name, which they read (applyTheSessionAliases).
        fields: [
          { key: 'name',       labelKey: 'card.contextMenu.refreshName',       apply: applyTheSessionName },
          { key: 'aliases',    labelKey: 'card.contextMenu.refreshAliases',    apply: applyTheSessionAliases },
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
      { label: t('library.batch.family.sets'), onClick: () => {
        // The run writes once, at the end (showRefreshModal), so the tunes an
        // earlier set brings in are not in the state yet when the next set is
        // resolved: they are kept here, so a tune two sets play is created once.
        const createdInRun: Record<string, Card> = {};
        // A tune that reached the library by another route while the run was
        // fetching: its existing card is used, here and in every later set.
        const replacedInRun = new Map<string, Card>();
        showRefreshModal({
          cardIds: setIds,
          title: t('library.batch.refreshSet.title', { n: setIds.length }),
          confirmKey: 'library.batch.refreshSet.confirm',
          fetch: async (card) => {
            const parsed = parseSetExternalId(card.externalId);
            if (!parsed) throw new Error(`not a set id: ${card.externalId ?? ''}`);
            const set = await fetchSet(parsed.memberId, parsed.setId);
            const built = await buildSetCards(set, { ...appState.value.cards, ...createdInRun }, defaultTuneRepeat(appState.value));
            for (const tune of built.newTunes) createdInRun[tune.id] = tune;
            return built;
          },
          fields: [
            { key: 'tunes', labelKey: 'card.contextMenu.refreshSetTunes', apply: (card, { setCard, newTunes }, s) => {
              for (const tune of newTunes) {
                const twin = tune.externalId ? findByExternalId(tune.externalId, s.cards) : undefined;
                if (twin && twin.id !== tune.id) replacedInRun.set(tune.id, twin);
                else s.cards[tune.id] = tune;
              }
              card.tunes = (setCard.tunes ?? []).map(ref => {
                const twin = replacedInRun.get(ref.id);
                return twin ? { ...ref, id: twin.id, guid: twin.guid } : ref;
              });
            } },
          ],
        });
      } },
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
        /** TheSession tunes an earlier card of this run is migrating to. */
        const claimedInRun = new Set<number>();
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
            // Or an earlier card of THIS run migrates to it: the run writes
            // once at the end, so that one is not in the state yet.
            return (!!twin && twin.id !== card.id) || claimedInRun.has(entry.sessionId);
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
            const tune = await fetchTuneById(entry.sessionId);
            claimedInRun.add(entry.sessionId);
            return tune;
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
          <IconButton
            variant="outline"
            on={mapOpen}
            label={t('dashboard.cardMap')}
            aria-pressed={mapOpen}
            data-tour="library-map"
            onClick={() => setMapOpen(o => !o)}
          >
            <ScatterPlotIcon size={16} />
          </IconButton>
          <button class="btn-primary inline-flex items-center gap-1.5" data-tour="new-card" onClick={() => showNewCardModal(getContext())}>
            <PlusIcon size={14} />{t('library.newCard')}
          </button>
        </div>
      </div>

      {/* ── Card map ── */}
      {mapOpen && (
        <div class="px-6 pb-4" data-tour="library-cardmap">
          <CardMap user={user} cards={hasSelection ? allCards.filter(c => selected.has(c.id)) : filtered} />
        </div>
      )}

      {/* ── Search + filters ── */}
      <div class="px-6 pb-2 space-y-1">
        <div class="flex gap-2">
          <SearchField
            value={searchQuery}
            onInput={setSearchQuery}
            placeholder={t('library.search')}
            tour="library-search"
          />
          <FiltersButton shown={filters.shown} count={filterCount} onPress={filters.press} tour="library-filters-toggle" />
        </div>

        {/* Always in sight while it applies: a library that silently holds
            fewer cards than the user owns reads as lost data. It says how many,
            not where they came from — the library does not know, and the next
            screen to hand it a set of cards should not need a new label. */}
        {onlyCards && (
          <div class="flex pt-1">
            <button
              type="button"
              class="chip chip-on gap-1.5 cursor-pointer"
              title={t('library.limited.clear')}
              onClick={() => setOnlyCards(null)}
            >
              {t(pool.length === 1 ? 'library.limited.one' : 'library.limited.other', { count: pool.length })}
              <CrossIcon size={12} />
            </button>
          </div>
        )}

        {/* The filter families, one block for the walkthrough to light. */}
        {filters.shown && (
        <div class="space-y-1" data-tour="library-filters">
        {hasDeckMix && (
          <FilterSection
            labelKey="library.filterDecks"
            items={deckSection.items}
            folderItems={deckSection.folderItems}
            tree={deckSection.tree}
            covered={deckSection.covered}
            activeMap={liveDecks}
            labelOf={deckSection.labelOf}
            titleOf={deckSection.titleOf}
            available={availDecks}
            onToggle={toggleDeck}
            highlight={q}
            orMode={deckFilterOr}
            onToggleOr={() => setDeckFilterOr(o => !o)}
          />
        )}
        {/* No `onToggleOr`: several included types can only mean "any of
            these" (see the predicate), so there is no second reading to offer
            and no toggle to show. */}
        {hasTypeMix && (
          <FilterSection
            labelKey="library.filterTypes"
            items={typeItems}
            activeMap={liveTypes}
            labelOf={id => t(cardTypeLabelKey(id === NO_TYPE ? undefined : id))}
            titleOf={id => t(cardTypeLabelKey(id === NO_TYPE ? undefined : id))}
            available={availTypes}
            onToggle={toggleType}
          />
        )}
        {/* No `onToggleOr` either: one source per card. */}
        {hasSourceMix && (
          <FilterSection
            labelKey="library.filterSources"
            items={sourceItems}
            activeMap={liveSources}
            labelOf={id => id === NO_SOURCE ? t('library.filterNoSource') : cardSourceLabel(id)}
            titleOf={id => id === NO_SOURCE ? t('library.filterNoSource') : cardSourceLabel(id)}
            available={availSources}
            onToggle={toggleSource}
          />
        )}
        {hasTagMix && (
          <FilterSection
            labelKey="library.filterTags"
            items={allTags}
            tree={tagGroupTree}
            covered={coveredTags}
            activeMap={liveTags}
            labelOf={tagLabel}
            titleOf={tagDisplay}
            available={availTags}
            onToggle={toggleTag}
            highlight={q}
            orMode={tagFilterOr}
            onToggleOr={() => setTagFilterOr(o => !o)}
            onRename={renameTag}
          />
        )}
        <ReviewedRangeSection
          from={revFrom}
          to={revTo}
          onChange={(f, to) => { setRevFrom(f); setRevTo(to); }}
        />
        </div>
        )}
      </div>

      {/* ── Selection toolbar ── */}
      <div class="flex items-center justify-between px-6 h-9">
        <label class="flex items-center gap-2 cursor-pointer select-none" data-tour="library-select-all">
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
            <IconButton
              label={t(`library.sort.${sortMode}`)}
              aria-expanded={sortOpen}
              data-tour="library-sort"
              onClick={() => setSortOpen(o => !o)}
            >
              {(() => { const Icon = SORT_ICON[sortMode]; return <Icon size={14} />; })()}
            </IconButton>
            {/* Not CustomSelect nor useContextMenu, which the charter would
                have: the guided tour lights this list by its own handle
                (`library-sort-menu`, walkthrough/scenarios.ts), and neither
                shared menu can carry one. Drawn with the shared menu classes,
                so it reads as one of them. */}
            {sortOpen && (
              <div class="menu-surface absolute top-full right-0 mt-1 z-30 min-w-[180px]" data-tour="library-sort-menu">
                {SORT_MODES.map(m => {
                  const Icon   = SORT_ICON[m];
                  const active = m === sortMode;
                  return (
                    <button
                      key={m}
                      type="button"
                      class={`menu-item${active ? ' menu-item-on' : ''}`}
                      onClick={() => { setSortMode(m); saveSortPref(user.id, m, sortAsc); setSortOpen(false); }}
                    >
                      <span class="shrink-0 flex items-center"><Icon size={14} /></span>
                      <span class="flex-1">{t(`library.sort.${m}`)}</span>
                      {active && <span class="text-accent flex items-center"><CheckIcon size={12} /></span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <IconButton
            label={sortAsc ? t('library.sort.ascending') : t('library.sort.descending')}
            data-tour="library-sort-dir"
            onClick={() => { const next = !sortAsc; setSortAsc(next); saveSortPref(user.id, sortMode, next); }}
          >
            {/* An arrow with a shaft: icons.tsx has only chevrons, which read
                as "open", not "order". */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={`transition-transform ${sortAsc ? 'rotate-180' : ''}`}>
              <line x1="12" y1="5" x2="12" y2="19"/>
              <polyline points="19 12 12 19 5 12"/>
            </svg>
          </IconButton>
          {hasSelection && <span class="flex gap-1 items-center" data-tour="library-actions">
            <div class="w-px h-4 bg-border mx-1" />
            <IconButton label={t('library.exportSelected')} data-tour="library-export" onClick={() => showExportModal(allCards.filter(c => selected.has(c.id)), user)}>
              <UploadIcon size={14} />
            </IconButton>
            <IconButton
              label={t('library.batch.more')}
              data-tour="library-bulk"
              onClick={(e) => bulkMenu.open(e.clientX, e.clientY)}
            >
              <MoreHorizontalIcon size={14} />
            </IconButton>
            <button
              type="button"
              class="btn-study text-xs flex items-center"
              title={t('library.study')}
              aria-label={t('library.study')}
              onClick={() => {
                const pool = [...selected].map(id => ({ cardId: id }));
                showStudyModal({ entries: pool, title: t('library.title'), defaultContext: null });
              }}
            >
              <StudyIcon size={14} />
            </button>
            <IconButton
              variant="danger"
              label={t('library.deleteSelected')}
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
              <TrashIcon size={14} />
            </IconButton>
          </span>}
        </div>
      </div>
      {bulkMenu.menu}

      {/* ── Card list ── */}
      <div class="px-6 pb-6">
        {filtered.length === 0 ? (
          <EmptyState>
            {(q || liveTags.size > 0 || liveDecks.size > 0) ? t('library.noMatch') : t('library.empty')}
          </EmptyState>
        ) : (
          <div class="lib-list space-y-1">
            {(() => {
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
              const work     = workOf(card);
              const fsrs     = fsrsOf(card);
              const k        = availabilityOfState(user, fsrs);
              const cardEase = fsrs ? (10 - fsrs.difficulty) / 9 : undefined;
              const isSel    = selected.has(card.id);
              const readout  = sortReadout(sortMode, card, work?.history.at(-1)?.ts, k, cardEase);

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
                    <span class={`w-2 h-2 rounded-full ${availabilityColor(k, cardEase === undefined)}`} title={cardEase === undefined ? t('card.neverReviewed') : t('card.dot.recall', { pct: pct(k) })} />
                    <span
                      class={`w-2 h-2 rounded-full ${cardEase === undefined ? 'bg-border' : cardEase >= 0.6 ? 'bg-success' : cardEase >= 0.35 ? 'bg-warn' : 'bg-danger'}`}
                      title={cardEase !== undefined ? t('card.dot.ease', { pct: pct(cardEase) }) : t('card.neverReviewed')}
                    />
                  </span>

                  <span class="flex-1 min-w-0">
                    <span class={`text-sm text-primary block truncate ${selected.size === 0 ? 'hover:text-accent transition-colors' : ''}`}>
                      {card.name}
                    </span>
                    {/* Why a row whose name does not contain the search is here. */}
                    {q && textMatch.get(card.id)?.via !== undefined && (
                      <span class="text-xs text-dim block truncate">
                        {t('search.viaAlias', { alias: textMatch.get(card.id)!.via! })}
                      </span>
                    )}
                  </span>

                  {/* Flush against the row's right edge, so the figures line up
                      on their own without a reserved width. The tooltip names
                      the criterion rather than repeating the value. */}
                  {readout !== null && (
                    <span
                      class="text-xs font-mono tabular-nums text-dim shrink-0"
                      title={t(`library.sort.${sortMode}`)}
                    >
                      {readout}
                    </span>
                  )}
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
