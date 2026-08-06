import type { AppContext, Card } from '../types';
import { generateId, focusIfDesktop, sortByRelevance } from '../utils';
import { parseCardPackage, parseCardPackageFromText } from '../services/importExport';
import { downloadShare } from '../services/shareService';
import { mutate, appState } from '../store';
import {
  searchTunes, fetchTuneById, fetchMemberTunes, fetchMemberInfo, searchMembers, fetchTunesByIds,
  tuneResultToCard, findByExternalId,
  type TuneSearchResult, type MemberSearchResult, type TuneSetting,
} from '../services/theSessionService';
import { t } from '../services/i18nService';
import { modalMaxH, modalMaxW, getZoom } from '../services/zoomService';
import { buildIrishTuneInfoBody } from './irishTuneInfoImport';
import { showDeckPickerPopover, deckLinkIcon } from './deckSelector';
import { AI_IMPORT_PROMPT } from './aiImportPrompt';
import { fetchTuneById as fetchIriTuneById, tuneToCard as iriTuneToCard } from '../services/irishTuneInfoService';

/** Merges the AI-authored card onto the real fetched one: the fetch is always
 *  authoritative for the tune's identity/ABC (never trust the AI for that —
 *  the whole reason this hydration exists, see the id-hallucination note
 *  below), but the AI's own touches are kept on top rather than discarded —
 *  title override, notes override, tags/attachments appended. Deliberately
 *  NOT merged: defaultImportance — sanitizeCard() always backfills it to 1
 *  when absent, so there's no way to tell "the AI wrote 1" from "the AI wrote
 *  nothing", and silently overriding a genuine 1 would be worse than not
 *  merging it at all. */
/** AI-authored, consumed here only — never persisted as its own field, just
 *  its effect (Attachment.preferredIndex on the merged ABC). Two forms, same
 *  "only if explicitly given, never guessed" rule as externalId itself: a
 *  plain number (1-based position — "the 2nd setting listed", for when the
 *  user told the AI which one by position) or {"settingId": N} (a real
 *  TheSession setting id, e.g. from a #settingN URL the user gave) — resolved
 *  by searching the real fetched settings, never trusted blindly. */
function resolvePreferredSettingIndex(pref: unknown, settings: TuneSetting[]): number | undefined {
  if (typeof pref === 'number') {
    const idx = Math.trunc(pref) - 1;
    return idx >= 0 && idx < settings.length ? idx : undefined;
  }
  if (pref && typeof pref === 'object' && 'settingId' in pref) {
    const settingId = Number((pref as { settingId: unknown }).settingId);
    const idx = settings.findIndex(s => s.id === settingId);
    return idx === -1 ? undefined : idx;
  }
  return undefined;
}

async function hydrateExternalCard(card: Card): Promise<Card | null> {
  const ext = card.externalId;
  if (!ext) return card;
  const sep = ext.indexOf(':');
  const source = ext.slice(0, sep);
  const id = parseInt(ext.slice(sep + 1), 10);
  if (isNaN(id)) return card;
  try {
    let fetched: Card | null = null;
    if (source === 'thesession') {
      const tune = await fetchTuneById(id);
      fetched = tuneResultToCard(tune);
      const preferredIndex = resolvePreferredSettingIndex((card as { preferredSetting?: unknown }).preferredSetting, tune.settings);
      if (preferredIndex !== undefined) {
        const abcAttachment = fetched.content.attachments.find(a => a.type === 'file');
        if (abcAttachment && abcAttachment.type === 'file') abcAttachment.preferredIndex = preferredIndex;
      }
    } else if (source === 'irishtuneinfo') {
      fetched = iriTuneToCard(await fetchIriTuneById(id));
    }
    if (!fetched) return card;
    return {
      ...fetched,
      id: card.id,
      guid: card.guid,
      name: card.name || fetched.name,
      tags: [...new Set([...fetched.tags, ...card.tags])],
      content: {
        notes: card.content.notes || fetched.content.notes,
        attachments: [...fetched.content.attachments, ...card.content.attachments],
      },
    };
  } catch {
    return null;
  }
}

// ── Shared: import a batch of cards from a .cdc package (file or share key) ────
// Dedupes on externalId when present (two independent shares of the same
// TheSession tune land on two different card ids) so the same tune isn't
// re-created — the already-owned card is linked into the target deck instead.

async function importCardPackage(cards: Card[], deckIds: Iterable<string>): Promise<string> {
  let imported = 0;
  await mutate(s => {
    for (const card of cards) {
      const existing = card.externalId ? findByExternalId(card.externalId, s.cards) : s.cards[card.id];
      if (!existing) { s.cards[card.id] = card; imported++; }
      const targetId = existing?.id ?? card.id;
      for (const deckId of deckIds) {
        const deck = s.decks[deckId]; if (!deck) continue;
        if (!deck.entries.some(e => e.cardId === targetId)) deck.entries.push({ cardId: targetId });
      }
    }
  });
  const skipped = cards.length - imported;
  let summary = t('theSession.status.batchDone', { count: imported });
  if (skipped > 0) summary = summary.replace('.', '') + t('theSession.status.batchSkipped', { count: skipped }) + '.';
  return summary;
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

/** Parses a pasted delimited ID list ("1;5;97", "1, 5, 97", "1 5 97") — returns
 *  [] unless there are at least two distinct positive integers, so a lone ID
 *  still falls through to the regular single-tune lookup. */
function parseIdList(text: string): number[] {
  if (!/^\d+(?:[;,\s]+\d+)+[;,\s]*$/.test(text)) return [];
  return [...new Set(text.split(/[;,\s]+/).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n > 0))];
}

// ── TheSession body builder ───────────────────────────────────────────────────

export function buildTheSessionBody(
  ctx: AppContext,
  status: HTMLElement,
  getTargetDeckIds?: () => Set<string> | undefined,
  onNavigateToCard?: () => void,
  withDeckChoice: (onReady: () => void) => void = onReady => onReady(),
): HTMLElement {
  let activeTab: 'tune' | 'member' = 'tune';
  let mergeSettings = true;

  const setImportedStatus = (cardId: string, cardName: string) => {
    const marker = '\x00';
    const [pre, suf] = t('theSession.status.imported', { name: marker }).split(marker);
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
      const existing = findByExternalId(`thesession:${tune.id}`, appState.value.cards);
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
        setImportedStatus(card.id, card.name);
        onSuccess();
      }
    } catch (e) {
      status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      btn.disabled = false;
    }
  };

  /** Cards already owned, by TheSession tune ID — shared by every batch path
   *  (member tunebook, pasted ID list) to skip re-fetching and still link the
   *  existing card into the target deck. */
  const buildExistingByTuneId = (): Map<number, string> => {
    const map = new Map<number, string>();
    for (const card of Object.values(appState.value.cards)) {
      if (card.externalId?.startsWith('thesession:')) {
        const id = parseInt(card.externalId.slice('thesession:'.length));
        if (!isNaN(id)) map.set(id, card.id);
      }
    }
    return map;
  };

  /** Shared: import a list of tune IDs (e.g. pasted "1;5;97"), same shape as
   *  the member tunebook batch import below. */
  const importIds = async (
    ids: number[],
    onProgress: (loaded: number, total: number) => void,
    onDone: () => void,
  ): Promise<void> => {
    status.textContent = t('theSession.status.fetching');
    try {
      const existingCardIdByTuneId = buildExistingByTuneId();
      const { tunes, skippedIds } = await fetchTunesByIds(ids, onProgress, id => existingCardIdByTuneId.has(id));
      const newCards = tunes.map(tune => tuneResultToCard(tune, { mergeSettings }));
      await mutate(s => {
        for (const card of newCards) { s.cards[card.id] = card; }
        const linkIds = [...newCards.map(c => c.id), ...skippedIds.map(id => existingCardIdByTuneId.get(id)!)];
        for (const deckId of (getTargetDeckIds?.() ?? [])) {
          const deck = s.decks[deckId]; if (!deck) continue;
          for (const cardId of linkIds) {
            if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
          }
        }
      });
      let summary = t('theSession.status.batchDone', { count: newCards.length });
      if (skippedIds.length > 0) summary = summary.replace('.', '') + t('theSession.status.batchSkipped', { count: skippedIds.length }) + '.';
      status.textContent = summary;
    } catch (e) {
      status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
    } finally {
      onDone();
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

  // ── Tab: Tune (ID, name search, or a pasted "1;5;97" ID list) ─────────────
  const renderTuneTab = () => {
    const { wrap: inputWrap, inp, info: infoSpan } = mkInputRow(t('theSession.tune.placeholder'));
    inputWrap.title = t('theSession.ids.hint');

    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary text-xs shrink-0';
    importBtn.textContent = t('theSession.id.import');
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
    const showResult = (name: string, type: string, id: number) => {
      pendingId = id; pendingIds = null;
      infoSpan.textContent = /^\d+$/.test(inp.value.trim()) ? `${name} · ${type}` : type;
      importBtn.disabled = false;
    };
    const showIdList = (ids: number[]) => {
      pendingIds = ids; pendingId = null;
      infoSpan.textContent = ids.length === 1 ? t('theSession.ids.preview', { count: ids.length }) : t('theSession.ids.previewPlural', { count: ids.length });
      importBtn.disabled = false;
    };
    const clearResult = () => { pendingId = null; pendingIds = null; infoSpan.textContent = ''; importBtn.disabled = true; };

    importBtn.onclick = () => {
      if (pendingIds) {
        const ids = pendingIds;
        withDeckChoice(() => {
          importBtn.disabled = true; inp.disabled = true;
          progressWrap.classList.remove('hidden'); progressFill.style.width = '0%';
          void importIds(ids, (loaded, total) => { progressFill.style.width = `${Math.round((loaded / total) * 100)}%`; status.textContent = t('theSession.status.fetchingTunes', { loaded, total }); }, () => {
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
        const meta = document.createElement('span'); meta.className = 'text-xs text-dim'; meta.textContent = tune.type;
        left.append(name, meta); item.appendChild(left);
        item.addEventListener('mousedown', e => { e.preventDefault(); inp.value = tune.name; dropdown.innerHTML = ''; hideDropdown(); showResult(tune.name, tune.type, tune.id); status.textContent = ''; });
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
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') hideDropdown(); if (e.key === 'Enter' && (pendingId !== null || pendingIds !== null)) importBtn.click(); });

    content.append(row, progressWrap);
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

    const doImportAll = async () => {
      if (selectedMemberId === null) return;
      const memberId = selectedMemberId;
      importAllBtn.disabled = true; inp.disabled = true;
      progressWrap.classList.remove('hidden'); progressFill.style.width = '0%';
      status.textContent = t('theSession.status.fetchingPage');
      try {
        const existingCardIdByTuneId = buildExistingByTuneId();
        const { tunes, skippedIds } = await fetchMemberTunes(memberId, (loaded, total, phase) => {
          progressFill.style.width = `${Math.round((loaded / total) * 100)}%`;
          status.textContent = phase === 'pages' ? t('theSession.status.collectingIds', { loaded, total }) : t('theSession.status.fetchingTunes', { loaded, total });
        }, id => existingCardIdByTuneId.has(id));
        const newCards = tunes.map(tune => tuneResultToCard(tune, { mergeSettings }));
        await mutate(s => {
          for (const card of newCards) { s.cards[card.id] = card; }
          // Already-owned tunes were skipped above (no re-fetch), but they
          // still belong in the target deck if they were missing there.
          const linkIds = [...newCards.map(c => c.id), ...skippedIds.map(id => existingCardIdByTuneId.get(id)!)];
          for (const deckId of (getTargetDeckIds?.() ?? [])) {
            const deck = s.decks[deckId]; if (!deck) continue;
            for (const cardId of linkIds) {
              if (!deck.entries.some(e => e.cardId === cardId)) deck.entries.push({ cardId });
            }
          }
        });
        progressFill.style.width = '100%';
        let summary = t('theSession.status.batchDone', { count: newCards.length });
        if (skippedIds.length > 0) summary = summary.replace('.', '') + t('theSession.status.batchSkipped', { count: skippedIds.length }) + '.';
        status.textContent = summary;
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { importAllBtn.disabled = false; inp.disabled = false; }
    };
    importAllBtn.onclick = () => withDeckChoice(() => { void doImportAll(); });

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

export function showNewCardModal(ctx: AppContext, initialDeckIds?: string[]): void {
  type Step = 'root' | 'create' | 'import' | 'thesession' | 'irishtuneinfo' | 'json' | 'json-file' | 'share' | 'ai';
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
  // undefined = never touched the deck picker yet — creation triggers below
  // force it open first (see withDeckChoice) instead of creating right away.
  // A caller-provided deck (e.g. opening this from within a deck) counts as
  // an already-made choice, so it skips that forced picker.
  let selectedDeckIds: Set<string> | undefined = initialDeckIds ? new Set(initialDeckIds) : undefined;
  const ensureSelectedDeckIds = (): Set<string> => {
    if (!selectedDeckIds) selectedDeckIds = new Set();
    return selectedDeckIds;
  };
  const deckBtn = document.createElement('button');
  const updateDeckBtn = () => {
    const ids = selectedDeckIds;
    const suffix = ids === undefined ? ' (?)' : ids.size > 0 ? ` (${ids.size})` : '';
    deckBtn.innerHTML = `${deckLinkIcon}${suffix}`;
    deckBtn.className = `inline-flex items-center gap-1 text-xs transition-colors cursor-pointer shrink-0 ${
      ids === undefined ? 'text-warn hover:text-primary' : ids.size > 0 ? 'text-accent' : 'text-dim hover:text-primary'
    }`;
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
    root:         t('newCard.title'),
    create:       t('newCard.tabCreate'),
    import:       t('newCard.tabImport'),
    thesession:   t('newCard.tabTheSession'),
    irishtuneinfo: t('newCard.tabIrishTuneInfo'),
    json:         t('newCard.tabImportJson'),
    'json-file':  t('newCard.tabImportJson'),
    share:        t('newCard.tabImportJson'),
    ai:           t('newCard.tabAi'),
  };

  // Coordinates with the outer modal's Escape handler below, so Escape closes
  // the deck popover first instead of the whole "new card" modal.
  let deckSelectorOpen = false;
  const showDeckSelector = () => {
    deckSelectorOpen = true;
    const ids = ensureSelectedDeckIds();
    updateDeckBtn();
    showDeckPickerPopover(ids, updateDeckBtn, () => { deckSelectorOpen = false; });
  };
  deckBtn.onclick = showDeckSelector;

  /** Gate for every creation/import trigger below: the first one ever clicked
   *  forces a deliberate deck choice (or explicit "none") before anything is
   *  created — `onReady` runs immediately if already chosen, else once the
   *  forced picker closes (no second click needed). */
  const withDeckChoice = (onReady: () => void): void => {
    if (selectedDeckIds !== undefined) { onReady(); return; }
    deckSelectorOpen = true;
    const ids = ensureSelectedDeckIds();
    updateDeckBtn();
    showDeckPickerPopover(ids, updateDeckBtn, () => { deckSelectorOpen = false; onReady(); });
  };

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
    btn.title = desc;
    const iconWrap = document.createElement('span');
    iconWrap.style.color = accentColor;
    iconWrap.className = 'shrink-0 flex items-center';
    iconWrap.innerHTML = icon;
    const labelEl = document.createElement('div'); labelEl.className = 'flex-1 text-sm font-medium text-primary'; labelEl.textContent = label;
    const arrow = document.createElement('span'); arrow.className = 'text-dim text-base leading-none shrink-0'; arrow.textContent = '›';
    btn.append(iconWrap, labelEl, arrow);
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
      const backParent: Step = (step === 'share' || step === 'json-file' || step === 'ai') ? 'json' : (step === 'thesession' || step === 'irishtuneinfo' || step === 'json') ? 'import' : 'root';
      backBtn.classList.remove('hidden');
      backBtn.onclick = () => navigate(backParent);
    }
    renderBody();
  };

  const renderBody = () => {
    body.innerHTML = '';
    if (currentStep === 'root')               renderRoot();
    else if (currentStep === 'create')        renderCreate();
    else if (currentStep === 'import')        renderImport();
    else if (currentStep === 'thesession')    renderTheSession();
    else if (currentStep === 'irishtuneinfo') renderIrishTuneInfo();
    else if (currentStep === 'json')          renderJson();
    else if (currentStep === 'json-file')     renderJsonFile();
    else if (currentStep === 'share')         renderShare();
    else if (currentStep === 'ai')            renderAi();
  };

  const renderRoot = () => {
    const iconCreate = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const iconImport = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    body.appendChild(mkChoiceCard(iconCreate, t('newCard.tabCreate'), t('newCard.createDesc'), 'var(--color-accent)', () => navigate('create')));
    body.appendChild(mkChoiceCard(iconImport, t('newCard.tabImport'), t('newCard.importDesc'), 'var(--color-warn)', () => navigate('import')));
  };

  const renderCreate = () => {
    const lbl = document.createElement('label'); lbl.className = 'label'; lbl.textContent = t('newCard.nameLabel');
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input'; inp.placeholder = t('newCard.namePlaceholder');
    const createBtn = document.createElement('button'); createBtn.className = 'btn-primary w-full mt-1'; createBtn.textContent = t('newCard.createBtn');
    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';
    const doCreate = async () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      createBtn.disabled = true;
      let createdId = '';
      await mutate(s => {
        const id   = generateId();
        const guid = generateId();
        createdId = id;
        s.cards[id] = { id, guid, name, defaultImportance: 1, tags: [], content: { notes: '', attachments: [] } };
        for (const deckId of selectedDeckIds!) { // doCreate only ever runs via withDeckChoice, which guarantees this
          const deck = s.decks[deckId];
          if (deck && !deck.entries.some(e => e.cardId === id)) deck.entries.push({ cardId: id });
        }
      });
      const marker = '\x00';
      const [pre, suf] = t('newCard.create.done', { name: marker }).split(marker);
      status.textContent = '';
      status.append(pre);
      const link = document.createElement('span');
      link.textContent = name;
      link.className = 'text-accent cursor-pointer hover:underline';
      link.onclick = () => { ctx.navigate({ view: 'card', cardId: createdId }); close(); };
      status.append(link, suf);
    };
    createBtn.onclick = () => withDeckChoice(() => { void doCreate(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') withDeckChoice(() => { void doCreate(); }); });
    body.append(lbl, inp, createBtn, status);
    inp.focus();
  };

  const renderImport = () => {
    const iconTs   = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    const iconIti  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    const iconJson = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    body.appendChild(mkChoiceCard(iconTs,   t('newCard.tabTheSession'),    t('newCard.theSessionDesc'),    'var(--color-success)', () => navigate('thesession')));
    body.appendChild(mkChoiceCard(iconIti,  t('newCard.tabIrishTuneInfo'), t('newCard.irishTuneInfoDesc'), 'var(--color-accent)',  () => navigate('irishtuneinfo')));
    body.appendChild(mkChoiceCard(iconJson, t('newCard.tabImportJson'),    t('newCard.importJsonDesc'),    'var(--color-warn)',    () => navigate('json')));
  };

  const renderTheSession = () => {
    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';
    body.append(buildTheSessionBody(ctx, status, () => selectedDeckIds, close, withDeckChoice), status);
  };

  const renderIrishTuneInfo = () => {
    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';
    body.append(buildIrishTuneInfoBody(ctx, status, () => selectedDeckIds, close, withDeckChoice), status);
  };

  const renderJson = () => {
    const iconFile  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    const iconShare = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
    const iconAi    = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>`;
    body.append(
      mkChoiceCard(iconFile,  t('library.export.file'),  t('newCard.importJsonDesc'), 'var(--color-warn)',   () => navigate('json-file')),
      mkChoiceCard(iconShare, t('newCard.share.label'),  t('newCard.share.desc'),     'var(--color-accent)', () => navigate('share')),
      mkChoiceCard(iconAi,    t('newCard.tabAi'),        t('newCard.aiDesc'),         'var(--color-success)', () => navigate('ai')),
    );
  };

  const renderJsonFile = () => {
    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'btn-primary w-full text-sm'; pickBtn.textContent = t('newCard.import.pick');
    const doImportFile = async (file: File) => {
      pickBtn.disabled = true; status.textContent = t('newCard.import.importing');
      try {
        const cards = await parseCardPackage(file);
        status.textContent = await importCardPackage(cards, selectedDeckIds!);
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { pickBtn.disabled = false; }
    };
    pickBtn.onclick = () => {
      const fileInp = document.createElement('input'); fileInp.type = 'file'; fileInp.accept = '.cdc';
      fileInp.onchange = () => {
        const file = fileInp.files?.[0]; if (!file) return;
        withDeckChoice(() => { void doImportFile(file); });
      };
      fileInp.click();
    };
    body.append(pickBtn, status);
  };

  const renderShare = () => {
    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';
    const { wrap: inputWrap, inp } = mkInputRow(t('newCard.share.placeholder'));
    inp.maxLength = 6;
    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary text-xs shrink-0'; importBtn.textContent = t('newCard.share.importBtn'); importBtn.disabled = true;

    const row = document.createElement('div'); row.className = 'flex gap-2';
    row.append(inputWrap, importBtn);

    inp.addEventListener('input', () => {
      importBtn.disabled = inp.value.trim().length !== 6;
    });

    const doImport = async () => {
      const key = inp.value.trim();
      if (key.length !== 6) return;
      importBtn.disabled = true; status.textContent = t('newCard.import.importing');
      try {
        const text = await downloadShare(key);
        const file = new File([text], `share-${key}.cdc`, { type: 'application/octet-stream' });
        const cards = await parseCardPackage(file);
        status.textContent = await importCardPackage(cards, selectedDeckIds!);
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { importBtn.disabled = false; }
    };

    importBtn.onclick = () => withDeckChoice(() => { void doImport(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') withDeckChoice(() => { void doImport(); }); });
    body.append(row, status);
    focusIfDesktop(inp);
  };

  const renderAi = () => {
    const intro = document.createElement('p');
    intro.className = 'text-xs text-muted leading-relaxed';
    intro.textContent = t('newCard.ai.intro');

    const promptBox = document.createElement('pre');
    promptBox.className = 'text-[11px] font-mono text-primary/80 bg-bg border border-border rounded-lg p-3 max-h-48 overflow-y-auto whitespace-pre-wrap';
    promptBox.textContent = AI_IMPORT_PROMPT;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-primary w-full text-sm';
    copyBtn.textContent = t('newCard.ai.copy');
    copyBtn.onclick = () => {
      void navigator.clipboard.writeText(AI_IMPORT_PROMPT);
      copyBtn.textContent = t('newCard.ai.copied');
      setTimeout(() => { copyBtn.textContent = t('newCard.ai.copy'); }, 2000);
    };

    const pasteLabel = document.createElement('label');
    pasteLabel.className = 'label';
    pasteLabel.textContent = t('newCard.ai.pasteLabel');

    const pasteArea = document.createElement('textarea');
    pasteArea.className = 'input text-xs font-mono min-h-[6rem] resize-y';
    pasteArea.placeholder = t('newCard.ai.pastePlaceholder');

    const importBtn = document.createElement('button');
    importBtn.className = 'btn-primary w-full text-sm';
    importBtn.textContent = t('newCard.ai.pasteBtn');
    importBtn.disabled = true;
    pasteArea.addEventListener('input', () => { importBtn.disabled = !pasteArea.value.trim(); });

    const status = document.createElement('p'); status.className = 'text-xs text-muted min-h-[1.25rem]';

    const doImportPasted = async () => {
      importBtn.disabled = true;
      status.textContent = t('newCard.import.importing');
      try {
        const cards = parseCardPackageFromText(pasteArea.value);
        const toHydrate = cards.filter(c => c.externalId);
        const hydrated: Card[] = cards.filter(c => !c.externalId);
        let failed = 0;
        for (let i = 0; i < toHydrate.length; i++) {
          if (toHydrate.length > 1) status.textContent = t('theSession.status.fetchingTunes', { loaded: i, total: toHydrate.length });
          const h = await hydrateExternalCard(toHydrate[i]!);
          if (h) hydrated.push(h); else failed++;
        }
        let summary = await importCardPackage(hydrated, selectedDeckIds!);
        if (failed > 0) summary += ' ' + t('newCard.ai.fetchFailed', { count: failed });
        status.textContent = summary;
      } catch (e) {
        status.textContent = t('theSession.error', { message: e instanceof Error ? e.message : String(e) });
      } finally { importBtn.disabled = !pasteArea.value.trim(); }
    };
    importBtn.onclick = () => withDeckChoice(() => { void doImportPasted(); });

    body.append(intro, promptBox, copyBtn, pasteLabel, pasteArea, importBtn, status);
  };

  document.body.appendChild(overlay);
  navigate('root');
}
