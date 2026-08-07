import type { AppContext, Card } from '../types';
import { focusIfDesktop, sortByRelevance } from '../utils';
import { mutate, appState } from '../store';
import {
  searchTunes, fetchTuneById, fetchPlaylist, fetchTunesByIds, fetchAudioFile,
  tuneToCard, isServerWarm,
  type TuneSearchResult,
} from '../services/irishTuneInfoService';
import { findByExternalId, fetchTunesByIds as fetchTunesByIdsTheSession, tuneResultToCard } from '../services/theSessionService';
import { ensureItiMapping } from '../services/itiMappingService';
import { showModal, closeModal } from './modal';
import { t } from '../services/i18nService';
import { getZoom } from '../services/zoomService';

// ── Tab helpers (same look as theSessionImport's) ────────────────────────────

function mkTab(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.className = `px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
    active ? 'bg-accent text-white' : 'text-muted hover:text-primary hover:bg-elevated'
  }`;
  btn.onclick = onClick;
  return btn;
}

function mkInputRow(placeholder: string): { wrap: HTMLDivElement; inp: HTMLInputElement; info: HTMLSpanElement } {
  const wrap = document.createElement('div');
  wrap.className = 'flex-1 relative flex items-center bg-bg border border-border rounded px-3 py-2 transition-colors focus-within:border-accent overflow-hidden';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'flex-1 min-w-0 bg-transparent outline-none text-sm text-primary placeholder:text-dim';
  inp.placeholder = placeholder;

  const info = document.createElement('span');
  info.className = 'absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dim bg-bg pl-2 pointer-events-none whitespace-nowrap';

  wrap.append(inp, info);
  return { wrap, inp, info };
}

const fetchingMsg  = () => isServerWarm() ? t('irishTuneInfo.status.fetching')  : t('irishTuneInfo.status.wakingServer');
const searchingMsg = () => isServerWarm() ? t('irishTuneInfo.status.searching') : t('irishTuneInfo.status.wakingServer');

/** Parses a pasted delimited ID list ("1;5;97", "1, 5, 97", "1 5 97") — returns
 *  [] unless there are at least two distinct positive integers, so a lone ID
 *  still falls through to the regular single-tune lookup. */
function parseIdList(text: string): number[] {
  if (!/^\d+(?:[;,\s]+\d+)+[;,\s]*$/.test(text)) return [];
  return [...new Set(text.split(/[;,\s]+/).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0))];
}

// ── Body builder ──────────────────────────────────────────────────────────────

export function buildIrishTuneInfoBody(
  ctx: AppContext,
  status: HTMLElement,
  getTargetDeckIds?: () => Set<string> | undefined,
  onNavigateToCard?: () => void,
  withDeckChoice: (onReady: () => void) => void = onReady => onReady(),
): HTMLElement {
  let activeTab: 'tune' | 'playlist' = 'tune';
  let includeAudio = false;

  const setImportedStatus = (cardId: string, cardName: string) => {
    const marker = '\x00';
    const [pre, suf] = t('irishTuneInfo.status.imported', { name: marker }).split(marker);
    status.textContent = '';
    status.append(pre);
    const link = document.createElement('span');
    link.textContent = cardName;
    link.className = 'text-accent cursor-pointer hover:underline';
    link.onclick = () => { ctx.navigate({ view: 'card', cardId }); onNavigateToCard?.(); };
    status.append(link, suf);
  };

  const wrap = document.createElement('div');
  wrap.className = 'space-y-3';

  // ── Options ───────────────────────────────────────────────────────────────
  const audioRow = document.createElement('label');
  audioRow.className = 'flex items-center gap-2 cursor-pointer select-none';
  const audioChk = document.createElement('input'); audioChk.type = 'checkbox'; audioChk.className = 'card-checkbox'; audioChk.checked = false;
  const audioLbl = document.createElement('span'); audioLbl.className = 'text-xs text-muted'; audioLbl.textContent = t('irishTuneInfo.includeAudio');
  audioChk.onchange = () => { includeAudio = audioChk.checked; };
  audioRow.append(audioChk, audioLbl);
  wrap.appendChild(audioRow);

  const tabBar = document.createElement('div');
  tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg';

  const content = document.createElement('div');
  content.className = 'space-y-3';

  // ── Shared: import a single tune ──────────────────────────────────────────
  const importTune = async (tuneId: number, onSuccess: () => void, btn: HTMLButtonElement) => {
    btn.disabled = true;
    status.textContent = t('irishTuneInfo.status.checkingMapping');
    const { mapped } = await checkMapping([tuneId]);
    if (mapped.length > 0) {
      const choice = await promptUseTheSession(mapped, 1);
      if (choice === 'cancel') {
        status.textContent = '';
        btn.disabled = false;
        return;
      }
      if (choice === 'thesession') {
        status.textContent = fetchingMsg();
        try {
          const { newCards, linkIds, displayCards } = await fetchViaTheSession([mapped[0]!.sessionId], () => {});
          await commitCards(newCards, linkIds);
          const card = displayCards[0]!;
          setImportedStatus(card.id, card.name);
          onSuccess();
        } catch (e) {
          status.textContent = t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) });
        } finally {
          btn.disabled = false;
        }
        return;
      }
      // choice === 'iti': fall through to the regular IrishTuneInfo path below.
    }
    status.textContent = fetchingMsg();
    try {
      const tune = await fetchTuneById(tuneId);
      const existing = findByExternalId(`irishtuneinfo:${tune.id}`, appState.value.cards);
      if (existing) {
        await mutate(s => {
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === existing.id)) deck.entries.push({ cardId: existing.id });
          }
        });
        status.textContent = t('irishTuneInfo.status.alreadyInLibrary', { name: tune.name });
        btn.disabled = false;
      } else {
        const audioFile = includeAudio && tune.featuredAudioUrl ? await fetchAudioFile(tune.featuredAudioUrl, `${tune.name}.mp3`) : null;
        const card = tuneToCard(tune, audioFile);
        await mutate(s => {
          s.cards[card.id] = card;
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
          }
        });
        setImportedStatus(card.id, card.name);
        onSuccess();
      }
    } catch (e) {
      status.textContent = t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) });
      btn.disabled = false;
    }
  };

  /** Cards already owned, by IrishTuneInfo tune ID — shared by every batch
   *  path (playlist, pasted ID list) to skip re-fetching and still link the
   *  existing card into the target deck. */
  const buildExistingByTuneId = (): Map<number, string> => {
    const map = new Map<number, string>();
    for (const card of Object.values(appState.value.cards)) {
      if (card.externalId?.startsWith('irishtuneinfo:')) {
        const id = parseInt(card.externalId.slice('irishtuneinfo:'.length));
        if (!isNaN(id)) map.set(id, card.id);
      }
    }
    return map;
  };

  // ── TheSession redirect: if a mapping exists for some of the IDs about to be
  // imported, offer to import those specific ones from TheSession instead
  // (recommended — richer, community-curated data). Best-effort throughout:
  // a sync failure never blocks the underlying IrishTuneInfo import.

  const checkMapping = async (
    itiIds: number[],
  ): Promise<{ mapped: { itiId: number; sessionId: number; name: string }[]; unmapped: number[] }> => {
    try {
      // Only ticks during an actual (re)sync of the full collection (the
      // common case — mapping already up to date — resolves via a single
      // page-1 fetch with no progress callback at all).
      const mappingDb = await ensureItiMapping(p => {
        status.textContent = t('irishTuneInfo.status.checkingMappingProgress', { done: p.done, total: p.total });
      });
      const mapped: { itiId: number; sessionId: number; name: string }[] = [];
      const unmapped: number[] = [];
      for (const id of itiIds) {
        const entry = mappingDb.byItiId[id];
        if (entry) mapped.push({ itiId: id, sessionId: entry.sessionId, name: entry.name });
        else unmapped.push(id);
      }
      return { mapped, unmapped };
    } catch (e) {
      // Best-effort: never let a mapping-sync failure block the underlying
      // IrishTuneInfo import. Logged (not surfaced to the user) so a silent
      // failure is still diagnosable via devtools.
      console.warn('[itiMapping] TheSession mapping check failed, continuing without it', e);
      return { mapped: [], unmapped: itiIds };
    }
  };

  /** Two-choice prompt (same shape as sessionModule.ts's "long file" warning),
   *  but dismissable (X / click outside) — closing it that way is treated as
   *  'cancel', not as picking "Keep IrishTuneInfo": callers must abort the
   *  whole import in that case, exactly as if Import had never been clicked.
   *  TheSession is the recommended choice, so its button is primary and says
   *  so explicitly rather than presenting a neutral pick. */
  const promptUseTheSession = (mapped: { name: string }[], totalRequested: number): Promise<'thesession' | 'iti' | 'cancel'> => {
    return new Promise(resolve => {
      const p = document.createElement('p');
      p.className = 'text-sm text-muted leading-relaxed';
      p.textContent = mapped.length === 1
        ? t('irishTuneInfo.mapping.offerSingle', { name: mapped[0]!.name })
        : t('irishTuneInfo.mapping.offerPlural', { count: mapped.length, total: totalRequested });
      showModal(t('irishTuneInfo.mapping.title'), p, [
        { label: t('irishTuneInfo.mapping.keepIti'), onClick: () => { closeModal(); resolve('iti'); } },
        { label: t('irishTuneInfo.mapping.useTheSession'), primary: true, onClick: () => { closeModal(); resolve('thesession'); } },
      ], true, '28rem', () => resolve('cancel'));
    });
  };

  /** Fetches+builds cards EXCLUSIVELY via theSessionService (fetchTunesByIds +
   *  tuneResultToCard) — never merged with any IrishTuneInfo data already
   *  fetched for these tunes. Dedupes on `thesession:<id>`, same convention as
   *  buildExistingByTuneId. Does NOT touch the store: callers combine this
   *  with another fetch phase (the remaining IrishTuneInfo import, if any) and
   *  commit everything via commitCards() only once every phase has succeeded
   *  — a failure partway through must never leave only half the batch
   *  imported into the library. */
  const fetchViaTheSession = async (
    sessionIds: number[],
    onProgress: (loaded: number, total: number) => void,
  ): Promise<{ newCards: Card[]; linkIds: string[]; displayCards: { id: string; name: string }[] }> => {
    const existingCardIdBySessionId = new Map<number, string>();
    for (const card of Object.values(appState.value.cards)) {
      if (card.externalId?.startsWith('thesession:')) {
        const id = parseInt(card.externalId.slice('thesession:'.length));
        if (!isNaN(id)) existingCardIdBySessionId.set(id, card.id);
      }
    }
    const { tunes, skippedIds } = await fetchTunesByIdsTheSession(sessionIds, onProgress, id => existingCardIdBySessionId.has(id));
    const newCards = tunes.map(tune => tuneResultToCard(tune));
    const existingIds = skippedIds.map(id => existingCardIdBySessionId.get(id)!);
    return {
      newCards,
      linkIds: [...newCards.map(c => c.id), ...existingIds],
      displayCards: [
        ...newCards.map(c => ({ id: c.id, name: c.name })),
        ...existingIds.map(id => ({ id, name: appState.value.cards[id]?.name ?? '' })),
      ],
    };
  };

  /** Writes a set of newly-built cards plus a set of already-known card ids
   *  into the store and links all of them to the current target deck(s), in
   *  one single mutate() call — the only place either batch path below
   *  actually commits anything, and only once every fetch phase has already
   *  succeeded. */
  const commitCards = (newCards: Card[], linkIds: string[]): Promise<void> => mutate(s => {
    for (const card of newCards) { s.cards[card.id] = card; }
    for (const deckId of (getTargetDeckIds?.() ?? [])) {
      const deck = s.decks[deckId]; if (!deck) continue;
      for (const cardId of linkIds) {
        if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
      }
    }
  });

  /** Combines the batch-import summary segments (imported / redirected to
   *  TheSession / already-in-library skipped) into one sentence — factored
   *  out since both batch paths below build this. */
  const buildBatchSummary = (newCount: number, skippedCount: number, redirectedCount: number): string => {
    let summary = t('irishTuneInfo.status.batchDone', { count: newCount });
    const extras: string[] = [];
    if (redirectedCount > 0) extras.push(t('irishTuneInfo.status.batchRedirected', { count: redirectedCount }));
    if (skippedCount > 0) extras.push(t('irishTuneInfo.status.batchSkipped', { count: skippedCount }));
    if (extras.length > 0) summary = summary.replace('.', '') + extras.join('') + '.';
    return summary;
  };

  /** Shared: import a list of tune IDs (e.g. pasted "1;5;97"), same shape as
   *  the playlist batch import below. */
  const importIds = async (
    ids: number[],
    onProgress: (loaded: number, total: number) => void,
    onDone: () => void,
  ): Promise<void> => {
    status.textContent = t('irishTuneInfo.status.checkingMapping');
    const { mapped, unmapped } = await checkMapping(ids);
    let useRedirect = false;
    if (mapped.length > 0) {
      const choice = await promptUseTheSession(mapped, ids.length);
      if (choice === 'cancel') {
        status.textContent = '';
        onDone();
        return;
      }
      useRedirect = choice === 'thesession';
    }
    const remainingIds = useRedirect ? unmapped : ids;

    // One continuous bar/status across both phases (TheSession redirect
    // fetch, then the remaining IrishTuneInfo fetch) instead of two separate
    // "X/N" progressions that each reset to 0.
    const totalToFetch = (useRedirect ? mapped.length : 0) + remainingIds.length;
    let doneSoFar = 0;
    const onCombinedProgress = (loadedInPhase: number) => onProgress(doneSoFar + loadedInPhase, totalToFetch);

    status.textContent = fetchingMsg();
    try {
      // Every phase is fetched FIRST — nothing is written to the library
      // until every phase below has actually succeeded, so a failure partway
      // through (e.g. the IrishTuneInfo fetch dies right after the TheSession
      // one already finished) never leaves the library with only half the
      // batch imported.
      let sessionFetch: Awaited<ReturnType<typeof fetchViaTheSession>> | null = null;
      if (useRedirect) {
        sessionFetch = await fetchViaTheSession(mapped.map(m => m.sessionId), onCombinedProgress);
        doneSoFar = mapped.length;
      }

      let itiNewCards: Card[] = [];
      let itiSkippedIds: number[] = [];
      let existingCardIdByTuneId: Map<number, string> | null = null;
      if (remainingIds.length > 0) {
        existingCardIdByTuneId = buildExistingByTuneId();
        const { tunes, skippedIds } = await fetchTunesByIds(remainingIds, onCombinedProgress, id => existingCardIdByTuneId!.has(id), includeAudio);
        itiNewCards = tunes.map(({ tune, audioFile }) => tuneToCard(tune, audioFile));
        itiSkippedIds = skippedIds;
      }

      const allNewCards = [...(sessionFetch?.newCards ?? []), ...itiNewCards];
      const linkIds = [
        ...(sessionFetch?.linkIds ?? []),
        ...itiNewCards.map(c => c.id),
        ...itiSkippedIds.map(id => existingCardIdByTuneId!.get(id)!),
      ];
      await commitCards(allNewCards, linkIds);

      const redirectedCount = sessionFetch?.displayCards.length ?? 0;
      status.textContent = buildBatchSummary(itiNewCards.length, itiSkippedIds.length, redirectedCount);
    } catch (e) {
      status.textContent = t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) });
    } finally {
      onDone();
    }
  };

  const renderTabs = () => {
    tabBar.innerHTML = '';
    const tabs: Array<{ id: typeof activeTab; labelKey: string }> = [
      { id: 'tune',     labelKey: 'irishTuneInfo.tabTune' },
      { id: 'playlist', labelKey: 'irishTuneInfo.tabPlaylist' },
    ];
    for (const tab of tabs) {
      tabBar.appendChild(mkTab(t(tab.labelKey), activeTab === tab.id, () => {
        activeTab = tab.id; renderTabs(); renderContent();
      }));
    }
  };

  const renderContent = () => {
    content.innerHTML = '';
    status.textContent = '';
    if (activeTab === 'tune')     renderTuneTab();
    if (activeTab === 'playlist') renderPlaylistTab();
  };

  // ── Tab: Tune (ID, name search, or a pasted "1;5;97" ID list) ─────────────
  const renderTuneTab = () => {
    const { wrap: inputWrap, inp, info: infoSpan } = mkInputRow(t('irishTuneInfo.tune.placeholder'));
    inputWrap.title = t('irishTuneInfo.ids.hint');

    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary text-xs shrink-0';
    importBtn.textContent = t('irishTuneInfo.id.import');
    importBtn.disabled = true;

    const row = document.createElement('div');
    row.className = 'flex gap-2';
    row.append(inputWrap, importBtn);

    // Progress bar — hidden except during a pasted-ID-list batch import.
    const progressWrap = document.createElement('div'); progressWrap.className = 'hidden space-y-1';
    const progressTrack = document.createElement('div'); progressTrack.className = 'knowledge-bar';
    const progressFill = document.createElement('div'); progressFill.className = 'knowledge-fill bg-accent'; progressFill.style.width = '0%';
    progressTrack.appendChild(progressFill); progressWrap.appendChild(progressTrack);

    let pendingId: number | null = null;
    let pendingIds: number[] | null = null;
    const showResult = (name: string, rhythm: string, id: number) => {
      pendingId = id; pendingIds = null;
      infoSpan.textContent = /^\d+$/.test(inp.value.trim()) ? `${name} · ${rhythm}` : rhythm;
      importBtn.disabled = false;
    };
    const showIdList = (ids: number[]) => {
      pendingIds = ids; pendingId = null;
      infoSpan.textContent = ids.length === 1 ? t('irishTuneInfo.ids.preview', { count: ids.length }) : t('irishTuneInfo.ids.previewPlural', { count: ids.length });
      importBtn.disabled = false;
    };
    const clearResult = () => { pendingId = null; pendingIds = null; infoSpan.textContent = ''; importBtn.disabled = true; };

    importBtn.onclick = () => {
      if (pendingIds) {
        const ids = pendingIds;
        withDeckChoice(() => {
          importBtn.disabled = true; inp.disabled = true;
          progressWrap.classList.remove('hidden'); progressFill.style.width = '0%';
          void importIds(ids, (loaded, total) => { progressFill.style.width = `${Math.round((loaded / total) * 100)}%`; status.textContent = t('irishTuneInfo.status.fetchingTunes', { loaded, total }); }, () => {
            importBtn.disabled = false; inp.disabled = false; inp.value = ''; clearResult();
          });
        });
        return;
      }
      if (pendingId === null) return;
      withDeckChoice(() => { void importTune(pendingId!, () => { inp.value = ''; clearResult(); }, importBtn); });
    };

    // Floating dropdown — aligned to input wrapper width
    const dropdown = document.createElement('div');
    dropdown.className = 'fixed z-[100] bg-elevated border border-border rounded-lg shadow-2xl overflow-y-auto hidden';
    dropdown.style.maxHeight = '220px';
    document.body.appendChild(dropdown);
    const positionDropdown = () => {
      const z = getZoom() / 100;
      const rect = inputWrap.getBoundingClientRect();
      dropdown.style.top = `${(rect.bottom + 4) / z}px`; dropdown.style.left = `${rect.left / z}px`; dropdown.style.width = `${rect.width / z}px`;
    };
    const showDropdown = () => { positionDropdown(); dropdown.classList.remove('hidden'); };
    const hideDropdown = () => dropdown.classList.add('hidden');
    const obs = new MutationObserver(() => { if (!inp.isConnected) { dropdown.remove(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });

    const renderSuggestions = (tunes: TuneSearchResult[]) => {
      dropdown.innerHTML = '';
      if (!tunes.length) { hideDropdown(); return; }
      for (const tune of tunes) {
        const item = document.createElement('div');
        item.className = 'flex items-center gap-3 px-3 py-2 hover:bg-bg cursor-pointer';
        const left = document.createElement('div'); left.className = 'flex-1 min-w-0';
        const name = document.createElement('span'); name.className = 'text-sm text-primary truncate block'; name.textContent = tune.name;
        const meta = document.createElement('span'); meta.className = 'text-xs text-dim'; meta.textContent = tune.rhythm;
        left.append(name, meta); item.appendChild(left);
        item.addEventListener('mousedown', e => { e.preventDefault(); inp.value = tune.name; dropdown.innerHTML = ''; hideDropdown(); showResult(tune.name, tune.rhythm, tune.id); status.textContent = ''; });
        dropdown.appendChild(item);
      }
      showDropdown();
    };

    // Pasting a newline-separated list into a single-line input drops the
    // newlines on some browsers — normalize to ';' before it hits 'input'.
    inp.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text');
      if (!text || !/[\r\n]/.test(text)) return;
      e.preventDefault();
      const cleaned = text.replace(/[\r\n]+/g, ';');
      const start = inp.selectionStart ?? inp.value.length;
      const end = inp.selectionEnd ?? inp.value.length;
      inp.value = inp.value.slice(0, start) + cleaned + inp.value.slice(end);
      inp.dispatchEvent(new Event('input'));
    });

    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    inp.addEventListener('input', () => {
      if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
      clearResult(); status.textContent = ''; dropdown.innerHTML = ''; hideDropdown();
      const val = inp.value.trim(); if (!val) return;
      const ids = parseIdList(val);
      if (ids.length > 0) { showIdList(ids); return; }
      if (/^\d+$/.test(val)) {
        inputTimer = setTimeout(async () => {
          inputTimer = null; status.textContent = fetchingMsg();
          try { const tune = await fetchTuneById(parseInt(val)); showResult(tune.name, tune.rhythm, tune.id); status.textContent = ''; }
          catch { status.textContent = t('irishTuneInfo.id.notFound'); }
        }, 150);
      } else if (val.length >= 2) {
        inputTimer = setTimeout(async () => {
          inputTimer = null; status.textContent = searchingMsg();
          try { const tunes = await searchTunes(val); renderSuggestions(sortByRelevance(tunes, val)); status.textContent = tunes.length ? '' : t('irishTuneInfo.noResults'); }
          catch (e) { status.textContent = t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) }); }
        }, 300);
      }
    });
    inp.addEventListener('blur',  () => { setTimeout(hideDropdown, 150); });
    inp.addEventListener('focus', () => { if (dropdown.children.length) showDropdown(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(); if (e.key === 'Enter' && (pendingId !== null || pendingIds !== null)) importBtn.click(); });

    content.append(row, progressWrap);
    focusIfDesktop(inp);
  };

  // ── Tab: Playlist (username → import all) ────────────────────────────────
  const renderPlaylistTab = () => {
    const { wrap: inputWrap, inp, info: infoSpan } = mkInputRow(t('irishTuneInfo.playlist.placeholder'));

    const importAllBtn = document.createElement('button');
    importAllBtn.className = 'btn-primary text-xs shrink-0';
    importAllBtn.textContent = t('irishTuneInfo.playlist.importAll');
    importAllBtn.disabled = true;

    const row = document.createElement('div');
    row.className = 'flex gap-2';
    row.append(inputWrap, importAllBtn);

    // Progress bar
    const progressWrap = document.createElement('div'); progressWrap.className = 'hidden space-y-1';
    const progressTrack = document.createElement('div'); progressTrack.className = 'knowledge-bar';
    const progressFill = document.createElement('div'); progressFill.className = 'knowledge-fill bg-accent'; progressFill.style.width = '0%';
    progressTrack.appendChild(progressFill); progressWrap.appendChild(progressTrack);

    let pendingUsername: string | null = null;
    // Populated by showPreview, which already has every tune's ID for free
    // (fetchPlaylist returns {id,name} per tune) — checked against the
    // TheSession mapping right there so doImportAll never needs a second
    // username→ids round trip just to know what it's about to fetch.
    let pendingMapped: { itiId: number; sessionId: number; name: string }[] = [];
    let pendingUnmappedIds: number[] = [];

    const showPreview = async (username: string) => {
      pendingUsername = null; pendingMapped = []; pendingUnmappedIds = [];
      importAllBtn.disabled = true; infoSpan.textContent = '';
      status.textContent = fetchingMsg();
      try {
        const playlist = await fetchPlaylist(username);
        const n = playlist.tunes.length;
        infoSpan.textContent = n === 1 ? t('irishTuneInfo.playlist.preview', { count: n }) : t('irishTuneInfo.playlist.previewPlural', { count: n });
        // Checked here (not just shown) so doImportAll never needs a second
        // username→ids round trip — the TheSession-redirect prompt itself
        // only appears once the user actually clicks Import, not here.
        const { mapped, unmapped } = await checkMapping(playlist.tunes.map(pt => pt.id));
        pendingMapped = mapped; pendingUnmappedIds = unmapped;
        pendingUsername = username;
        importAllBtn.disabled = n === 0;
        status.textContent = '';
      } catch {
        status.innerHTML = `${t('irishTuneInfo.playlist.notFound')}<br><span class="text-warn">${t('irishTuneInfo.playlist.makePublicHint')}</span>`;
      }
    };

    const doImportAll = async () => {
      if (pendingUsername === null) return;
      importAllBtn.disabled = true; inp.disabled = true;
      progressWrap.classList.remove('hidden'); progressFill.style.width = '0%';

      let useRedirect = false;
      if (pendingMapped.length > 0) {
        const choice = await promptUseTheSession(pendingMapped, pendingMapped.length + pendingUnmappedIds.length);
        if (choice === 'cancel') {
          status.textContent = '';
          progressWrap.classList.add('hidden');
          importAllBtn.disabled = false; inp.disabled = false;
          return;
        }
        useRedirect = choice === 'thesession';
      }
      const ids = useRedirect ? pendingUnmappedIds : [...pendingMapped.map(m => m.itiId), ...pendingUnmappedIds];

      // One continuous bar/status across both phases (TheSession redirect
      // fetch, then the remaining IrishTuneInfo fetch) instead of two
      // separate "X/N" progressions that each reset to 0.
      const totalToFetch = (useRedirect ? pendingMapped.length : 0) + ids.length;
      let doneSoFar = 0;
      const onCombinedProgress = (loadedInPhase: number) => {
        const done = doneSoFar + loadedInPhase;
        progressFill.style.width = `${Math.round((done / totalToFetch) * 100)}%`;
        status.textContent = t('irishTuneInfo.status.fetchingTunes', { loaded: done, total: totalToFetch });
      };

      status.textContent = fetchingMsg();
      try {
        // Every phase is fetched FIRST — nothing is written to the library
        // until every phase below has actually succeeded, so a failure
        // partway through (e.g. the IrishTuneInfo fetch dies right after the
        // TheSession one already finished) never leaves the library with
        // only half the batch imported.
        let sessionFetch: Awaited<ReturnType<typeof fetchViaTheSession>> | null = null;
        if (useRedirect) {
          sessionFetch = await fetchViaTheSession(pendingMapped.map(m => m.sessionId), onCombinedProgress);
          doneSoFar = pendingMapped.length;
        }

        let itiNewCards: Card[] = [];
        let itiSkippedIds: number[] = [];
        let existingCardIdByTuneId: Map<number, string> | null = null;
        if (ids.length > 0) {
          existingCardIdByTuneId = buildExistingByTuneId();
          const { tunes, skippedIds } = await fetchTunesByIds(ids, onCombinedProgress, id => existingCardIdByTuneId!.has(id), includeAudio);
          itiNewCards = tunes.map(({ tune, audioFile }) => tuneToCard(tune, audioFile));
          itiSkippedIds = skippedIds;
        }

        const allNewCards = [...(sessionFetch?.newCards ?? []), ...itiNewCards];
        const linkIds = [
          ...(sessionFetch?.linkIds ?? []),
          ...itiNewCards.map(c => c.id),
          ...itiSkippedIds.map(id => existingCardIdByTuneId!.get(id)!),
        ];
        await commitCards(allNewCards, linkIds);

        progressFill.style.width = '100%';
        const redirectedCount = sessionFetch?.displayCards.length ?? 0;
        status.textContent = buildBatchSummary(itiNewCards.length, itiSkippedIds.length, redirectedCount);
      } catch (e) {
        status.textContent = t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { importAllBtn.disabled = false; inp.disabled = false; }
    };
    importAllBtn.onclick = () => withDeckChoice(() => { void doImportAll(); });

    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    inp.addEventListener('input', () => {
      if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
      infoSpan.textContent = ''; importAllBtn.disabled = true; pendingUsername = null; status.textContent = '';
      const val = inp.value.trim(); if (!val) return;
      inputTimer = setTimeout(() => { inputTimer = null; void showPreview(val); }, 400);
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && pendingUsername !== null) importAllBtn.click(); });

    content.append(row, progressWrap);
    focusIfDesktop(inp);
  };

  renderTabs();
  renderContent();
  wrap.append(tabBar, content);
  return wrap;
}
