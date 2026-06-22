import type { AppContext } from '../types';
import { focusIfDesktop, sortByRelevance } from '../utils';
import { mutate } from '../store';
import {
  searchTunes, fetchTuneById, fetchPlaylist, fetchPlaylistTunes, fetchAudioFile,
  tuneToCard, isServerWarm,
  type TuneSearchResult,
} from '../services/irishTuneInfoService';
import { findByExternalId } from '../services/theSessionService';
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

// ── Body builder ──────────────────────────────────────────────────────────────

export function buildIrishTuneInfoBody(ctx: AppContext, status: HTMLElement, getTargetDeckIds?: () => Set<string>): HTMLElement {
  let activeTab: 'tune' | 'playlist' = 'tune';
  let includeAudio = false;

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
    status.textContent = fetchingMsg();
    try {
      const tune = await fetchTuneById(tuneId);
      const existing = findByExternalId(`irishtuneinfo:${tune.id}`, ctx.user.cards);
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
        status.textContent = t('irishTuneInfo.status.imported', { name: card.name });
        onSuccess();
      }
    } catch (e) {
      status.textContent = t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) });
      btn.disabled = false;
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

  // ── Tab: Tune (ID or name search) ─────────────────────────────────────────
  const renderTuneTab = () => {
    const { wrap: inputWrap, inp, info: infoSpan } = mkInputRow(t('irishTuneInfo.tune.placeholder'));

    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary text-xs shrink-0';
    importBtn.textContent = t('irishTuneInfo.id.import');
    importBtn.disabled = true;

    const row = document.createElement('div');
    row.className = 'flex gap-2';
    row.append(inputWrap, importBtn);

    let pendingId: number | null = null;
    const showResult = (name: string, rhythm: string, id: number) => {
      pendingId = id;
      infoSpan.textContent = /^\d+$/.test(inp.value.trim()) ? `${name} · ${rhythm}` : rhythm;
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
        const meta = document.createElement('span'); meta.className = 'text-xs text-dim'; meta.textContent = tune.rhythm;
        left.append(name, meta); item.appendChild(left);
        item.addEventListener('mousedown', e => { e.preventDefault(); inp.value = tune.name; dropdown.innerHTML = ''; hideDropdown(); showResult(tune.name, tune.rhythm, tune.id); status.textContent = ''; });
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
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(); if (e.key === 'Enter' && pendingId !== null) importBtn.click(); });

    content.append(row);
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

    const showPreview = async (username: string) => {
      pendingUsername = null; importAllBtn.disabled = true; infoSpan.textContent = '';
      status.textContent = fetchingMsg();
      try {
        const playlist = await fetchPlaylist(username);
        const n = playlist.tunes.length;
        infoSpan.textContent = n === 1 ? t('irishTuneInfo.playlist.preview', { count: n }) : t('irishTuneInfo.playlist.previewPlural', { count: n });
        pendingUsername = username;
        importAllBtn.disabled = n === 0;
        status.textContent = '';
      } catch {
        status.innerHTML = `${t('irishTuneInfo.playlist.notFound')}<br><span class="text-warn">${t('irishTuneInfo.playlist.makePublicHint')}</span>`;
      }
    };

    importAllBtn.onclick = async () => {
      if (pendingUsername === null) return;
      const username = pendingUsername;
      importAllBtn.disabled = true; inp.disabled = true;
      progressWrap.classList.remove('hidden'); progressFill.style.width = '0%';
      status.textContent = fetchingMsg();
      try {
        const existingTuneIds = new Set<number>();
        for (const card of Object.values(ctx.user.cards)) {
          if (card.externalId?.startsWith('irishtuneinfo:')) {
            const id = parseInt(card.externalId.slice('irishtuneinfo:'.length));
            if (!isNaN(id)) existingTuneIds.add(id);
          }
        }
        const { tunes, skippedCount } = await fetchPlaylistTunes(username, (loaded, total) => {
          progressFill.style.width = `${Math.round((loaded / total) * 100)}%`;
          status.textContent = t('irishTuneInfo.status.fetchingTunes', { loaded, total });
        }, id => existingTuneIds.has(id), includeAudio);
        const newCards = tunes.map(({ tune, audioFile }) => tuneToCard(tune, audioFile));
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
        let summary = t('irishTuneInfo.status.batchDone', { count: newCards.length });
        if (skippedCount > 0) summary = summary.replace('.', '') + t('irishTuneInfo.status.batchSkipped', { count: skippedCount }) + '.';
        status.textContent = summary;
      } catch (e) {
        status.textContent = t('irishTuneInfo.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { importAllBtn.disabled = false; inp.disabled = false; }
    };

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
