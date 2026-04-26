import type { AppContext } from '../types';
import { generateId, focusIfDesktop } from '../utils';
import { parseCardPackage } from '../services/importExport';
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

export function buildTheSessionBody(ctx: AppContext, status: HTMLElement, getTargetDeckIds?: () => Set<string>): HTMLElement {
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
          status.textContent = t('theSession.status.alreadyInLibrary', { name: tune.name });
        } else {
          const card = tuneResultToCard(tune, { onlyFirstSetting });
          await ctx.mutate(s => {
            s.cards[card.id] = card;
            for (const deckId of (getTargetDeckIds?.() ?? [])) {
              const deck = s.decks[deckId];
              if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
            }
          });
          status.textContent = t('theSession.status.imported', { name: card.name });
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
    let selectedTune: TuneSearchResult | null = null;

    const outerWrap = document.createElement('div');
    const row = document.createElement('div'); row.className = 'flex gap-2';
    const { wrap: inputWrap, inp, setPreview } = mkPreviewInput(t('theSession.search') + '…');
    inp.type = 'text';
    const btn = document.createElement('button'); btn.className = 'btn-primary shrink-0'; btn.textContent = t('theSession.id.import'); btn.disabled = true;
    row.append(inputWrap, btn);
    outerWrap.append(row);

    const dropdown = document.createElement('div');
    dropdown.className = 'fixed z-[100] bg-elevated border border-border rounded-lg shadow-2xl overflow-y-auto hidden';
    dropdown.style.maxHeight = '220px';
    document.body.appendChild(dropdown);

    const positionDropdown = () => {
      const rect = inputWrap.getBoundingClientRect();
      dropdown.style.top   = `${rect.bottom + 4}px`;
      dropdown.style.left  = `${rect.left}px`;
      dropdown.style.width = `${rect.width}px`;
    };
    const showDropdown = () => { positionDropdown(); dropdown.classList.remove('hidden'); };
    const hideDropdown = () => dropdown.classList.add('hidden');

    const obs = new MutationObserver(() => { if (!inp.isConnected) { dropdown.remove(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });

    const selectTune = (tune: TuneSearchResult) => {
      selectedTune = tune;
      inp.value = tune.name;
      setPreview(`${tune.id} · ${tune.type}`);
      btn.disabled = false;
      dropdown.innerHTML = ''; hideDropdown();
    };

    const renderSuggestions = (tunes: TuneSearchResult[]) => {
      dropdown.innerHTML = '';
      if (!tunes.length) { hideDropdown(); return; }
      for (const tune of tunes) {
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between gap-3 px-3 py-2 hover:bg-bg cursor-pointer';
        const left = document.createElement('div'); left.className = 'flex-1 min-w-0';
        const name = document.createElement('span'); name.className = 'text-sm text-primary truncate block'; name.textContent = tune.name;
        const meta = document.createElement('span'); meta.className = 'text-xs text-dim'; meta.textContent = tune.type;
        left.append(name, meta);
        item.appendChild(left);
        item.addEventListener('mousedown', e => { e.preventDefault(); selectTune(tune); });
        dropdown.appendChild(item);
      }
      showDropdown();
    };

    const doSearch = debounce(async (q: string) => {
      if (!q.trim()) { dropdown.innerHTML = ''; hideDropdown(); return; }
      status.textContent = t('theSession.status.searching');
      try {
        const tunes = await searchTunes(q);
        renderSuggestions(tunes);
        status.textContent = tunes.length ? '' : t('theSession.noResults');
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      }
    }, 300);

    inp.addEventListener('input', () => { selectedTune = null; btn.disabled = true; setPreview(''); doSearch(inp.value); });
    inp.addEventListener('blur',  () => { setTimeout(hideDropdown, 150); });
    inp.addEventListener('focus', () => { if (dropdown.children.length) showDropdown(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(); if (e.key === 'Enter' && selectedTune) btn.click(); });

    btn.onclick = async () => {
      if (!selectedTune) return;
      const tune = selectedTune;
      btn.disabled = true; status.textContent = t('theSession.status.fetching');
      try {
        const fullTune = await fetchTuneById(tune.id);
        const existing = findByExternalId(`thesession:${fullTune.id}`, ctx.state.cards);
        if (existing) {
          status.textContent = t('theSession.status.alreadyInLibrary', { name: fullTune.name });
          btn.disabled = false;
        } else {
          const card = tuneResultToCard(fullTune, { onlyFirstSetting });
          await ctx.mutate(s => {
            s.cards[card.id] = card;
            for (const deckId of (getTargetDeckIds?.() ?? [])) {
              const deck = s.decks[deckId];
              if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
            }
          });
          status.textContent = t('theSession.status.imported', { name: card.name });
          inp.value = ''; setPreview(''); selectedTune = null;
        }
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
        btn.disabled = false;
      }
    };

    content.append(outerWrap);
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
          for (const card of newCards) { s.cards[card.id] = card; }
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (!deck) continue;
            for (const card of newCards) {
              if (!deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
            }
          }
        });
        progressFill.style.width = '100%';
        const linked = 0;
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

// ── New Card modal (hierarchical flow) ───────────────────────────────────────

export function showNewCardModal(ctx: AppContext): void {
  type Step = 'root' | 'create' | 'import' | 'thesession' | 'json';
  let currentStep: Step = 'root';

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col';
  dialog.style.cssText = 'max-width:440px; max-height:85vh;';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-4 border-b border-border shrink-0';
  const headerLeft = document.createElement('div');
  headerLeft.className = 'flex items-center gap-2 min-w-0';
  const backBtn = document.createElement('button');
  backBtn.className = 'text-dim hover:text-primary transition-colors cursor-pointer shrink-0 hidden';
  backBtn.textContent = '←';
  const titleEl = document.createElement('h2');
  titleEl.className = 'text-sm font-semibold text-primary truncate';
  headerLeft.append(backBtn, titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0';
  closeBtn.textContent = '✕';
  const selectedDeckIds = new Set<string>();
  const deckIconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
  const linkIconSvg  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
  const deckBtn = document.createElement('button');
  const updateDeckBtn = () => {
    const n = selectedDeckIds.size;
    deckBtn.innerHTML = `${linkIconSvg}${deckIconSvg}${n > 0 ? ` (${n})` : ''}`;
    deckBtn.className = `inline-flex items-center gap-1 text-xs transition-colors cursor-pointer shrink-0 ${n > 0 ? 'text-accent' : 'text-dim hover:text-primary'}`;
    deckBtn.title = t('newCard.selectDecks');
  };
  updateDeckBtn();
  const headerRight = document.createElement('div');
  headerRight.className = 'flex items-center gap-3 shrink-0';
  headerRight.append(deckBtn, closeBtn);
  header.append(headerLeft, headerRight);

  const body = document.createElement('div');
  body.className = 'px-5 py-4 flex flex-col gap-3 overflow-y-auto';

  dialog.append(header, body);
  overlay.appendChild(dialog);

  const TITLES: Record<Step, string> = {
    root:       t('newCard.title'),
    create:     t('newCard.tabCreate'),
    import:     t('newCard.tabImport'),
    thesession: t('newCard.tabTheSession'),
    json:       t('newCard.tabImportJson'),
  };

  let deckSelectorOpen = false;
  const showDeckSelector = () => {
    deckSelectorOpen = true;
    const selOverlay = document.createElement('div');
    selOverlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60';
    const selDialog = document.createElement('div');
    selDialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 flex flex-col overflow-hidden';
    selDialog.style.cssText = 'max-width:360px; max-height:65vh;';
    const selHeader = document.createElement('div');
    selHeader.className = 'flex items-center justify-between px-4 py-3 border-b border-border shrink-0';
    const selTitle = document.createElement('span'); selTitle.className = 'text-sm font-semibold text-primary'; selTitle.textContent = t('newCard.selectDecks');
    const selClose = document.createElement('button'); selClose.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer'; selClose.textContent = '✕';
    selHeader.append(selTitle, selClose);
    const selBody = document.createElement('div'); selBody.className = 'overflow-y-auto flex-1 py-2';
    const decks = Object.values(ctx.state.decks).sort((a, b) => a.name.localeCompare(b.name));
    if (decks.length === 0) {
      const empty = document.createElement('p'); empty.className = 'text-xs text-muted px-4 py-3'; empty.textContent = t('newCard.noDecks'); selBody.appendChild(empty);
    } else {
      for (const deck of decks) {
        const row = document.createElement('label'); row.className = 'flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-bg transition-colors';
        const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = selectedDeckIds.has(deck.id); chk.className = 'card-checkbox shrink-0';
        chk.onchange = () => { if (chk.checked) selectedDeckIds.add(deck.id); else selectedDeckIds.delete(deck.id); updateDeckBtn(); };
        const nameEl = document.createElement('span'); nameEl.className = 'text-sm text-primary truncate'; nameEl.textContent = deck.name;
        row.append(chk, nameEl); selBody.appendChild(row);
      }
    }
    const closeSelector = () => { deckSelectorOpen = false; document.removeEventListener('keydown', selOnKey); selOverlay.remove(); };
    const selOnKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSelector(); };
    document.addEventListener('keydown', selOnKey);
    selClose.onclick = closeSelector;
    selOverlay.addEventListener('mousedown', e => { if (e.target === selOverlay) closeSelector(); });
    selDialog.append(selHeader, selBody);
    selOverlay.appendChild(selDialog);
    document.body.appendChild(selOverlay);
  };
  deckBtn.onclick = showDeckSelector;

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  closeBtn.onclick = close;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !deckSelectorOpen) close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

  const mkChoiceCard = (icon: string, label: string, desc: string, accentColor: string, onClick: () => void): HTMLElement => {
    const btn = document.createElement('button');
    btn.className = 'flex items-center gap-3.5 w-full px-4 py-3.5 rounded-xl border border-border bg-bg text-left cursor-pointer';
    btn.style.cssText = 'transition: border-color 0.15s, background 0.15s;';
    const iconWrap = document.createElement('span');
    iconWrap.style.color = accentColor;
    iconWrap.className = 'shrink-0 flex items-center';
    iconWrap.innerHTML = icon;
    const textWrap = document.createElement('div'); textWrap.className = 'flex-1';
    const labelEl = document.createElement('div'); labelEl.className = 'text-sm font-medium text-primary'; labelEl.textContent = label;
    const descEl  = document.createElement('div'); descEl.className = 'text-xs text-dim mt-0.5'; descEl.textContent = desc;
    textWrap.append(labelEl, descEl);
    const arrow = document.createElement('span'); arrow.className = 'text-dim text-base leading-none shrink-0'; arrow.textContent = '›';
    btn.append(iconWrap, textWrap, arrow);
    btn.addEventListener('mouseenter', () => { btn.style.borderColor = accentColor; btn.style.background = `${accentColor}12`; });
    btn.addEventListener('mouseleave', () => { btn.style.borderColor = ''; btn.style.background = ''; });
    btn.onclick = onClick;
    return btn;
  };

  const navigate = (step: Step) => {
    currentStep = step;
    titleEl.textContent = TITLES[step];
    if (step === 'root') {
      backBtn.classList.add('hidden');
      backBtn.onclick = null;
    } else {
      const backParent: Step = (step === 'thesession' || step === 'json') ? 'import' : 'root';
      backBtn.classList.remove('hidden');
      backBtn.onclick = () => navigate(backParent);
    }
    renderBody();
  };

  const renderBody = () => {
    body.innerHTML = '';

    if (currentStep === 'root')            renderRoot();
    else if (currentStep === 'create')     renderCreate();
    else if (currentStep === 'import')     renderImport();
    else if (currentStep === 'thesession') renderTheSession();
    else if (currentStep === 'json')       renderJson();
  };

  const renderRoot = () => {
    const iconCreate = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const iconImport = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    body.appendChild(mkChoiceCard(iconCreate, t('newCard.tabCreate'), t('newCard.createDesc'), '#8b7cf8', () => navigate('create')));
    body.appendChild(mkChoiceCard(iconImport, t('newCard.tabImport'), t('newCard.importDesc'), '#fbbf24', () => navigate('import')));
  };

  const renderCreate = () => {
    const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = t('newCard.nameLabel');
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input'; inp.placeholder = t('newCard.namePlaceholder');
    const createBtn = document.createElement('button'); createBtn.className = 'btn-primary w-full mt-1'; createBtn.textContent = t('newCard.createBtn');
    const doCreate = async () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      await ctx.mutate(s => {
        const id = generateId();
        s.cards[id] = { id, name, importance: 1, tags: [], content: { notes: '', attachments: [] } };
        for (const deckId of selectedDeckIds) {
          const deck = s.decks[deckId];
          if (deck && !deck.entries.some(e => e.cardId === id)) deck.entries.push({ cardId: id });
        }
      });
      close();
    };
    createBtn.onclick = () => { void doCreate(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') void doCreate(); });
    body.append(lbl, inp, createBtn);
    inp.focus();
  };

  const renderImport = () => {
    const iconTs   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    const iconJson = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    body.appendChild(mkChoiceCard(iconTs,   t('newCard.tabTheSession'), t('newCard.theSessionDesc'), '#4ade80', () => navigate('thesession')));
    body.appendChild(mkChoiceCard(iconJson, t('newCard.tabImportJson'), t('newCard.importJsonDesc'), '#fbbf24', () => navigate('json')));
  };

  const renderTheSession = () => {
    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';
    body.append(buildTheSessionBody(ctx, status, () => selectedDeckIds), status);
  };

  const renderJson = () => {
    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'btn-primary w-full text-sm'; pickBtn.textContent = t('newCard.import.pick');
    pickBtn.onclick = () => {
      const fileInp = document.createElement('input'); fileInp.type = 'file'; fileInp.accept = '.json,application/json';
      fileInp.onchange = async () => {
        const file = fileInp.files?.[0]; if (!file) return;
        pickBtn.disabled = true; status.textContent = t('newCard.import.importing');
        try {
          const cards = await parseCardPackage(file);
          let imported = 0;
          const newCards: typeof cards = [];
          await ctx.mutate(s => {
            for (const card of cards) { if (!s.cards[card.id]) { s.cards[card.id] = card; newCards.push(card); imported++; } }
            for (const deckId of selectedDeckIds) {
              const deck = s.decks[deckId];
              if (!deck) continue;
              for (const card of newCards) {
                if (!deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
              }
            }
          });
          status.textContent = t('newCard.import.done', { count: imported });
        } catch (e) {
          status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
        } finally { pickBtn.disabled = false; }
      };
      fileInp.click();
    };
    body.append(pickBtn, status);
  };

  document.body.appendChild(overlay);
  navigate('root');
}
