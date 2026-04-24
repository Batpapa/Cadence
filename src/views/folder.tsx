import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { appState, navigate, mutate, getContext } from '../store';
import { generateId, trashIcon, DAY_NAMES_KEYS, timeAgo, pct } from '../utils';
import { promptModal, confirmModal } from '../components/modal';
import { showCreateDeckModal } from '../components/sidebar';
import { findParentFolder, deckPath } from '../services/deckService';
import { replayFSRS, fsrsRetrievability, retentionWindowDays } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';
import type { AppState, CardWork } from '../types';

// ── Local bridge ──────────────────────────────────────────────────────────────

function SvgIcon({ icon }: { icon: SVGSVGElement }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { ref.current!.replaceChildren(icon); });
  return <span ref={ref} />;
}

// ── Pure helpers (unchanged from vanilla) ─────────────────────────────────────

function formatDays(d: number): string {
  if (d >= 365) return t('common.durationYears',  { n: (d / 365).toFixed(1) });
  if (d >= 30)  return t('common.durationMonths', { n: Math.round(d / 30) });
  if (d >= 1)   return t('common.durationDays',   { n: Math.round(d) });
  return t('common.durationLessThanDay');
}

function studyStreak(works: Record<string, CardWork>): number {
  const days = new Set<string>();
  for (const w of Object.values(works))
    for (const e of w.history) days.add(new Date(e.ts).toDateString());
  let streak = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

function sessionsLastNDays(works: Record<string, CardWork>, n: number): number[] {
  const counts = Array<number>(n).fill(0);
  const now = Date.now();
  for (const w of Object.values(works))
    for (const e of w.history) {
      const i = n - 1 - Math.floor((now - e.ts) / 86400000);
      if (i >= 0 && i < n) counts[i]++;
    }
  return counts;
}

function sessionsLastNWeeks(works: Record<string, CardWork>, n: number): number[] {
  const counts = Array<number>(n).fill(0);
  const now = Date.now();
  for (const w of Object.values(works))
    for (const e of w.history) {
      const i = n - 1 - Math.floor((now - e.ts) / (7 * 86400000));
      if (i >= 0 && i < n) counts[i]++;
    }
  return counts;
}

type ActivityPeriod = '7d' | '30d' | '1y';

// ── Activity bars (JSX) ───────────────────────────────────────────────────────

function ActivityBars({ works, period }: { works: Record<string, CardWork>; period: ActivityPeriod }) {
  const data = period === '1y' ? sessionsLastNWeeks(works, 52) : sessionsLastNDays(works, period === '30d' ? 30 : 7);
  const max  = Math.max(...data, 1);
  const minH = period === '1y' ? 2 : 4;

  return (
    <div class="flex gap-0.5 items-end">
      {data.map((count, i) => {
        const h     = Math.max(minH, Math.round((count / max) * 40));
        const title = t(count !== 1 ? 'dashboard.sessions' : 'dashboard.session', { count });
        if (period === '7d') {
          const d = new Date(); d.setDate(d.getDate() - (6 - i));
          return (
            <div key={i} class="flex flex-col items-center gap-1 flex-1">
              <div class={`rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`} style={{ height: `${h}px` }} title={title} />
              <div class="text-[9px] text-dim">{t(DAY_NAMES_KEYS[d.getDay()]!)}</div>
            </div>
          );
        }
        return (
          <div key={i} class="flex flex-col items-center gap-1 flex-1">
            <div class={`rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`} style={{ height: `${h}px` }} title={title} />
          </div>
        );
      })}
    </div>
  );
}

// ── Card map SVG builder (vanilla, unchanged) ─────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';
const mkEl = (tag: string, attrs: Record<string, string>) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const mkText = (x: number, y: number, content: string, anchor: string, size = '8') => {
  const el = mkEl('text', { x: String(x), y: String(y), 'text-anchor': anchor, 'font-size': size, fill: '#555555', 'font-family': 'IBM Plex Mono, monospace' });
  el.textContent = content; return el;
};

type Point = { id: string; name: string; s: number; ease: number; k: number; imp: number; deckIds: string[] };

const H = 240;
const padL = 38, padR = 14, padT = 12, padB = 30;
const xMin = 0.5, xMax = 730;
const logXMin = Math.log(xMin), logXMax = Math.log(xMax);
const rScale  = (imp: number) => Math.sqrt(Math.max(1, Math.min(10, Math.log10(Math.max(1, imp)))));
const dotColor = (k: number) => k >= 0.75 ? '#4ade80' : k >= 0.4 ? '#fbbf24' : '#f87171';
const xTicks: Array<{ val: number; labelKey: string }> = [
  { val: 1,   labelKey: 'dashboard.period.1d'  },
  { val: 7,   labelKey: 'dashboard.period.7d'  },
  { val: 30,  labelKey: 'dashboard.period.30d' },
  { val: 180, labelKey: 'dashboard.period.6mo' },
  { val: 365, labelKey: 'dashboard.period.1y'  },
];

function buildSvg(
  W: number,
  pts: Point[],
  onHover: (pt: Point, cx: number, cy: number, W: number) => void,
  onLeave: () => void,
): SVGSVGElement {
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xScale = (s: number) => padL + (Math.log(Math.max(xMin, Math.min(xMax, s))) - logXMin) / (logXMax - logXMin) * plotW;
  const yScale = (e: number) => padT + plotH * (1 - Math.max(0, Math.min(1, e)));

  const svg = mkEl('svg', { width: String(W), height: String(H) }) as SVGSVGElement;

  for (const tick of [0, 0.25, 0.5, 0.75, 1.0]) {
    const y = yScale(tick);
    svg.append(mkEl('line', { x1: String(padL), x2: String(W - padR), y1: String(y), y2: String(y), stroke: '#252525', 'stroke-width': '1' }));
    svg.append(mkText(padL - 5, y + 3.5, `${Math.round(tick * 100)}%`, 'end'));
  }
  for (const { val, labelKey } of xTicks) {
    const x = xScale(val);
    svg.append(mkEl('line', { x1: String(x), x2: String(x), y1: String(padT), y2: String(padT + plotH), stroke: '#252525', 'stroke-width': '1' }));
    svg.append(mkText(x, H - padB + 12, t(labelKey), 'middle'));
  }
  svg.append(mkEl('rect', { x: String(padL), y: String(padT), width: String(plotW), height: String(plotH), fill: 'none', stroke: '#333333', 'stroke-width': '1' }));

  for (const pt of [...pts].sort((a, b) => b.imp - a.imp)) {
    const color  = dotColor(pt.k);
    const circle = mkEl('circle', {
      cx: String(xScale(pt.s)), cy: String(yScale(pt.ease)), r: String(rScale(pt.imp)),
      fill: color, 'fill-opacity': '0.7', stroke: color, 'stroke-opacity': '0.35', 'stroke-width': '1.5',
    });
    (circle as unknown as HTMLElement).style.cursor = 'pointer';
    circle.addEventListener('mouseenter', () => onHover(pt, parseFloat(circle.getAttribute('cx') ?? '0'), parseFloat(circle.getAttribute('cy') ?? '0'), W));
    circle.addEventListener('mouseleave', onLeave);
    circle.addEventListener('click', () => navigate({ view: 'card', cardId: pt.id }));
    svg.append(circle);
  }

  svg.append(mkText(padL + plotW / 2, H - 2, t('deck.section.stability'), 'middle', '10'));
  const yLbl = mkEl('text', { x: '0', y: '0', 'text-anchor': 'middle', 'font-size': '10', fill: '#555555', 'font-family': 'IBM Plex Mono, monospace', transform: `rotate(-90) translate(${-(padT + plotH / 2)}, 9)` });
  yLbl.textContent = t('deck.section.ease');
  svg.append(yLbl);
  svg.addEventListener('mouseleave', onLeave);
  return svg;
}

// ── Card map component ────────────────────────────────────────────────────────

const CHIP_ACTIVE = 'text-xs px-2 py-0.5 rounded-full border bg-accent text-white border-accent cursor-pointer transition-colors';
const CHIP_IDLE   = 'text-xs px-2 py-0.5 rounded-full border border-border text-muted hover:border-accent hover:text-accent cursor-pointer transition-colors';
const NO_DECK     = '__no_deck__';

function CardMapSection({ state }: { state: AppState }) {
  const user = getCurrentUser(state);

  // Compute all reviewable points
  const cardToDecks = new Map<string, string[]>();
  for (const deck of Object.values(state.decks))
    for (const entry of deck.entries) {
      const arr = cardToDecks.get(entry.cardId) ?? [];
      arr.push(deck.id);
      cardToDecks.set(entry.cardId, arr);
    }

  const allPoints: Point[] = [];
  for (const card of Object.values(state.cards)) {
    const work = state.cardWorks[`${state.currentProfileId}:${card.id}`];
    if (!work || work.history.length === 0) continue;
    const fsrs = replayFSRS(work.history);
    if (!fsrs) continue;
    const ease      = (10 - fsrs.difficulty) / 9;
    const elapsed   = (Date.now() - fsrs.lastTs) / 86400000;
    const k         = fsrsRetrievability(elapsed, fsrs.stability);
    const retWindow = retentionWindowDays(fsrs.stability, user.availabilityThreshold);
    allPoints.push({ id: card.id, name: card.name, s: retWindow, ease, k, imp: card.importance, deckIds: cardToDecks.get(card.id) ?? [] });
  }

  const deckList   = Object.values(state.decks).filter(d => allPoints.some(p => p.deckIds.includes(d.id))).sort((a, b) => a.name.localeCompare(b.name));
  const hasOrphans = allPoints.some(p => p.deckIds.length === 0);

  const [selectedDecks, setSelectedDecks] = useState<Set<string>>(
    new Set([...deckList.map(d => d.id), ...(hasOrphans ? [NO_DECK] : [])])
  );

  const svgRef      = useRef<HTMLDivElement>(null);
  const tooltipRef  = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedDecks);
  const lastWRef    = useRef(0);
  selectedRef.current = selectedDecks;

  // Tooltip helpers (vanilla — ref-controlled to avoid fighting Preact)
  const rColor = (k: number) => k >= 0.75 ? '#4ade80' : k >= 0.4 ? '#fbbf24' : '#f87171';
  const eColor = (e: number) => e >= 0.6  ? '#4ade80' : e >= 0.35 ? '#fbbf24' : '#f87171';

  const showTooltip = (pt: Point, dotX: number, dotY: number, svgW: number) => {
    const tip = tooltipRef.current; if (!tip) return;
    tip.style.left    = dotX > svgW * 0.6 ? `${dotX - 188}px` : `${dotX + 12}px`;
    tip.style.top     = `${Math.max(0, dotY - 10)}px`;
    tip.style.display = 'block';
    const deckNames = pt.deckIds.map(id => state.decks[id]?.name).filter(Boolean).join(', ');
    const lastWork  = state.cardWorks[`${state.currentProfileId}:${pt.id}`];
    const lastTs    = lastWork?.history.at(-1)?.ts;
    tip.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#e8e8e8;margin-bottom:4px;line-height:1.3">${pt.name}</div>
      <div style="font-size:10px;color:#555;margin-bottom:8px">${deckNames ? deckNames + ' · ' : ''}${lastTs ? timeAgo(lastTs) : t('card.neverReviewed')}</div>
      <div style="display:flex;flex-direction:column;gap:3px">
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.08em">Retention</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:${rColor(pt.k)};font-weight:500">${pct(pt.k)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.08em">Stability</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:#e8e8e8;font-weight:500">${formatDays(pt.s)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.08em">Ease</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:${eColor(pt.ease)};font-weight:500">${pct(pt.ease)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:0.08em">Weight</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:#e8e8e8;font-weight:500">×${pt.imp}</span></div>
      </div>`;
  };
  const hideTooltip = () => { const tip = tooltipRef.current; if (tip) tip.style.display = 'none'; };

  // ref to always-fresh rebuild function (avoids stale closure in ResizeObserver)
  const rebuildRef = useRef<() => void>(() => {});
  rebuildRef.current = () => {
    const w = lastWRef.current;
    const container = svgRef.current;
    if (w <= 0 || !container) return;
    hideTooltip();

    const sel  = selectedRef.current;
    const seen = new Set<string>();
    const visible: Point[] = [];
    for (const pt of allPoints) {
      if (seen.has(pt.id)) continue;
      const show = pt.deckIds.length === 0 ? sel.has(NO_DECK) : pt.deckIds.some(d => sel.has(d));
      if (show) { seen.add(pt.id); visible.push(pt); }
    }

    const newSvg = buildSvg(w, visible, showTooltip, hideTooltip);
    const old = container.querySelector('svg');
    if (old) old.replaceWith(newSvg); else container.insertBefore(newSvg, tooltipRef.current);
  };

  // ResizeObserver — permanent, calls rebuildRef.current (always fresh)
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      requestAnimationFrame(() => {
        const w = Math.floor(entries[0]!.contentRect.width);
        if (w <= 0) return;
        lastWRef.current = w;
        rebuildRef.current();
      });
    });
    if (!svgRef.current) return;
    obs.observe(svgRef.current);
    return () => obs.disconnect();
  }, []);

  // Rebuild when selectedDecks changes (or state changes, since this runs on every render)
  useLayoutEffect(() => { rebuildRef.current(); });

  if (allPoints.length === 0) {
    return <p class="text-xs text-dim italic text-center py-4">{t('card.neverReviewed')}</p>;
  }

  const toggleDeck = (id: string) => {
    setSelectedDecks(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div class="space-y-2">
      {/* Filter chips */}
      <div class="flex flex-wrap gap-1 items-center">
        <div class="flex gap-1 items-center border-r border-border pr-2 mr-0.5 shrink-0">
          <button class="text-[9px] text-dim hover:text-muted cursor-pointer transition-colors"
            onClick={() => setSelectedDecks(new Set([...deckList.map(d => d.id), ...(hasOrphans ? [NO_DECK] : [])]))}>
            {t('dashboard.filterAll')}
          </button>
          <button class="text-[9px] text-dim hover:text-muted cursor-pointer transition-colors"
            onClick={() => setSelectedDecks(new Set())}>
            {t('dashboard.filterNone')}
          </button>
        </div>
        {hasOrphans && (
          <button class={selectedDecks.has(NO_DECK) ? CHIP_ACTIVE : CHIP_IDLE} onClick={() => toggleDeck(NO_DECK)}>
            {t('library.filterNoDecks')}
          </button>
        )}
        {deckList.map(deck => (
          <button key={deck.id} class={selectedDecks.has(deck.id) ? CHIP_ACTIVE : CHIP_IDLE} title={deckPath(deck.id, state)} onClick={() => toggleDeck(deck.id)}>
            {deck.name}
          </button>
        ))}
      </div>

      {/* SVG container — tooltip is ref-managed (not Preact-controlled) */}
      <div ref={svgRef} style="position:relative">
        <div ref={tooltipRef} style="position:absolute;display:none;pointer-events:none;z-index:20;width:176px;background:#1a1a1a;border:1px solid #2e2e2e;border-radius:8px;padding:10px 12px;box-shadow:0 4px 24px rgba(0,0,0,0.6);font-family:'IBM Plex Sans',system-ui,sans-serif;" />
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ state }: { state: AppState }) {
  const [actPeriod, setActPeriod] = useState<ActivityPeriod>('7d');

  const allCards       = Object.values(state.cards);
  const totalSessions  = Object.values(state.cardWorks).reduce((s, w) => s + w.history.length, 0);
  const weekSessions   = sessionsLastNDays(state.cardWorks, 7).reduce((a, b) => a + b, 0);
  const streak         = studyStreak(state.cardWorks);
  const deckCount      = Object.keys(state.decks).length;

  const PERIOD_LABELS: Record<ActivityPeriod, string> = {
    '7d': t('dashboard.period.7d'), '30d': t('dashboard.period.30d'), '1y': t('dashboard.period.1y'),
  };

  return (
    <div class="space-y-5 pb-2">
      {/* Stats */}
      <div class="grid grid-cols-3 gap-3">
        {[
          { label: t('dashboard.cards'),    value: String(allCards.length),  sub: t(deckCount !== 1 ? 'dashboard.decks' : 'dashboard.deck', { count: deckCount }) },
          { label: t('dashboard.thisWeek'), value: String(weekSessions),     sub: t('dashboard.totalSessions', { count: totalSessions }) },
          { label: t('dashboard.streak'),   value: `${streak}d`,             sub: streak > 0 ? t('dashboard.streakKeep') : t('dashboard.streakStart') },
        ].map(({ label, value, sub }) => (
          <div key={label} class="card-block space-y-0.5">
            <div class="text-2xl font-mono font-semibold text-primary">{value}</div>
            <div class="text-xs text-muted">{label}</div>
            <div class="text-xs text-dim">{sub}</div>
          </div>
        ))}
      </div>

      {/* Activity chart */}
      <div class="card-block space-y-2">
        <div class="flex items-center justify-between">
          <div class="section-title">{t('dashboard.activity')}</div>
          <div class="flex gap-1">
            {(['7d', '30d', '1y'] as ActivityPeriod[]).map(p => (
              <button
                key={p}
                class={p === actPeriod
                  ? 'text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent cursor-pointer'
                  : 'text-[10px] px-1.5 py-0.5 rounded text-dim hover:text-muted cursor-pointer transition-colors'}
                onClick={() => setActPeriod(p)}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
        <ActivityBars works={state.cardWorks} period={actPeriod} />
      </div>

      {/* Card map */}
      <div class="card-block space-y-3">
        <div class="section-title">{t('dashboard.cardMap')}</div>
        <CardMapSection state={state} />
      </div>
    </div>
  );
}

// ── Folder delete helper ──────────────────────────────────────────────────────

function deleteFolderRecursive(s: AppState, folderId: string): void {
  const folder = s.folders[folderId]; if (!folder) return;
  for (const subId of folder.folderIds) deleteFolderRecursive(s, subId);
  for (const deckId of folder.deckIds) delete s.decks[deckId];
  delete s.folders[folderId];
  s.rootFolderIds = s.rootFolderIds.filter(id => id !== folderId);
  for (const f of Object.values(s.folders)) f.folderIds = f.folderIds.filter(id => id !== folderId);
}

// ── Main component ────────────────────────────────────────────────────────────

export function FolderView({ folderId }: { folderId: string | null }) {
  const state  = appState.value;
  const folder = folderId ? state.folders[folderId] : null;

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName,      setEditName]      = useState('');

  const folderIds = folder ? folder.folderIds : state.rootFolderIds;
  const deckIds   = folder ? folder.deckIds   : state.rootDeckIds;

  return (
    <div class="p-6 space-y-6 view-enter overflow-y-auto h-full">

      {/* ── Header ── */}
      <div class="flex items-center justify-between">
        <div>
          {folder ? (
            isEditingName ? (
              <input
                type="text"
                value={editName}
                autoFocus
                class="text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full"
                onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
                onBlur={() => {
                  const val = editName.trim();
                  if (val && val !== folder.name) mutate(s => { s.folders[folderId!]!.name = val; });
                  setIsEditingName(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')  (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setIsEditingName(false);
                }}
              />
            ) : (
              <h1
                class="text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors"
                title="Click to rename"
                onClick={() => { setEditName(folder.name); setIsEditingName(true); }}
              >
                {folder.name}
              </h1>
            )
          ) : (
            <h1 class="text-xl font-semibold text-primary">{t('folder.title.home')}</h1>
          )}
        </div>
        {folder && (
          <button
            class="btn-danger px-2"
            title={t('folder.deleteFolder')}
            onClick={() => confirmModal(
              t('folder.delete.title'),
              t('folder.delete.message', { name: folder.name }),
              t('common.delete'),
              () => {
                const parent = findParentFolder(folderId!, 'folder', state);
                void mutate(s => { deleteFolderRecursive(s, folderId!); });
                navigate({ view: 'folder', folderId: parent });
              },
            )}
          >
            <SvgIcon icon={trashIcon()} />
          </button>
        )}
      </div>

      {/* ── Dashboard (root only) ── */}
      {!folderId && <Dashboard state={state} />}

      {/* ── Sub-folders ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('folder.section.folders')}</span>
          <button class="btn-ghost text-xs" onClick={() =>
            promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
              mutate(s => {
                const id = generateId();
                s.folders[id] = { userId: s.currentUserId, id, name, folderIds: [], deckIds: [] };
                if (folderId) s.folders[folderId]!.folderIds.push(id);
                else s.rootFolderIds.push(id);
              });
            })
          }>
            {t('folder.newFolder')}
          </button>
        </div>
        {folderIds.length === 0 ? (
          <p class="text-xs text-dim italic">{t('folder.empty.folders')}</p>
        ) : (
          <div class="grid grid-cols-3 gap-2">
            {folderIds.map(subId => {
              const sub = state.folders[subId]; if (!sub) return null;
              return (
                <div key={subId} class="card-block cursor-pointer hover:border-accent/40 transition-colors" onClick={() => navigate({ view: 'folder', folderId: subId })}>
                  <div class="text-2xl mb-1">▤</div>
                  <div class="text-sm font-medium text-primary truncate">{sub.name}</div>
                  <div class="text-xs text-muted mt-0.5">{t('folder.meta', { folders: sub.folderIds.length, decks: sub.deckIds.length })}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Decks ── */}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="section-title">{t('folder.section.decks')}</span>
          <button class="btn-ghost text-xs" onClick={() => showCreateDeckModal(getContext(), folderId)}>
            {t('folder.newDeck')}
          </button>
        </div>
        {deckIds.length === 0 ? (
          <p class="text-xs text-dim italic">{t('folder.empty.decks')}</p>
        ) : (
          <div class="grid grid-cols-3 gap-2">
            {deckIds.map(deckId => {
              const deck = state.decks[deckId]; if (!deck) return null;
              return (
                <div key={deckId} class="card-block cursor-pointer hover:border-accent/40 transition-colors" onClick={() => navigate({ view: 'deck', deckId })}>
                  <div class="text-2xl mb-1">⊞</div>
                  <div class="text-sm font-medium text-primary truncate">{deck.name}</div>
                  <div class="text-xs text-muted mt-0.5">{t('folder.deckMeta', { count: deck.entries.length })}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
