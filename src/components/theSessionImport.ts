import type { AppContext, AppState } from '../types';
import { generateId } from '../utils';
import { showModal, closeModal } from './modal';
import {
  searchTunes, fetchTuneById, fetchMemberTunes, fetchMemberInfo,
  tuneResultToCard, findByExternalId,
  type TuneSearchResult,
} from '../services/theSessionService';

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

export function buildTheSessionBody(ctx: AppContext, status: HTMLElement, deckId?: string): HTMLElement {
  let activeTab: 'id' | 'search' | 'member' = 'search';

  const wrap = document.createElement('div');
  wrap.className = 'space-y-3';

  const tabBar = document.createElement('div');
  tabBar.className = 'flex gap-1 p-1 bg-bg rounded-lg';

  const content = document.createElement('div');
  content.className = 'space-y-3';

  const renderTabs = () => {
    tabBar.innerHTML = '';
    const tabs: Array<{ id: typeof activeTab; label: string }> = [
      { id: 'search', label: 'Search' },
      { id: 'id',     label: 'By ID' },
      { id: 'member', label: 'By member' },
    ];
    for (const tab of tabs) {
      tabBar.appendChild(mkTab(tab.label, activeTab === tab.id, () => {
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
    const inp = document.createElement('input'); inp.type = 'number'; inp.placeholder = 'Tune ID…'; inp.className = 'input flex-1';
    const btn = document.createElement('button'); btn.className = 'btn-primary shrink-0'; btn.textContent = 'Import';
    const preview = document.createElement('p'); preview.className = 'text-xs text-muted min-h-[1.25rem]';

    let previewId = -1;
    const doPreview = debounce(async (val: string) => {
      const id = parseInt(val);
      if (isNaN(id)) { preview.textContent = ''; return; }
      previewId = id;
      try {
        const tune = await fetchTuneById(id);
        if (previewId === id) preview.textContent = `${tune.name} · ${tune.type}`;
      } catch { if (previewId === id) preview.textContent = 'Tune not found.'; }
    }, 400);

    btn.onclick = async () => {
      const id = parseInt(inp.value);
      if (isNaN(id)) return;
      btn.disabled = true; status.textContent = 'Fetching…';
      try {
        const tune = await fetchTuneById(id);
        const existing = findByExternalId(`thesession:${tune.id}`, ctx.state.cards);
        if (existing) {
          if (deckId) await ctx.mutate(s => { linkCardToDeck(s, existing.id, deckId!); });
          status.textContent = `"${tune.name}" is already in your library${deckId ? ' — linked to this deck.' : '.'}`;
          inp.value = ''; preview.textContent = '';
        } else {
          const card = tuneResultToCard(tune);
          await ctx.mutate(s => { s.cards[card.id] = card; if (deckId) linkCardToDeck(s, card.id, deckId); });
          status.textContent = `✓ "${card.name}" imported.`;
          inp.value = ''; preview.textContent = '';
        }
      } catch (e) {
        status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      } finally { btn.disabled = false; }
    };
    inp.addEventListener('input', () => doPreview(inp.value));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    row.append(inp, btn);
    content.append(row, preview);
  };

  // ── Tab: Search ───────────────────────────────────────────────────────────

  const renderSearchTab = () => {
    const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Tune name…'; inp.className = 'input';
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
        importBtn.textContent = 'Import';
        importBtn.onclick = async () => {
          importBtn.disabled = true; status.textContent = 'Importing…';
          try {
            const fullTune = await fetchTuneById(tune.id);
            const existing = findByExternalId(`thesession:${fullTune.id}`, ctx.state.cards);
            if (existing) {
              if (deckId) await ctx.mutate(s => { linkCardToDeck(s, existing.id, deckId!); });
              status.textContent = `"${fullTune.name}" is already in your library${deckId ? ' — linked to this deck.' : '.'}`;
            } else {
              const card = tuneResultToCard(fullTune);
              await ctx.mutate(s => { s.cards[card.id] = card; if (deckId) linkCardToDeck(s, card.id, deckId); });
              status.textContent = `✓ "${card.name}" imported.`;
            }
          } catch (e) {
            status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
          } finally { importBtn.disabled = false; }
        };
        row.append(left, importBtn);
        suggestions.appendChild(row);
      }
    };

    const doSearch = debounce(async (q: string) => {
      if (!q.trim()) { suggestions.innerHTML = ''; return; }
      status.textContent = 'Searching…';
      try {
        const tunes = await searchTunes(q);
        renderSuggestions(tunes);
        status.textContent = tunes.length ? '' : 'No results.';
      } catch (e) {
        status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }, 300);

    inp.addEventListener('input', () => doSearch(inp.value));
    content.append(inp, suggestions);
    setTimeout(() => inp.focus(), 30);
  };

  // ── Tab: By member ────────────────────────────────────────────────────────

  const renderMemberTab = () => {
    const row = document.createElement('div'); row.className = 'flex gap-2';
    const inp = document.createElement('input'); inp.type = 'number'; inp.placeholder = 'Member ID…'; inp.className = 'input flex-1';
    const btn = document.createElement('button'); btn.className = 'btn-primary shrink-0'; btn.textContent = 'Import all';
    const preview = document.createElement('p'); preview.className = 'text-xs text-muted min-h-[1.25rem]';

    let previewId = -1;
    const doPreview = debounce(async (val: string) => {
      const id = parseInt(val);
      if (isNaN(id)) { preview.textContent = ''; return; }
      previewId = id;
      try {
        const info = await fetchMemberInfo(id);
        if (previewId === id) preview.textContent = `${info.name} · ${info.total} tune${info.total !== 1 ? 's' : ''}`;
      } catch { if (previewId === id) preview.textContent = 'Member not found.'; }
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
      status.textContent = 'Fetching page 1…';
      try {
        const tunes = await fetchMemberTunes(memberId, (loaded, total, phase) => {
          progressFill.style.width = `${Math.round((loaded / total) * 100)}%`;
          status.textContent = phase === 'pages'
            ? `Collecting IDs — page ${loaded}/${total}…`
            : `Fetching tunes — ${loaded}/${total}…`;
        });
        const existingCards = tunes.map(t => findByExternalId(`thesession:${t.id}`, ctx.state.cards));
        const newTunes = tunes.filter((_, i) => !existingCards[i]);
        const alreadyExisting = tunes.filter((_, i) => !!existingCards[i]);
        const newCards = newTunes.map(tuneResultToCard);
        await ctx.mutate(s => {
          for (const card of newCards) { s.cards[card.id] = card; if (deckId) linkCardToDeck(s, card.id, deckId); }
          if (deckId) { for (const t of alreadyExisting) { const c = findByExternalId(`thesession:${t.id}`, s.cards); if (c) linkCardToDeck(s, c.id, deckId); } }
        });
        progressFill.style.width = '100%';
        const linked = deckId ? alreadyExisting.length : 0;
        const summary = `✓ ${newCards.length} imported${linked > 0 ? `, ${linked} already in library linked to deck` : alreadyExisting.length > 0 ? `, ${alreadyExisting.length} already in library skipped` : ''}`;
        status.textContent = `${summary}.`;
      } catch (e) {
        status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        btn.disabled = false; inp.disabled = false;
      }
    };

    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    row.append(inp, btn);
    content.append(row, preview, progressWrap);
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
    const tabs: Array<{ id: ActiveTab; label: string }> = [
      { id: 'create',     label: 'Create' },
      { id: 'thesession', label: 'TheSession' },
    ];
    for (const tab of tabs) {
      outerTabBar.appendChild(mkTab(tab.label, activeTab === tab.id, () => {
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
      const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = 'Card name';
      const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input'; inp.placeholder = 'Card name…';
      const createBtn = document.createElement('button'); createBtn.className = 'btn-primary w-full mt-1'; createBtn.textContent = 'Create';
      const doCreate = async () => {
        const name = inp.value.trim();
        if (!name) { inp.focus(); return; }
        await ctx.mutate(s => {
          const id = generateId();
          s.cards[id] = { id, name, importance: 1, tags: [], content: { notes: '', files: [] } };
          if (deckId) s.decks[deckId]!.entries.push({ cardId: id });
        });
        closeModal();
      };
      createBtn.onclick = () => { void doCreate(); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { void doCreate(); } });
      outerContent.append(lbl, inp, createBtn);
      setTimeout(() => inp.focus(), 30);
    } else {
      outerContent.appendChild(buildTheSessionBody(ctx, status, deckId));
    }
  };

  renderTabs();
  renderContent();
  body.append(outerTabBar, outerContent, status);

  showModal('New Card', body, [{ label: 'Close', onClick: closeModal }]);
}
