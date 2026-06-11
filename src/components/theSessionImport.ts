import type { AppContext } from '../types';
import { generateId, focusIfDesktop, sortByRelevance } from '../utils';
import { parseCardPackage } from '../services/importExport';
import { mutate } from '../store';
import {
  searchTunes, fetchTuneById, fetchMemberTunes, fetchMemberInfo, searchMembers,
  tuneResultToCard, findByExternalId,
  type TuneSearchResult, type MemberSearchResult,
} from '../services/theSessionService';
import { t } from '../services/i18nService';
import { modalMaxH, modalMaxW, getZoom } from '../services/zoomService';

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

// ── Input wrapper that looks like .input but has an inline right-side info span ──

function mkInputRow(placeholder: string): { wrap: HTMLDivElement; inp: HTMLInputElement; info: HTMLSpanElement } {
  const wrap = document.createElement('div');
  wrap.className = 'flex-1 relative flex items-center bg-bg border border-border rounded px-3 py-2 transition-colors focus-within:border-accent overflow-hidden';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'flex-1 min-w-0 bg-transparent outline-none text-sm text-primary placeholder:text-dim';
  inp.placeholder = placeholder;

  const info = document.createElement('span');
  // absolute + bg-bg so it overlays input text without affecting wrapper size
  info.className = 'absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dim bg-bg pl-2 pointer-events-none whitespace-nowrap';

  wrap.append(inp, info);
  return { wrap, inp, info };
}

// ── TheSession body builder ───────────────────────────────────────────────────

export function buildTheSessionBody(ctx: AppContext, status: HTMLElement, getTargetDeckIds?: () => Set<string>): HTMLElement {
  let activeTab: 'tune' | 'member' = 'tune';
  let mergeSettings = true;

  const wrap = document.createElement('div');
  wrap.className = 'space-y-3';

  // ── Options ───────────────────────────────────────────────────────────────
  const mergeRow = document.createElement('label');
  mergeRow.className = 'flex items-center gap-2 cursor-pointer select-none';
  const mergeChk = document.createElement('input'); mergeChk.type = 'checkbox'; mergeChk.className = 'card-checkbox'; mergeChk.checked = true;
  const mergeLbl = document.createElement('span'); mergeLbl.className = 'text-xs text-muted'; mergeLbl.textContent = t('theSession.mergeSettings');
  mergeChk.onchange = () => { mergeSettings = mergeChk.checked; };
  mergeRow.append(mergeChk, mergeLbl);
  wrap.appendChild(mergeRow);

  const tabBar = document.createElement('div');
  tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg';

  const content = document.createElement('div');
  content.className = 'space-y-3';

  // ── Shared: import a single tune ──────────────────────────────────────────
  const importTune = async (tuneId: number, onSuccess: () => void, btn: HTMLButtonElement) => {
    btn.disabled = true;
    status.textContent = t('theSession.status.fetching');
    try {
      const tune = await fetchTuneById(tuneId);
      const existing = findByExternalId(`thesession:${tune.id}`, ctx.user.cards);
      if (existing) {
        await mutate(s => {
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === existing.id)) deck.entries.push({ cardId: existing.id });
          }
        });
        status.textContent = t('theSession.status.alreadyInLibrary', { name: tune.name });
        btn.disabled = false;
      } else {
        const card = tuneResultToCard(tune, { mergeSettings });
        await mutate(s => {
          s.cards[card.id] = card;
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId];
            if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
          }
        });
        status.textContent = t('theSession.status.imported', { name: card.name });
        onSuccess();
      }
    } catch (e) {
      status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      btn.disabled = false;
    }
  };

  const renderTabs = () => {
    tabBar.innerHTML = '';
    const tabs: Array<{ id: typeof activeTab; labelKey: string }> = [
      { id: 'tune',   labelKey: 'theSession.tabTune' },
      { id: 'member', labelKey: 'theSession.tabMember' },
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
    if (activeTab === 'tune')   renderTuneTab();
    if (activeTab === 'member') renderMemberTab();
  };

  // ── Tab: Tune (ID or name search) ─────────────────────────────────────────
  const renderTuneTab = () => {
    const { wrap: inputWrap, inp, info: infoSpan } = mkInputRow(t('theSession.tune.placeholder'));

    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary text-xs shrink-0';
    importBtn.textContent = t('theSession.id.import');
    importBtn.disabled = true;

    const row = document.createElement('div');
    row.className = 'flex gap-2';
    row.append(inputWrap, importBtn);

    let pendingId: number | null = null;
    const showResult = (name: string, type: string, id: number) => {
      pendingId = id;
      infoSpan.textContent = /^\d+$/.test(inp.value.trim()) ? `${name} · ${type}` : type;
      importBtn.disabled = false;
    };
    const clearResult = () => { pendingId = null; infoSpan.textContent = ''; importBtn.disabled = true; };

    importBtn.onclick = () => {
      if (pendingId === null) return;
      void importTune(pendingId, () => { inp.value = ''; clearResult(); }, importBtn);
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
        const meta = document.createElement('span'); meta.className = 'text-xs text-dim'; meta.textContent = tune.type;
        left.append(name, meta); item.appendChild(left);
        item.addEventListener('mousedown', e => { e.preventDefault(); inp.value = tune.name; dropdown.innerHTML = ''; hideDropdown(); showResult(tune.name, tune.type, tune.id); status.textContent = ''; });
        dropdown.appendChild(item);
      }
      showDropdown();
    };

    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    inp.addEventListener('input', () => {
      if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
      clearResult(); status.textContent = ''; dropdown.innerHTML = ''; hideDropdown();
      const val = inp.value.trim(); if (!val) return;
      if (/^\d+$/.test(val)) {
        inputTimer = setTimeout(async () => {
          inputTimer = null; status.textContent = t('theSession.status.fetching');
          try { const tune = await fetchTuneById(parseInt(val)); showResult(tune.name, tune.type, tune.id); status.textContent = ''; }
          catch { status.textContent = t('theSession.id.notFound'); }
        }, 150);
      } else if (val.length >= 2) {
        inputTimer = setTimeout(async () => {
          inputTimer = null; status.textContent = t('theSession.status.searching');
          try { const tunes = await searchTunes(val); renderSuggestions(sortByRelevance(tunes, val)); status.textContent = tunes.length ? '' : t('theSession.noResults'); }
          catch (e) { status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) }); }
        }, 300);
      }
    });
    inp.addEventListener('blur',  () => { setTimeout(hideDropdown, 150); });
    inp.addEventListener('focus', () => { if (dropdown.children.length) showDropdown(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(); if (e.key === 'Enter' && pendingId !== null) importBtn.click(); });

    content.append(row);
    focusIfDesktop(inp);
  };

  // ── Tab: Member (ID or name search) ───────────────────────────────────────
  const renderMemberTab = () => {
    const { wrap: inputWrap, inp, info: infoSpan } = mkInputRow(t('theSession.member.placeholder'));

    const importAllBtn = document.createElement('button');
    importAllBtn.className = 'btn-primary text-xs shrink-0';
    importAllBtn.textContent = t('theSession.member.importAll');
    importAllBtn.disabled = true;

    const row = document.createElement('div');
    row.className = 'flex gap-2';
    row.append(inputWrap, importAllBtn);

    // Progress bar
    const progressWrap = document.createElement('div'); progressWrap.className = 'hidden space-y-1';
    const progressTrack = document.createElement('div'); progressTrack.className = 'knowledge-bar';
    const progressFill = document.createElement('div'); progressFill.className = 'knowledge-fill bg-accent'; progressFill.style.width = '0%';
    progressTrack.appendChild(progressFill); progressWrap.appendChild(progressTrack);

    // Floating dropdown — same pattern as tune tab
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

    let selectedMemberId: number | null = null;

    const showMemberPreview = async (memberId: number) => {
      selectedMemberId = memberId; importAllBtn.disabled = true; infoSpan.textContent = '';
      status.textContent = t('theSession.status.fetching');
      try {
        const info = await fetchMemberInfo(memberId);
        const isIdSearch = /^\d+$/.test(inp.value.trim());
        infoSpan.textContent = isIdSearch ? `${info.name} · ${info.total} tunes` : `${info.total} tunes`;
        importAllBtn.disabled = false; status.textContent = '';
      } catch { status.textContent = t('theSession.member.notFound'); selectedMemberId = null; }
    };

    const renderMemberSuggestions = (members: MemberSearchResult[]) => {
      dropdown.innerHTML = '';
      if (!members.length) { hideDropdown(); return; }
      for (const m of members) {
        const item = document.createElement('div');
        item.className = 'flex items-center gap-3 px-3 py-2 hover:bg-bg cursor-pointer';
        const nameEl = document.createElement('span'); nameEl.className = 'text-sm text-primary truncate'; nameEl.textContent = m.name;
        item.appendChild(nameEl);
        item.addEventListener('mousedown', e => { e.preventDefault(); inp.value = m.name; hideDropdown(); void showMemberPreview(m.id); status.textContent = ''; });
        dropdown.appendChild(item);
      }
      showDropdown();
    };

    importAllBtn.onclick = async () => {
      if (selectedMemberId === null) return;
      const memberId = selectedMemberId;
      importAllBtn.disabled = true; inp.disabled = true;
      progressWrap.classList.remove('hidden'); progressFill.style.width = '0%';
      status.textContent = t('theSession.status.fetchingPage');
      try {
        const existingTuneIds = new Set<number>();
        for (const card of Object.values(ctx.user.cards)) {
          if (card.externalId?.startsWith('thesession:')) {
            const id = parseInt(card.externalId.slice('thesession:'.length));
            if (!isNaN(id)) existingTuneIds.add(id);
          }
        }
        const { tunes, skippedCount } = await fetchMemberTunes(memberId, (loaded, total, phase) => {
          progressFill.style.width = `${Math.round((loaded / total) * 100)}%`;
          status.textContent = phase === 'pages' ? t('theSession.status.collectingIds', { loaded, total }) : t('theSession.status.fetchingTunes', { loaded, total });
        }, id => existingTuneIds.has(id));
        const newCards = tunes.map(tune => tuneResultToCard(tune, { mergeSettings }));
        await mutate(s => {
          for (const card of newCards) { s.cards[card.id] = card; }
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId]; if (!deck) continue;
            for (const card of newCards) {
              if (!deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
            }
          }
        });
        progressFill.style.width = '100%';
        let summary = t('theSession.status.batchDone', { count: newCards.length });
        if (skippedCount > 0) summary = summary.replace('.', '') + t('theSession.status.batchSkipped', { count: skippedCount }) + '.';
        status.textContent = summary;
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { importAllBtn.disabled = false; inp.disabled = false; }
    };

    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    inp.addEventListener('input', () => {
      if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
      infoSpan.textContent = ''; importAllBtn.disabled = true; selectedMemberId = null;
      dropdown.innerHTML = ''; hideDropdown(); status.textContent = '';
      const val = inp.value.trim(); if (!val) return;
      if (/^\d+$/.test(val)) {
        void showMemberPreview(parseInt(val));
      } else if (val.length >= 2) {
        inputTimer = setTimeout(async () => {
          inputTimer = null; status.textContent = t('theSession.status.searching');
          try { const members = await searchMembers(val); renderMemberSuggestions(sortByRelevance(members, val)); status.textContent = members.length ? '' : t('theSession.noResults'); }
          catch (e) { status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) }); }
        }, 300);
      }
    });
    inp.addEventListener('blur',  () => { setTimeout(hideDropdown, 150); });
    inp.addEventListener('focus', () => { if (dropdown.children.length) showDropdown(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(); if (e.key === 'Enter' && selectedMemberId !== null) importAllBtn.click(); });

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
  dialog.style.cssText = `max-width:min(440px, ${modalMaxW(0.9)}); max-height:${modalMaxH(0.85)};`;

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
  const linkIconSvg  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
  const deckBtn = document.createElement('button');
  const updateDeckBtn = () => {
    const n = selectedDeckIds.size;
    deckBtn.innerHTML = `${linkIconSvg}${n > 0 ? ` (${n})` : ''}`;
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
    selDialog.style.cssText = `max-width:min(360px, ${modalMaxW(0.9)}); max-height:${modalMaxH(0.65)};`;
    const selHeader = document.createElement('div');
    selHeader.className = 'flex items-center justify-between px-4 py-3 border-b border-border shrink-0';
    const selTitle = document.createElement('span'); selTitle.className = 'text-sm font-semibold text-primary'; selTitle.textContent = t('newCard.selectDecks');
    const selClose = document.createElement('button'); selClose.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer'; selClose.textContent = '✕';
    selHeader.append(selTitle, selClose);
    const selBody = document.createElement('div'); selBody.className = 'overflow-y-auto flex-1 py-2';
    const decks = Object.values(ctx.user.decks).sort((a, b) => a.name.localeCompare(b.name));
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
    body.appendChild(mkChoiceCard(iconCreate, t('newCard.tabCreate'), t('newCard.createDesc'), 'var(--color-accent)', () => navigate('create')));
    body.appendChild(mkChoiceCard(iconImport, t('newCard.tabImport'), t('newCard.importDesc'), 'var(--color-warn)', () => navigate('import')));
  };

  const renderCreate = () => {
    const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = t('newCard.nameLabel');
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input'; inp.placeholder = t('newCard.namePlaceholder');
    const createBtn = document.createElement('button'); createBtn.className = 'btn-primary w-full mt-1'; createBtn.textContent = t('newCard.createBtn');
    const doCreate = async () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      await mutate(s => {
        const id   = generateId();
        const guid = generateId();
        s.cards[id] = { id, guid, name, importance: 1, tags: [], content: { notes: '', attachments: [] } };
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
    body.appendChild(mkChoiceCard(iconTs,   t('newCard.tabTheSession'), t('newCard.theSessionDesc'), 'var(--color-success)', () => navigate('thesession')));
    body.appendChild(mkChoiceCard(iconJson, t('newCard.tabImportJson'), t('newCard.importJsonDesc'), 'var(--color-warn)', () => navigate('json')));
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
          await mutate(s => {
            for (const card of cards) { if (!s.cards[card.id]) { s.cards[card.id] = card; newCards.push(card); imported++; } }
            for (const deckId of selectedDeckIds) {
              const deck = s.decks[deckId];
              if (!deck) continue;
              for (const card of cards) {
                if (!deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
              }
            }
          });
          const skipped = cards.length - imported;
          let summary = t('theSession.status.batchDone', { count: imported });
          if (skipped > 0) summary = summary.replace('.', '') + t('theSession.status.batchSkipped', { count: skipped }) + '.';
          status.textContent = summary;
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
