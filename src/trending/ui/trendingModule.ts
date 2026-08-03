import type { SessionModuleHost } from '../../session/ui/sessionModule';
import { t } from '../../services/i18nService';
import { iconElement, FlameIcon, ResetIcon, MusicNoteIcon, PlusIcon } from '../../components/icons';
import { showDeckPickerPopover, deckLinkIcon } from '../../components/deckSelector';
import { showPreviewModal } from '../../components/fileViewer';
import { computeRows, sortRows, formatGain, type TuneRow, type GainMode } from '../../services/trendingService';
import { syncPopularityHistory, type SyncProgress } from '../../services/trendingSyncService';
import {
  fetchTuneById, tuneResultToCard, findByExternalId, settingsToMergedAbcFile, type TuneResult,
} from '../../services/theSessionService';
import type { PopularityDb } from '../db';
import { appState, mutate, navigate, replaceRoute } from '../../store';
import { timeAgo, externalSourceLink } from '../../utils';
import { buildSparkline } from './sparkline';

export interface TrendingRouteParams {
  from?: string;
  to?: string;
  gainMode?: GainMode;
  minTunebooks?: number;
}

// ── Trending module UI (hosted inside the Modules page) ──────────────────────
// Explorer over TheSession's popularity history, ported from the local
// TheSession_PopularityExplorer tool (free date range, absolute/percent gain,
// per-row sparkline) but adapted to Cadence's mobile-first / no-new-dependency
// conventions — see the plan doc. Per-row actions (sheet music, add to
// Cadence) and the shared deck-target picker mirror sessionModule.ts's
// annotationCard/titleAndDeleteRow exactly, rather than a separate detail screen.

const PAGE_SIZE = 50;
// Default preset: relative (%) evolution over the last month, tunes with at
// least 100 tunebooks (filters out obscure entries whose small counts make
// percentage changes noisy/meaningless).
const DEFAULT_MIN_TUNEBOOKS = 100;
const DEFAULT_WINDOW_DAYS = 365;

/** GitHub commit timestamps are ISO strings already starting with YYYY-MM-DD —
 *  exactly what <input type="date"> expects. */
function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

/** Index of the snapshot closest to `targetTime` — used to default "From" to ~1 month ago. */
function closestSnapshotIndex(snapshots: string[], targetTime: number): number {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < snapshots.length; i++) {
    const diff = Math.abs(new Date(snapshots[i]!).getTime() - targetTime);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }
  return bestIdx;
}

export function renderTrendingList(host: SessionModuleHost, initial?: TrendingRouteParams): void {
  host.header.replaceChildren();
  host.body.replaceChildren();

  // ── Header: title + deck target + refresh + sync status ─────────────────────
  const titleRow = document.createElement('div');
  titleRow.className = 'flex items-center justify-between mb-1';
  const title = document.createElement('h1');
  title.className = 'text-xl font-semibold text-primary flex items-center gap-2';
  title.appendChild(iconElement(FlameIcon, 18));
  title.append(t('trending.title'));
  titleRow.appendChild(title);

  const headerActions = document.createElement('div');
  headerActions.className = 'flex items-center gap-3 shrink-0';
  titleRow.appendChild(headerActions);

  // Target deck(s) new cards join — shared across every "+" in this screen,
  // same "(?) until touched at least once" convention as the sessions module.
  let targetDeckIds: Set<string> | undefined;
  const getTargetDeckIds = () => targetDeckIds;
  const ensureTargetDeckIds = () => { if (!targetDeckIds) targetDeckIds = new Set(); return targetDeckIds; };

  const deckBtn = document.createElement('button');
  const updateDeckBtn = () => {
    const ids = getTargetDeckIds();
    const suffix = ids === undefined ? ' (?)' : ids.size > 0 ? ` (${ids.size})` : '';
    deckBtn.innerHTML = `${deckLinkIcon}${suffix}`;
    deckBtn.className = `inline-flex items-center gap-1 text-xs transition-colors cursor-pointer shrink-0 ${
      ids === undefined ? 'text-warn hover:text-primary' : ids.size > 0 ? 'text-accent' : 'text-dim hover:text-primary'
    }`;
    deckBtn.title = t('newCard.selectDecks');
  };
  updateDeckBtn();
  deckBtn.onclick = () => {
    const ids = ensureTargetDeckIds();
    updateDeckBtn();
    showDeckPickerPopover(ids, updateDeckBtn);
  };
  headerActions.appendChild(deckBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'text-dim hover:text-accent transition-colors cursor-pointer';
  refreshBtn.title = t('trending.refresh');
  refreshBtn.appendChild(iconElement(ResetIcon, 14));
  headerActions.appendChild(refreshBtn);
  host.header.appendChild(titleRow);

  const status = document.createElement('div');
  status.className = 'text-xs text-dim mb-3';
  host.header.appendChild(status);

  // ── Controls bar ─────────────────────────────────────────────────────────
  const controls = document.createElement('div');
  controls.className = 'flex flex-wrap items-center gap-3 mb-3';
  controls.style.display = 'none';
  host.header.appendChild(controls);

  const dateInputClass = 'text-xs px-2 py-1 rounded border border-border bg-bg text-primary';

  const fromSlot = document.createElement('div');
  fromSlot.className = 'flex items-center gap-1.5';
  const fromLabel = document.createElement('span');
  fromLabel.className = 'text-xs text-dim';
  fromLabel.textContent = t('trending.from');
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.className = dateInputClass;
  fromSlot.append(fromLabel, fromInput);
  controls.appendChild(fromSlot);

  const toSlot = document.createElement('div');
  toSlot.className = 'flex items-center gap-1.5';
  const toLabel = document.createElement('span');
  toLabel.className = 'text-xs text-dim';
  toLabel.textContent = t('trending.to');
  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.className = dateInputClass;
  toSlot.append(toLabel, toInput);
  controls.appendChild(toSlot);

  const gainRow = document.createElement('div');
  gainRow.className = 'flex gap-1';
  controls.appendChild(gainRow);

  const threshWrap = document.createElement('div');
  threshWrap.className = 'flex items-center gap-1.5';
  const threshLabel = document.createElement('span');
  threshLabel.className = 'text-xs text-dim';
  threshLabel.textContent = t('trending.minTunebooks');
  const threshInput = document.createElement('input');
  threshInput.type = 'number';
  threshInput.min = '0';
  threshInput.value = String(initial?.minTunebooks ?? DEFAULT_MIN_TUNEBOOKS);
  threshInput.className = 'w-16 text-xs px-2 py-1 rounded border border-border bg-bg text-primary';
  threshWrap.append(threshLabel, threshInput);
  controls.appendChild(threshWrap);

  const rowCountEl = document.createElement('span');
  rowCountEl.className = 'text-xs text-dim ml-auto';
  controls.appendChild(rowCountEl);

  // ── List ─────────────────────────────────────────────────────────────────
  const list = document.createElement('div');
  list.className = 'space-y-2';
  host.body.appendChild(list);

  const sentinel = document.createElement('div');
  sentinel.className = 'h-4';
  list.appendChild(sentinel);

  // ── State ────────────────────────────────────────────────────────────────
  let dbState: PopularityDb | null = null;
  let startIdx = 0;
  let endIdx = 0;
  let gainMode: GainMode = initial?.gainMode ?? 'percent';
  let allRows: TuneRow[] = [];
  let revealed = 0;
  let loading = false;
  const tuneCache = new Map<number, TuneResult>();

  const absBtn = document.createElement('button');
  const pctBtn = document.createElement('button');
  function gainBtnClass(active: boolean): string {
    return active
      ? 'text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent cursor-pointer'
      : 'text-[10px] px-1.5 py-0.5 rounded text-dim hover:text-muted cursor-pointer transition-colors';
  }
  function updateGainButtons(): void {
    absBtn.className = gainBtnClass(gainMode === 'absolute');
    pctBtn.className = gainBtnClass(gainMode === 'percent');
  }
  absBtn.textContent = t('trending.gainAbsolute');
  pctBtn.textContent = t('trending.gainPercent');
  absBtn.onclick = () => { gainMode = 'absolute'; updateGainButtons(); recompute(); updateRoute(); };
  pctBtn.onclick = () => { gainMode = 'percent'; updateGainButtons(); recompute(); updateRoute(); };
  updateGainButtons();
  gainRow.append(absBtn, pctBtn);

  threshInput.oninput = () => { recompute(); updateRoute(); };

  fromInput.onchange = () => {
    if (!dbState || !fromInput.value) return;
    startIdx = closestSnapshotIndex(dbState.snapshots, new Date(fromInput.value).getTime());
    syncDateInputs();
    recompute();
    updateRoute();
  };
  toInput.onchange = () => {
    if (!dbState || !toInput.value) return;
    endIdx = closestSnapshotIndex(dbState.snapshots, new Date(toInput.value).getTime());
    syncDateInputs();
    recompute();
    updateRoute();
  };

  // Persists the current filter params (not the deck-picker target, which
  // stays session-only) into the route — via replaceRoute, not navigate, so
  // tweaking a filter doesn't spam the back-stack. Restored by views/trending.tsx.
  function updateRoute(): void {
    if (!dbState) return;
    replaceRoute({
      view: 'trending',
      from: fromInput.value || undefined,
      to: toInput.value || undefined,
      gainMode,
      minTunebooks: Number(threshInput.value) || undefined,
    });
  }

  async function getTune(id: number): Promise<TuneResult> {
    const cached = tuneCache.get(id);
    if (cached) return cached;
    const tune = await fetchTuneById(id);
    tuneCache.set(id, tune);
    return tune;
  }

  function buildRow(row: TuneRow, rank: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'flex items-center gap-3 p-2.5 rounded-lg border border-border bg-bg';

    const rankEl = document.createElement('span');
    rankEl.className = 'text-xs text-dim w-6 text-right shrink-0';
    rankEl.textContent = String(rank);
    el.appendChild(rankEl);

    const externalId = `thesession:${row.id}`;
    const known = findByExternalId(externalId, appState.value.cards);

    // Icons to the left of the name, same order/placement as the session
    // module's annotationCard row (ABC preview, then add-to-Cadence).
    const sheetBtn = document.createElement('button');
    sheetBtn.className = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20';
    sheetBtn.title = t('trending.viewSheet');
    sheetBtn.appendChild(iconElement(MusicNoteIcon, 12));
    sheetBtn.onclick = async () => {
      sheetBtn.disabled = true;
      sheetBtn.classList.add('opacity-50');
      try {
        const tune = await getTune(row.id);
        if (tune.settings.length > 0) showPreviewModal(settingsToMergedAbcFile(tune.settings, tune));
      } catch {
        sheetBtn.title = t('trending.detailLoadError');
      } finally {
        sheetBtn.disabled = false;
        sheetBtn.classList.remove('opacity-50');
      }
    };
    el.appendChild(sheetBtn);

    if (!known) {
      const addBtn = document.createElement('button');
      addBtn.className = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20';
      addBtn.title = t('trending.add');
      addBtn.appendChild(iconElement(PlusIcon, 12));
      const doAdd = async () => {
        addBtn.disabled = true;
        addBtn.classList.add('opacity-50');
        try {
          const existing = findByExternalId(externalId, appState.value.cards);
          if (!existing) {
            const tune = await getTune(row.id);
            const card = tuneResultToCard(tune);
            await mutate(s => {
              s.cards[card.id] = card;
              for (const deckId of getTargetDeckIds() ?? []) {
                const deck = s.decks[deckId];
                if (deck && !deck.entries.some(e => e.cardId === card.id)) deck.entries.push({ cardId: card.id });
              }
            });
          }
          el.replaceWith(buildRow(row, rank));
        } catch {
          addBtn.disabled = false;
          addBtn.classList.remove('opacity-50');
          addBtn.title = t('trending.addFailed');
        }
      };
      addBtn.onclick = () => {
        if (getTargetDeckIds() === undefined) {
          const ids = ensureTargetDeckIds();
          updateDeckBtn();
          showDeckPickerPopover(ids, updateDeckBtn, () => { void doAdd(); });
        } else {
          void doAdd();
        }
      };
      el.appendChild(addBtn);
    } else {
      // Card already exists: offer a quick link into the target deck(s)
      // instead — additive only, never unlinks from decks not selected.
      const linkBtn = document.createElement('button');
      linkBtn.className = 'w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20';
      linkBtn.title = t('trending.linkToDeck');
      linkBtn.innerHTML = deckLinkIcon;
      const doLink = async () => {
        linkBtn.disabled = true;
        linkBtn.classList.add('opacity-50');
        try {
          await mutate(s => {
            for (const deckId of getTargetDeckIds() ?? []) {
              const deck = s.decks[deckId];
              if (deck && !deck.entries.some(e => e.cardId === known.id)) deck.entries.push({ cardId: known.id });
            }
          });
        } finally {
          linkBtn.disabled = false;
          linkBtn.classList.remove('opacity-50');
        }
      };
      linkBtn.onclick = () => {
        if (getTargetDeckIds() === undefined) {
          const ids = ensureTargetDeckIds();
          updateDeckBtn();
          showDeckPickerPopover(ids, updateDeckBtn, () => { void doLink(); });
        } else {
          void doLink();
        }
      };
      el.appendChild(linkBtn);
    }

    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    el.appendChild(info);

    const nameRow = document.createElement('div');
    nameRow.className = 'flex items-center gap-1.5 min-w-0';
    if (known) {
      const nameEl = document.createElement('span');
      nameEl.className = 'text-sm text-primary truncate cursor-pointer hover:text-accent transition-colors';
      nameEl.textContent = row.name;
      nameEl.onclick = () => navigate({ view: 'card', cardId: known.id });
      nameRow.appendChild(nameEl);
    } else {
      const link = document.createElement('a');
      link.className = 'text-sm text-primary truncate hover:text-accent transition-colors';
      link.textContent = row.name;
      link.href = externalSourceLink(externalId)!.url;
      link.target = '_blank';
      link.rel = 'noopener';
      nameRow.appendChild(link);
    }
    info.appendChild(nameRow);

    const meta = document.createElement('div');
    meta.className = 'text-xs text-dim';
    meta.textContent = t('trending.tunebooks', { n: row.endValue });
    info.appendChild(meta);

    const gainEl = document.createElement('span');
    gainEl.className = `text-xs font-semibold shrink-0 ${row.gain >= 0 ? 'text-success' : 'text-danger'}`;
    gainEl.textContent = formatGain(row, gainMode);
    el.appendChild(gainEl);

    const spark = buildSparkline(row.periodValues, { width: 50, height: 22 });
    spark.classList.add('shrink-0');
    el.appendChild(spark);

    return el;
  }

  let observer: IntersectionObserver | null = null;
  function revealMore(): void {
    const next = allRows.slice(revealed, revealed + PAGE_SIZE);
    for (let i = 0; i < next.length; i++) list.insertBefore(buildRow(next[i]!, revealed + i + 1), sentinel);
    revealed += next.length;
    sentinel.style.display = revealed >= allRows.length ? 'none' : '';
  }

  observer = new IntersectionObserver(entries => {
    if (entries[0]?.isIntersecting) revealMore();
  });
  observer.observe(sentinel);
  host.registerCleanup(() => observer?.disconnect());

  function recompute(): void {
    if (!dbState) return;
    const minEnd = Math.max(0, Number(threshInput.value) || 0);
    allRows = sortRows(computeRows(dbState, startIdx, endIdx, minEnd), gainMode);
    revealed = 0;
    list.replaceChildren(sentinel);
    sentinel.style.display = '';
    revealMore();
    rowCountEl.textContent = t('trending.rowCount', { n: allRows.length });
  }

  function syncDateInputs(): void {
    if (!dbState) return;
    const minDate = toDateInputValue(dbState.snapshots[0]!);
    const maxDate = toDateInputValue(dbState.snapshots[dbState.snapshots.length - 1]!);
    fromInput.min = minDate; fromInput.max = maxDate;
    toInput.min = minDate; toInput.max = maxDate;
    fromInput.value = toDateInputValue(dbState.snapshots[startIdx]!);
    toInput.value = toDateInputValue(dbState.snapshots[endIdx]!);
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    refreshBtn.classList.add('opacity-50', 'pointer-events-none');
    status.textContent = t('trending.syncing', { done: 0, total: 0 });

    const isFirstLoad = dbState === null;
    const prevLen = dbState?.snapshots.length ?? 0;
    const wasLatest = dbState ? endIdx === prevLen - 1 : true;

    try {
      const onProgress = (p: SyncProgress) => {
        if (p.total > 0) status.textContent = t('trending.syncing', { done: p.done, total: p.total });
      };
      dbState = await syncPopularityHistory(onProgress);

      if (dbState.snapshots.length === 0) {
        status.textContent = t('trending.empty');
        return;
      }

      if (isFirstLoad) {
        const latestTime = new Date(dbState.snapshots[dbState.snapshots.length - 1]!).getTime();
        startIdx = initial?.from
          ? closestSnapshotIndex(dbState.snapshots, new Date(initial.from).getTime())
          : closestSnapshotIndex(dbState.snapshots, latestTime - DEFAULT_WINDOW_DAYS * 86400000);
        endIdx = initial?.to
          ? closestSnapshotIndex(dbState.snapshots, new Date(initial.to).getTime())
          : dbState.snapshots.length - 1;
      } else {
        if (wasLatest) endIdx = dbState.snapshots.length - 1;
        startIdx = Math.min(startIdx, dbState.snapshots.length - 1);
      }

      controls.style.display = '';
      syncDateInputs();
      recompute();
      updateRoute();
      status.textContent = t('trending.updated', { time: timeAgo(new Date(dbState.snapshots[dbState.snapshots.length - 1]!).getTime()) });
    } catch {
      status.textContent = t('trending.loadError');
    } finally {
      loading = false;
      refreshBtn.classList.remove('opacity-50', 'pointer-events-none');
    }
  }

  refreshBtn.onclick = () => void load();
  void load();
}
