import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { FlameIcon, ResetIcon, MusicNoteIcon, PlusIcon } from '../../components/icons';
import { showDeckChoiceModal, decksContainingCard, hasAnyDeck, isInEveryDeck, deckLinkIcon } from '../../components/deckSelector';
import { showPreviewModal } from '../../components/fileViewer';
import { computeRows, sortRows, formatGain, type TuneRow, type GainMode } from '../../services/trendingService';
import { syncPopularityHistory, type SyncProgress } from '../../services/trendingSyncService';
import {
  fetchTuneById, tuneResultToCard, findByExternalId, settingsToMergedAbcFile, type TuneResult,
} from '../../services/theSessionService';
import type { PopularityDb } from '../db';
import type { Card } from '../../types';
import { appState, mutate, navigate, replaceRoute } from '../../store';
import { timeAgo, externalSourceLink } from '../../utils';
import { Sparkline } from './sparkline';

export interface TrendingRouteParams {
  from?: string;
  to?: string;
  gainMode?: GainMode;
  minTunebooks?: number;
}

// ── Trending module UI (routed page under Modules) ────────────────────────────
// Explorer over TheSession's popularity history, ported from the local
// TheSession_PopularityExplorer tool (free date range, absolute/percent gain,
// per-row sparkline) but adapted to Cadence's mobile-first / no-new-dependency
// conventions. Per-row actions (sheet music, add to Cadence) and the shared
// deck-target picker mirror the session module's DetectionCard exactly,
// rather than a separate detail screen.

const PAGE_SIZE = 50;
const DEFAULT_MIN_TUNEBOOKS = 300;
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

function gainBtnClass(active: boolean): string {
  return active
    ? 'text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent cursor-pointer'
    : 'text-[10px] px-1.5 py-0.5 rounded text-dim hover:text-muted cursor-pointer transition-colors';
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface RowProps {
  row: TuneRow;
  rank: number;
  gainMode: GainMode;
  getTune: (id: number) => Promise<TuneResult>;
  /** Decks pinned on this page — ticked again in the deck choice modal, which
   *  opens on every add and every link (see components/deckSelector.tsx). */
  getPinnedDeckIds: () => Set<string>;
}

function TrendingRow({ row, rank, gainMode, getTune, getPinnedDeckIds }: RowProps) {
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState(false);

  const externalId = `thesession:${row.id}`;
  const known = findByExternalId(externalId, appState.value.cards);

  const doViewSheet = async () => {
    setSheetBusy(true);
    try {
      const tune = await getTune(row.id);
      if (tune.settings.length > 0) showPreviewModal(settingsToMergedAbcFile(tune.settings, tune));
      setSheetError(false);
    } catch {
      setSheetError(true);
    } finally {
      setSheetBusy(false);
    }
  };

  /** Writes an already-fetched card — the tune is downloaded BEFORE the deck
   *  question, so a failed lookup never wastes the answer and dismissing the
   *  modal imports nothing. The externalId is re-checked inside the transaction
   *  because that gap is wide enough for the tune to arrive by another route. */
  const commitAdd = async (card: Card, deckIds: string[]) => {
    setActionBusy(true);
    try {
      await mutate(s => {
        const existing = findByExternalId(externalId, s.cards);
        const id = existing?.id ?? card.id;
        if (!existing) s.cards[id] = card;
        for (const deckId of deckIds) {
          const deck = s.decks[deckId];
          if (deck && !deck.entries.some(e => e.cardId === id)) deck.entries.push({ cardId: id });
        }
      });
      setActionError(false);
    } catch {
      setActionError(true);
    } finally {
      setActionBusy(false);
    }
  };

  const doLink = async (deckIds: string[]) => {
    if (!known) return;
    setActionBusy(true);
    try {
      await mutate(s => {
        for (const deckId of deckIds) {
          const deck = s.decks[deckId];
          if (deck && !deck.entries.some(e => e.cardId === known.id)) deck.entries.push({ cardId: known.id });
        }
      });
    } finally {
      setActionBusy(false);
    }
  };

  // Same rule as the session feed: ask every time, and skip the question only
  // when there is no deck to ask about.
  const onAddClick = () => {
    void (async () => {
      setActionBusy(true);
      let card: Card;
      try {
        card = tuneResultToCard(await getTune(row.id));
        setActionError(false);
      } catch {
        setActionError(true);
        setActionBusy(false);
        return;
      }
      setActionBusy(false);
      if (!hasAnyDeck()) { void commitAdd(card, []); return; }
      showDeckChoiceModal({ pinned: getPinnedDeckIds(), onConfirm: (ids) => { void commitAdd(card, ids); } });
    })();
  };

  const onLinkClick = () => {
    if (!known) return;
    showDeckChoiceModal({
      pinned: getPinnedDeckIds(),
      alreadyIn: decksContainingCard(known.id),
      onConfirm: (ids) => { void doLink(ids); },
    });
  };

  return (
    <div class="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-bg">
      <span class="text-xs text-dim w-6 text-right shrink-0">{rank}</span>

      {/* Icons to the left of the name, same order/placement as the session
         module's DetectionCard row (ABC preview, then add-to-Cadence). */}
      <button
        class="w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
        title={sheetError ? t('trending.detailLoadError') : t('trending.viewSheet')}
        disabled={sheetBusy}
        onClick={() => void doViewSheet()}
      >
        <MusicNoteIcon size={12} />
      </button>

      {known ? hasAnyDeck() && (
        // Card already exists: offer to put it in a deck instead — additive
        // only, never unlinks from decks left unticked. With no deck at all
        // there is nothing to offer, so the button is not rendered.
        <button
          class={`w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 ${isInEveryDeck(known.id) ? 'opacity-40' : ''}`}
          title={isInEveryDeck(known.id) ? t('deckChoice.inEveryDeck') : t('trending.linkToDeck')}
          disabled={actionBusy}
          dangerouslySetInnerHTML={{ __html: deckLinkIcon }}
          onClick={onLinkClick}
        />
      ) : (
        <button
          class="w-6 h-6 p-0 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
          title={actionError ? t('trending.addFailed') : t('trending.add')}
          disabled={actionBusy}
          onClick={onAddClick}
        >
          <PlusIcon size={12} />
        </button>
      )}

      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5 min-w-0">
          {known ? (
            <span
              class="text-sm text-primary truncate cursor-pointer hover:text-accent transition-colors"
              onClick={() => navigate({ view: 'card', cardId: known.id })}
            >
              {row.name}
            </span>
          ) : (
            <a
              class="text-sm text-primary truncate hover:text-accent transition-colors"
              href={externalSourceLink(externalId)!.url}
              target="_blank"
              rel="noopener"
            >
              {row.name}
            </a>
          )}
        </div>
        <div class="text-xs text-dim">{t('trending.tunebooks', { n: row.endValue })}</div>
      </div>

      <span class={`text-xs font-semibold shrink-0 ${row.gain >= 0 ? 'text-success' : 'text-danger'}`}>{formatGain(row, gainMode)}</span>

      <Sparkline values={row.periodValues} width={50} height={22} class="shrink-0" />
    </div>
  );
}

// ── Module ────────────────────────────────────────────────────────────────────

export function TrendingModule({ initial }: { initial?: TrendingRouteParams }) {
  const [dbState, setDbState] = useState<PopularityDb | null>(null);
  const [startIdx, setStartIdx] = useState(0);
  const [endIdx, setEndIdx] = useState(0);
  const [gainMode, setGainMode] = useState<GainMode>(initial?.gainMode ?? 'percent');
  const [threshValue, setThreshValue] = useState(String(initial?.minTunebooks ?? DEFAULT_MIN_TUNEBOOKS));
  const [allRows, setAllRows] = useState<TuneRow[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const loadingRef = useRef(false);

  const tuneCacheRef = useRef(new Map<number, TuneResult>());
  const getTune = async (id: number): Promise<TuneResult> => {
    const cached = tuneCacheRef.current.get(id);
    if (cached) return cached;
    const tune = await fetchTuneById(id);
    tuneCacheRef.current.set(id, tune);
    return tune;
  };

  // Decks pinned in the deck choice modal, shared across every "+" on this
  // screen and lasting only as long as it stays open — same rule as the
  // sessions module (see components/deckSelector.tsx).
  const pinnedDeckIdsRef = useRef<Set<string>>(new Set());

  const recompute = (db: PopularityDb, gm: GainMode, th: string, si: number, ei: number) => {
    const minEnd = Math.max(0, Number(th) || 0);
    const rows = sortRows(computeRows(db, si, ei, minEnd), gm);
    setAllRows(rows);
    setRevealed(Math.min(PAGE_SIZE, rows.length));
  };

  // Persists the current filter params (not the deck-picker target, which
  // stays session-only) into the route — via replaceRoute, not navigate, so
  // tweaking a filter doesn't spam the back-stack. Restored on next mount.
  const pushRoute = (db: PopularityDb, gm: GainMode, th: string, si: number, ei: number) => {
    replaceRoute({
      view: 'trending',
      from: db.snapshots[si] ? toDateInputValue(db.snapshots[si]!) : undefined,
      to: db.snapshots[ei] ? toDateInputValue(db.snapshots[ei]!) : undefined,
      gainMode: gm,
      minTunebooks: Number(th) || undefined,
    });
  };

  const load = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setStatus(t('trending.checking', { n: 0 }));

    const isFirstLoad = dbState === null;
    const prevLen = dbState?.snapshots.length ?? 0;
    const wasLatest = dbState ? endIdx === prevLen - 1 : true;

    try {
      const onProgress = (p: SyncProgress) => {
        setStatus(p.phase === 'checking' ? t('trending.checking', { n: p.found }) : t('trending.syncing', { done: p.done, total: p.total }));
      };
      const db = await syncPopularityHistory(onProgress);
      setDbState(db);

      if (db.snapshots.length === 0) {
        setStatus(t('trending.empty'));
        return;
      }

      let si: number, ei: number;
      if (isFirstLoad) {
        const latestTime = new Date(db.snapshots[db.snapshots.length - 1]!).getTime();
        si = initial?.from
          ? closestSnapshotIndex(db.snapshots, new Date(initial.from).getTime())
          : closestSnapshotIndex(db.snapshots, latestTime - DEFAULT_WINDOW_DAYS * 86400000);
        ei = initial?.to
          ? closestSnapshotIndex(db.snapshots, new Date(initial.to).getTime())
          : db.snapshots.length - 1;
      } else {
        ei = wasLatest ? db.snapshots.length - 1 : Math.min(endIdx, db.snapshots.length - 1);
        si = Math.min(startIdx, db.snapshots.length - 1);
      }

      setStartIdx(si);
      setEndIdx(ei);
      recompute(db, gainMode, threshValue, si, ei);
      pushRoute(db, gainMode, threshValue, si, ei);
      setStatus(t('trending.updated', { time: timeAgo(new Date(db.snapshots[db.snapshots.length - 1]!).getTime()) }));
    } catch {
      setStatus(t('trending.loadError'));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-line */ }, []);

  const allRowsRef = useRef<TuneRow[]>([]);
  useEffect(() => { allRowsRef.current = allRows; }, [allRows]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) setRevealed(r => Math.min(r + PAGE_SIZE, allRowsRef.current.length));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div class="p-6">
      <div class="flex items-center justify-between mb-1">
        <h1 class="text-xl font-semibold text-primary flex items-center gap-2">
          <FlameIcon size={18} />
          {t('trending.title')}
        </h1>
        <div class="flex items-center gap-3 shrink-0">
          <button
            class={`text-dim hover:text-accent transition-colors cursor-pointer ${loading ? 'opacity-50 pointer-events-none' : ''}`}
            title={t('trending.refresh')}
            onClick={() => void load()}
          >
            <ResetIcon size={14} />
          </button>
        </div>
      </div>

      <div class="text-xs text-dim mb-3">{status}</div>

      {dbState && dbState.snapshots.length > 0 && (
        <div class="flex flex-wrap items-center gap-3 mb-3">
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-dim">{t('trending.from')}</span>
            <input
              type="date"
              class="text-xs px-2 py-1 rounded border border-border bg-bg text-primary"
              min={toDateInputValue(dbState.snapshots[0]!)}
              max={toDateInputValue(dbState.snapshots[dbState.snapshots.length - 1]!)}
              value={toDateInputValue(dbState.snapshots[startIdx]!)}
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).value;
                if (!v) return;
                const si = closestSnapshotIndex(dbState.snapshots, new Date(v).getTime());
                setStartIdx(si);
                recompute(dbState, gainMode, threshValue, si, endIdx);
                pushRoute(dbState, gainMode, threshValue, si, endIdx);
              }}
            />
          </div>

          <div class="flex items-center gap-1.5">
            <span class="text-xs text-dim">{t('trending.to')}</span>
            <input
              type="date"
              class="text-xs px-2 py-1 rounded border border-border bg-bg text-primary"
              min={toDateInputValue(dbState.snapshots[0]!)}
              max={toDateInputValue(dbState.snapshots[dbState.snapshots.length - 1]!)}
              value={toDateInputValue(dbState.snapshots[endIdx]!)}
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).value;
                if (!v) return;
                const ei = closestSnapshotIndex(dbState.snapshots, new Date(v).getTime());
                setEndIdx(ei);
                recompute(dbState, gainMode, threshValue, startIdx, ei);
                pushRoute(dbState, gainMode, threshValue, startIdx, ei);
              }}
            />
          </div>

          <div class="flex gap-1">
            <button
              class={gainBtnClass(gainMode === 'absolute')}
              onClick={() => {
                setGainMode('absolute');
                recompute(dbState, 'absolute', threshValue, startIdx, endIdx);
                pushRoute(dbState, 'absolute', threshValue, startIdx, endIdx);
              }}
            >
              {t('trending.gainAbsolute')}
            </button>
            <button
              class={gainBtnClass(gainMode === 'percent')}
              onClick={() => {
                setGainMode('percent');
                recompute(dbState, 'percent', threshValue, startIdx, endIdx);
                pushRoute(dbState, 'percent', threshValue, startIdx, endIdx);
              }}
            >
              {t('trending.gainPercent')}
            </button>
          </div>

          <div class="flex items-center gap-1.5">
            <span class="text-xs text-dim">{t('trending.minTunebooks')}</span>
            <input
              type="number"
              min="0"
              class="w-16 text-xs px-2 py-1 rounded border border-border bg-bg text-primary"
              value={threshValue}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setThreshValue(v);
                recompute(dbState, gainMode, v, startIdx, endIdx);
                pushRoute(dbState, gainMode, v, startIdx, endIdx);
              }}
            />
          </div>

          <span class="text-xs text-dim ml-auto">{t('trending.rowCount', { n: allRows.length })}</span>
        </div>
      )}

      <div class="space-y-2">
        {allRows.slice(0, revealed).map((row, i) => (
          <TrendingRow
            key={row.id}
            row={row}
            rank={i + 1}
            gainMode={gainMode}
            getTune={getTune}
            getPinnedDeckIds={() => pinnedDeckIdsRef.current}
          />
        ))}
        <div ref={sentinelRef} class="h-4" style={{ display: revealed >= allRows.length ? 'none' : undefined }} />
      </div>
    </div>
  );
}
