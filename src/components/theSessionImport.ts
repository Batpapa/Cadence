import type { AppContext, AppState } from '../types';
import { generateId, focusIfDesktop } from '../utils';
import { showModal, closeModal } from './modal';
import {
  searchTunes, fetchTuneById, fetchMemberTunes, fetchMemberInfo,
  tuneResultToCard, findByExternalId,
  type TuneSearchResult,
} from '../services/theSessionService';
import { t } from '../services/i18nService';

// ── Debounce ─────────────────────────────────────────────────────────────────

function debounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: Parameters<T>) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }) as T;
}

// ── Tab helpers ───────────────────────────────────────────────────────────────

function mkTab(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.className = `px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
    active ? 'bg-accent text-white' : 'text-muted hover:text-primary hover:bg-elevated'
  }`;
  btn.onclick = onClick;
  return btn;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function linkCardToDeck(s: AppState, cardId: string, deckId: string): void {
  if (s.decks[deckId] && !s.decks[deckId]!.entries.some(e => e.cardId === cardId)) {
    s.decks[deckId]!.entries.push({ cardId });
  }
}

// ── TheSession body builder ───────────────────────────────────────────────────

function mkPreviewInput(placeholder: string) {
  const wrap = document.createElement('div');
  wrap.className = 'flex-1 min-w-0 flex items-center gap-2 bg-bg border border-border rounded px-3 py-2 transition-colors focus-within:border-accent';
  const inp = document.createElement('input');
  inp.type = 'number'; inp.placeholder = placeholder;
  inp.className = 'flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-primary placeholder-dim';
  const previewEl = document.createElement('span');
  previewEl.className = 'hidden text-xs shrink-0 truncate max-w-[75%]';
  wrap.append(inp, previewEl);
  const setPreview = (text: string, isError = false) => {
    if (!text) { previewEl.textContent = ''; previewEl.className = 'hidden text-xs shrink-0 truncate max-w-[75%]'; return; }
    previewEl.textContent = text;
    previewEl.className = `text-xs shrink-0 truncate max-w-[75%] ${isError ? 'text-red-400' : 'text-muted'}`;
  };
  return { wrap, inp, setPreview };
}

export function buildTheSessionBody(ctx: AppContext, status: HTMLElement, deckId?: string): HTMLElement {
  let activeTab: 'id' | 'search' | 'member' = 'search';
  let onlyFirstSetting = true;

  const wrap = document.createElement('div');
  wrap.className = 'space-y-3';

  // ── Option: only most popular setting ─────────────────────────────────────
  const optRow = document.createElement('label');
  optRow.className = 'flex items-center gap-2 cursor-pointer select-none';
  const optChk = document.createElement('input'); optChk.type = 'checkbox'; optChk.className = 'card-checkbox'; optChk.checked = true;
  optChk.onchange = () => { onlyFirstSetting = optChk.checked; };
  const optLbl = document.createElement('span'); optLbl.className = 'text-xs text-muted'; optLbl.textContent = t('theSession.onlyFirstSetting');
  optRow.append(optChk, optLbl);
  wrap.appendChild(optRow);

  const tabBar = document.createElement('div');
  tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg';

  const content = document.createElement('div');
  content.className = 'space-y-3';

  const renderTabs = () => {
    tabBar.innerHTML = '';
    const tabs: Array<{ id: typeof activeTab; labelKey: string }> = [
      { id: 'search', labelKey: 'theSession.search' },
      { id: 'id',     labelKey: 'theSession.byId' },
      { id: 'member', labelKey: 'theSession.byMember' },
    ];
    for (const tab of tabs) {
      tabBar.appendChild(mkTab(t(tab.labelKey), activeTab === tab.id, () => {
        activeTab = tab.id;
        renderTabs();
        renderContent();
      }));
    }
  };

  const renderContent = () => {
    content.innerHTML = '';
    status.textContent = '';
    if (activeTab === 'id')     renderByIdTab();
    if (activeTab === 'search') renderSearchTab();
    if (activeTab === 'member') renderMemberTab();
  };

  // ── Tab: By ID ────────────────────────────────────────────────────────────

  const renderByIdTab = () => {
    const row = document.createElement('div'); row.className = 'flex gap-2';
    const { wrap: inputWrap, inp, setPreview } = mkPreviewInput(t('theSession.id.placeholder'));
    const btn = document.createElement('button'); btn.className = 'btn-primary shrink-0'; btn.textContent = t('theSession.id.import');

    let previewId = -1;
    const doPreview = debounce(async (val: string) => {
      const id = parseInt(val);
      if (isNaN(id)) { setPreview(''); return; }
      previewId = id;
      try {
        const tune = await fetchTuneById(id);
        if (previewId === id) setPreview(`${tune.name} · ${tune.type}`);
      } catch { if (previewId === id) setPreview(t('theSession.id.notFound'), true); }
    }, 400);

    btn.onclick = async () => {
      const id = parseInt(inp.value);
      if (isNaN(id)) return;
      btn.disabled = true; status.textContent = t('theSession.status.fetching');
      try {
        const tune = await fetchTuneById(id);
        const existing = findByExternalId(`thesession:${tune.id}`, ctx.state.cards);
        if (existing) {
          if (deckId) await ctx.mutate(s => { linkCardToDeck(s, existing.id, deckId!); });
          status.textContent = deckId
            ? t('theSession.status.alreadyInLibraryLinked', { name: tune.name })
            : t('theSession.status.alreadyInLibrary', { name: tune.name });
          inp.value = ''; setPreview('');
        } else {
          const card = tuneResultToCard(tune, { onlyFirstSetting });
          await ctx.mutate(s => { s.cards[card.id] = card; if (deckId) linkCardToDeck(s, card.id, deckId); });
          status.textContent = t('theSession.status.imported', { name: card.name });
          inp.value = ''; setPreview('');
        }
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { btn.disabled = false; }
    };
    inp.addEventListener('input', () => doPreview(inp.value));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    row.append(inputWrap, btn);
    content.append(row);
    focusIfDesktop(inp);
  };

  // ── Tab: Search ───────────────────────────────────────────────────────────

  const renderSearchTab = () => {
    const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = t('theSession.search') + '…'; inp.className = 'input';
    const suggestions = document.createElement('div'); suggestions.className = 'space-y-1 max-h-48 overflow-y-auto';

    const renderSuggestions = (tunes: TuneSearchResult[]) => {
      suggestions.innerHTML = '';
      for (const tune of tunes) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-3 px-3 py-2 rounded hover:bg-elevated cursor-pointer group';
        const left = document.createElement('div'); left.className = 'flex-1 min-w-0';
        const name = document.createElement('span'); name.className = 'text-sm text-primary truncate block'; name.textContent = tune.name;
        const meta = document.createElement('span'); meta.className = 'text-xs text-dim'; meta.textContent = tune.type;
        left.append(name, meta);
        const importBtn = document.createElement('button');
        importBtn.className = 'btn-primary text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity';
        importBtn.textContent = t('theSession.id.import');
        importBtn.onclick = async () => {
          importBtn.disabled = true; status.textContent = t('theSession.status.importing');
          try {
            const fullTune = await fetchTuneById(tune.id);
            const existing = findByExternalId(`thesession:${fullTune.id}`, ctx.state.cards);
            if (existing) {
              if (deckId) await ctx.mutate(s => { linkCardToDeck(s, existing.id, deckId!); });
              status.textContent = deckId
                ? t('theSession.status.alreadyInLibraryLinked', { name: fullTune.name })
                : t('theSession.status.alreadyInLibrary', { name: fullTune.name });
            } else {
              const card = tuneResultToCard(fullTune, { onlyFirstSetting });
              await ctx.mutate(s => { s.cards[card.id] = card; if (deckId) linkCardToDeck(s, card.id, deckId); });
              status.textContent = t('theSession.status.imported', { name: card.name });
            }
          } catch (e) {
            status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
          } finally { importBtn.disabled = false; }
        };
        row.append(left, importBtn);
        suggestions.appendChild(row);
      }
    };

    const doSearch = debounce(async (q: string) => {
      if (!q.trim()) { suggestions.innerHTML = ''; return; }
      status.textContent = t('theSession.status.searching');
      try {
        const tunes = await searchTunes(q);
        renderSuggestions(tunes);
        status.textContent = tunes.length ? '' : t('theSession.noResults');
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      }
    }, 300);

    inp.addEventListener('input', () => doSearch(inp.value));
    content.append(inp, suggestions);
    focusIfDesktop(inp);
  };

  // ── Tab: By member ────────────────────────────────────────────────────────

  const renderMemberTab = () => {
    const row = document.createElement('div'); row.className = 'flex gap-2';
    const { wrap: inputWrap, inp, setPreview } = mkPreviewInput(t('theSession.member.placeholder'));
    const btn = document.createElement('button'); btn.className = 'btn-primary shrink-0'; btn.textContent = t('theSession.member.importAll');

    let previewId = -1;
    const doPreview = debounce(async (val: string) => {
      const id = parseInt(val);
      if (isNaN(id)) { setPreview(''); return; }
      previewId = id;
      try {
        const info = await fetchMemberInfo(id);
        if (previewId === id) setPreview(t(info.total !== 1 ? 'theSession.member.previewPlural' : 'theSession.member.preview', { name: info.name, count: info.total }));
      } catch { if (previewId === id) setPreview(t('theSession.member.notFound'), true); }
    }, 400);

    inp.addEventListener('input', () => doPreview(inp.value));

    const progressWrap = document.createElement('div'); progressWrap.className = 'hidden space-y-1';
    const progressTrack = document.createElement('div'); progressTrack.className = 'knowledge-bar';
    const progressFill = document.createElement('div'); progressFill.className = 'knowledge-fill bg-accent'; progressFill.style.width = '0%';
    progressTrack.appendChild(progressFill);
    progressWrap.appendChild(progressTrack);

    btn.onclick = async () => {
      const memberId = parseInt(inp.value);
      if (isNaN(memberId)) return;
      btn.disabled = true; inp.disabled = true;
      progressWrap.classList.remove('hidden');
      progressFill.style.width = '0%';
      status.textContent = t('theSession.status.fetchingPage');
      try {
        const tunes = await fetchMemberTunes(memberId, (loaded, total, phase) => {
          progressFill.style.width = `${Math.round((loaded / total) * 100)}%`;
          status.textContent = phase === 'pages'
            ? t('theSession.status.collectingIds', { loaded, total })
            : t('theSession.status.fetchingTunes', { loaded, total });
        });
        const existingCards = tunes.map(t => findByExternalId(`thesession:${t.id}`, ctx.state.cards));
        const newTunes = tunes.filter((_, i) => !existingCards[i]);
        const alreadyExisting = tunes.filter((_, i) => !!existingCards[i]);
        const newCards = newTunes.map(tune => tuneResultToCard(tune, { onlyFirstSetting }));
        await ctx.mutate(s => {
          for (const card of newCards) { s.cards[card.id] = card; if (deckId) linkCardToDeck(s, card.id, deckId); }
          if (deckId) { for (const tune of alreadyExisting) { const c = findByExternalId(`thesession:${tune.id}`, s.cards); if (c) linkCardToDeck(s, c.id, deckId); } }
        });
        progressFill.style.width = '100%';
        const linked = deckId ? alreadyExisting.length : 0;
        let summary = t('theSession.status.batchDone', { count: newCards.length });
        if (linked > 0) summary = summary.replace('.', '') + t('theSession.status.batchLinked', { linked }) + '.';
        else if (alreadyExisting.length > 0) summary = summary.replace('.', '') + t('theSession.status.batchSkipped', { count: alreadyExisting.length }) + '.';
        status.textContent = summary;
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      } finally {
        btn.disabled = false; inp.disabled = false;
      }
    };

    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    row.append(inputWrap, btn);
    content.append(row, progressWrap);
    focusIfDesktop(inp);
  };

  renderTabs();
  renderContent();
  wrap.append(tabBar, content);
  return wrap;
}

// ── New Card modal (Create + TheSession tabs) ─────────────────────────────────

export function showNewCardModal(ctx: AppContext, deckId?: string): void {
  type ActiveTab = 'create' | 'thesession';
  let activeTab: ActiveTab = 'create';

  const body = document.createElement('div');
  body.className = 'space-y-4';

  const outerTabBar = document.createElement('div');
  outerTabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg';

  const outerContent = document.createElement('div');
  outerContent.className = 'space-y-3';

  const status = document.createElement('p');
  status.className = 'text-xs text-muted min-h-[1.25rem]';

  const renderTabs = () => {
    outerTabBar.innerHTML = '';
    const tabs: Array<{ id: ActiveTab; labelKey: string }> = [
      { id: 'create',     labelKey: 'newCard.tabCreate' },
      { id: 'thesession', labelKey: 'newCard.tabTheSession' },
    ];
    for (const tab of tabs) {
      outerTabBar.appendChild(mkTab(t(tab.labelKey), activeTab === tab.id, () => {
        activeTab = tab.id;
        renderTabs();
        renderContent();
      }));
    }
  };

  const renderContent = () => {
    outerContent.innerHTML = '';
    status.textContent = '';

    if (activeTab === 'create') {
      const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = t('newCard.nameLabel');
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input'; inp.placeholder = t('newCard.namePlaceholder');
      const createBtn = document.createElement('button'); createBtn.className = 'btn-primary w-full mt-1'; createBtn.textContent = t('newCard.createBtn');
      const doCreate = async () => {
        const name = inp.value.trim();
        if (!name) { inp.focus(); return; }
        await ctx.mutate(s => {
          const id = generateId();
          s.cards[id] = { id, name, importance: 1, tags: [], content: { notes: '', attachments: [] } };
          if (deckId) s.decks[deckId]!.entries.push({ cardId: id });
        });
        closeModal();
      };
      createBtn.onclick = () => { void doCreate(); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { void doCreate(); } });
      outerContent.append(lbl, inp, createBtn);
      focusIfDesktop(inp);
    } else {
      outerContent.appendChild(buildTheSessionBody(ctx, status, deckId));
    }
  };

  renderTabs();
  renderContent();
  body.append(outerTabBar, outerContent, status);

  showModal(t('newCard.title'), body, [{ label: t('common.close'), onClick: closeModal }]);
}
