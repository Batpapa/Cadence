import type { AppContext, AppState, CardWork } from '../types';
import { generateId, trashIcon, makeInlineEditable, DAY_NAMES_KEYS } from '../utils';
import { promptModal, confirmModal } from '../components/modal';
import { showCreateDeckModal } from '../components/sidebar';
import { findParentFolder, deckPath } from '../services/deckService';
import { replayFSRS, fsrsRetrievability, retentionWindowDays } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';
import { t } from '../services/i18nService';

// ── Dashboard helpers ─────────────────────────────────────────────────────────

function studyStreak(works: Record<string, CardWork>): number {
  const days = new Set<string>();
  for (const w of Object.values(works)) {
    for (const e of w.history) days.add(new Date(e.ts).toDateString());
  }
  let streak = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) { d.setDate(d.getDate() - 1); }
  while (days.has(d.toDateString())) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

function sessionsLastNDays(works: Record<string, CardWork>, n: number): number[] {
  const counts: number[] = Array(n).fill(0);
  const now = Date.now();
  for (const w of Object.values(works)) {
    for (const e of w.history) {
      const dayIdx = n - 1 - Math.floor((now - e.ts) / 86400000);
      if (dayIdx >= 0 && dayIdx < n) counts[dayIdx]++;
    }
  }
  return counts;
}

function sessionsLastNWeeks(works: Record<string, CardWork>, n: number): number[] {
  const counts: number[] = Array(n).fill(0);
  const now = Date.now();
  for (const w of Object.values(works)) {
    for (const e of w.history) {
      const weekIdx = n - 1 - Math.floor((now - e.ts) / (7 * 86400000));
      if (weekIdx >= 0 && weekIdx < n) counts[weekIdx]++;
    }
  }
  return counts;
}

type ActivityPeriod = '7d' | '30d' | '1y';

function renderActivityBars(works: Record<string, CardWork>, period: ActivityPeriod): HTMLElement {
  const row = document.createElement('div');
  row.className = 'flex gap-0.5 items-end';

  if (period === '7d') {
    const data = sessionsLastNDays(works, 7);
    const max = Math.max(...data, 1);
    for (let i = 0; i < 7; i++) {
      const count = data[i] ?? 0;
      const d = new Date(); d.setDate(d.getDate() - (6 - i));
      const col = document.createElement('div'); col.className = 'flex flex-col items-center gap-1 flex-1';
      const fill = document.createElement('div');
      fill.className = `rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`;
      fill.style.height = `${Math.max(4, Math.round((count / max) * 40))}px`;
      fill.title = t(count !== 1 ? 'dashboard.sessions' : 'dashboard.session', { count });
      const lbl = document.createElement('div'); lbl.className = 'text-[9px] text-dim'; lbl.textContent = t(DAY_NAMES_KEYS[d.getDay()]!);
      col.append(fill, lbl); row.appendChild(col);
    }
  } else if (period === '30d') {
    const data = sessionsLastNDays(works, 30);
    const max = Math.max(...data, 1);
    for (let i = 0; i < 30; i++) {
      const count = data[i] ?? 0;
      const col = document.createElement('div'); col.className = 'flex flex-col items-center gap-1 flex-1';
      const fill = document.createElement('div');
      fill.className = `rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`;
      fill.style.height = `${Math.max(4, Math.round((count / max) * 40))}px`;
      fill.title = t(count !== 1 ? 'dashboard.sessions' : 'dashboard.session', { count });
      col.appendChild(fill); row.appendChild(col);
    }
  } else {
    const data = sessionsLastNWeeks(works, 52);
    const max = Math.max(...data, 1);
    for (let i = 0; i < 52; i++) {
      const count = data[i] ?? 0;
      const col = document.createElement('div'); col.className = 'flex flex-col items-center gap-1 flex-1';
      const fill = document.createElement('div');
      fill.className = `rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`;
      fill.style.height = `${Math.max(2, Math.round((count / max) * 40))}px`;
      fill.title = t(count !== 1 ? 'dashboard.sessions' : 'dashboard.session', { count });
      col.appendChild(fill); row.appendChild(col);
    }
  }

  return row;
}

function renderDashboard(ctx: AppContext): HTMLElement {
  const { state } = ctx;
  const allCards = Object.values(state.cards);
  const allWorks = state.cardWorks;

  const dash = document.createElement('div');
  dash.className = 'space-y-5 pb-2';

  // ── Top stats row ──
  const statsRow = document.createElement('div'); statsRow.className = 'grid grid-cols-3 gap-3';

  const totalSessions = Object.values(allWorks).reduce((sum, w) => sum + w.history.length, 0);
  const sessionsThisWeek = sessionsLastNDays(allWorks, 7).reduce((a, b) => a + b, 0);
  const streak = studyStreak(allWorks);
  const deckCount = Object.keys(state.decks).length;

  const mkStat = (label: string, value: string, sub?: string) => {
    const box = document.createElement('div'); box.className = 'card-block space-y-0.5';
    const v = document.createElement('div'); v.className = 'text-2xl font-mono font-semibold text-primary'; v.textContent = value;
    const l = document.createElement('div'); l.className = 'text-xs text-muted'; l.textContent = label;
    box.append(v, l);
    if (sub) { const s = document.createElement('div'); s.className = 'text-xs text-dim'; s.textContent = sub; box.appendChild(s); }
    return box;
  };

  statsRow.append(
    mkStat(t('dashboard.cards'), String(allCards.length), t(deckCount !== 1 ? 'dashboard.decks' : 'dashboard.deck', { count: deckCount })),
    mkStat(t('dashboard.thisWeek'), String(sessionsThisWeek), t('dashboard.totalSessions', { count: totalSessions })),
    mkStat(t('dashboard.streak'), `${streak}d`, streak > 0 ? t('dashboard.streakKeep') : t('dashboard.streakStart')),
  );
  dash.appendChild(statsRow);

  // ── Activity chart ──
  const actBox = document.createElement('div'); actBox.className = 'card-block space-y-2';

  const actHeader = document.createElement('div'); actHeader.className = 'flex items-center justify-between';
  const actLabel = document.createElement('div'); actLabel.className = 'section-title'; actLabel.textContent = t('dashboard.activity');

  let actPeriod: ActivityPeriod = '7d';
  const periodBtns = document.createElement('div'); periodBtns.className = 'flex gap-1';

  const mkPeriodBtn = (id: ActivityPeriod, label: string) => {
    const btn = document.createElement('button');
    const activeClass = 'text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent cursor-pointer';
    const idleClass   = 'text-[10px] px-1.5 py-0.5 rounded text-dim hover:text-muted cursor-pointer transition-colors';
    btn.className = id === actPeriod ? activeClass : idleClass;
    btn.textContent = label;
    btn.onclick = () => {
      actPeriod = id;
      periodBtns.querySelectorAll('button').forEach(b => { b.className = idleClass; });
      btn.className = activeClass;
      const newChart = renderActivityBars(allWorks, actPeriod);
      actChart.replaceWith(newChart);
      actChart = newChart;
    };
    return btn;
  };

  periodBtns.append(mkPeriodBtn('7d', t('dashboard.period.7d')), mkPeriodBtn('30d', t('dashboard.period.30d')), mkPeriodBtn('1y', t('dashboard.period.1y')));
  actHeader.append(actLabel, periodBtns);

  let actChart = renderActivityBars(allWorks, actPeriod);
  actBox.append(actHeader, actChart);
  dash.appendChild(actBox);

  // ── Card map ──
  const mapBox = document.createElement('div'); mapBox.className = 'card-block space-y-3';
  const mapLabel = document.createElement('div'); mapLabel.className = 'section-title'; mapLabel.textContent = t('dashboard.cardMap');
  mapBox.append(mapLabel, renderCardMap(ctx));
  dash.appendChild(mapBox);

  return dash;
}

function renderCardMap(ctx: AppContext): HTMLElement {
  const { state } = ctx;
  const user = getCurrentUser(state);

  const H = 240;
  const padL = 38, padR = 14, padT = 12, padB = 30;

  // Reverse index: cardId → deck IDs
  const cardToDecks = new Map<string, string[]>();
  for (const deck of Object.values(state.decks)) {
    for (const entry of deck.entries) {
      const arr = cardToDecks.get(entry.cardId) ?? [];
      arr.push(deck.id);
      cardToDecks.set(entry.cardId, arr);
    }
  }

  type Point = { id: string; name: string; s: number; ease: number; k: number; imp: number; deckIds: string[] };
  const allPoints: Point[] = [];
  for (const card of Object.values(state.cards)) {
    const work = state.cardWorks[`${state.currentProfileId}:${card.id}`];
    if (!work || work.history.length === 0) continue;
    const fsrs = replayFSRS(work.history);
    if (!fsrs) continue;
    const ease = (10 - fsrs.difficulty) / 9;
    const elapsedDays = (Date.now() - fsrs.lastTs) / 86400000;
    const k = fsrsRetrievability(elapsedDays, fsrs.stability);
    const retWindow = retentionWindowDays(fsrs.stability, user.availabilityThreshold);
    allPoints.push({ id: card.id, name: card.name, s: retWindow, ease, k, imp: card.importance, deckIds: cardToDecks.get(card.id) ?? [] });
  }

  const wrap = document.createElement('div'); wrap.className = 'space-y-2';

  if (allPoints.length === 0) {
    const empty = document.createElement('p'); empty.className = 'text-xs text-dim italic text-center py-4';
    empty.textContent = t('card.neverReviewed');
    wrap.appendChild(empty);
    return wrap;
  }

  // Deck list — only decks that have at least one reviewed card
  const pointDeckIds = new Set(allPoints.flatMap(p => p.deckIds));
  const deckList = Object.values(state.decks)
    .filter(d => pointDeckIds.has(d.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const selectedDecks = new Set(deckList.map(d => d.id));

  const getVisible = (): Point[] => {
    const seen = new Set<string>();
    const result: Point[] = [];
    for (const pt of allPoints) {
      if (!seen.has(pt.id) && pt.deckIds.some(d => selectedDecks.has(d))) {
        seen.add(pt.id);
        result.push(pt);
      }
    }
    return result;
  };

  // SVG helpers
  const ns = 'http://www.w3.org/2000/svg';
  const mkEl = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const mkText = (x: number, y: number, content: string, anchor: string, size = '8') => {
    const el = mkEl('text', { x: String(x), y: String(y), 'text-anchor': anchor, 'font-size': size, fill: '#555555', 'font-family': 'IBM Plex Mono, monospace' });
    el.textContent = content;
    return el;
  };

  const rScale = (imp: number) => Math.sqrt(Math.max(1, Math.min(10, Math.log10(Math.max(1, imp)))));
  const dotColor = (k: number): string => k >= 0.75 ? '#4ade80' : k >= 0.4 ? '#fbbf24' : '#f87171';
  const xTicks: Array<{ val: number; label: string }> = [
    { val: 1, label: t('dashboard.period.1d') }, { val: 7, label: t('dashboard.period.7d') },
    { val: 30, label: t('dashboard.period.30d') }, { val: 180, label: t('dashboard.period.6mo') }, { val: 365, label: t('dashboard.period.1y') },
  ];

  const buildSvg = (W: number, pts: Point[]): Element => {
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xMin = 0.5, xMax = 730;
    const logXMin = Math.log(xMin), logXMax = Math.log(xMax);
    const xScale = (s: number) => padL + (Math.log(Math.max(xMin, Math.min(xMax, s))) - logXMin) / (logXMax - logXMin) * plotW;
    const yScale = (e: number) => padT + plotH * (1 - Math.max(0, Math.min(1, e)));

    const svg = mkEl('svg', { width: String(W), height: String(H) });
    (svg as SVGElement & { style: CSSStyleDeclaration }).style.display = 'block';

    for (const tick of [0, 0.25, 0.5, 0.75, 1.0]) {
      const y = yScale(tick);
      svg.appendChild(mkEl('line', { x1: String(padL), x2: String(W - padR), y1: String(y), y2: String(y), stroke: '#252525', 'stroke-width': '1' }));
      svg.appendChild(mkText(padL - 5, y + 3.5, `${Math.round(tick * 100)}%`, 'end'));
    }

    for (const { val, label } of xTicks) {
      const x = xScale(val);
      svg.appendChild(mkEl('line', { x1: String(x), x2: String(x), y1: String(padT), y2: String(padT + plotH), stroke: '#252525', 'stroke-width': '1' }));
      svg.appendChild(mkText(x, H - padB + 12, label, 'middle'));
    }

    svg.appendChild(mkEl('rect', { x: String(padL), y: String(padT), width: String(plotW), height: String(plotH), fill: 'none', stroke: '#333333', 'stroke-width': '1' }));

    for (const pt of [...pts].sort((a, b) => b.imp - a.imp)) {
      const color = dotColor(pt.k);
      const circle = mkEl('circle', {
        cx: String(xScale(pt.s)), cy: String(yScale(pt.ease)), r: String(rScale(pt.imp)),
        fill: color, 'fill-opacity': '0.7', stroke: color, 'stroke-opacity': '0.35', 'stroke-width': '1.5',
      });
      (circle as SVGElement & { style: CSSStyleDeclaration }).style.cursor = 'pointer';
      const title = document.createElementNS(ns, 'title'); title.textContent = pt.name;
      circle.appendChild(title);
      circle.addEventListener('click', () => ctx.navigate({ view: 'card', cardId: pt.id }));
      svg.appendChild(circle);
    }

    svg.appendChild(mkText(padL + plotW / 2, H - 2, t('deck.section.stability'), 'middle', '10'));
    const yAxisLabel = mkEl('text', { x: '0', y: '0', 'text-anchor': 'middle', 'font-size': '10', fill: '#555555', 'font-family': 'IBM Plex Mono, monospace', transform: `rotate(-90) translate(${-(padT + plotH / 2)}, 9)` });
    yAxisLabel.textContent = t('deck.section.ease');
    svg.appendChild(yAxisLabel);

    return svg;
  };

  // ── Chip filter row ──
  const chipActiveClass = 'text-xs px-2 py-0.5 rounded-full border bg-accent text-white border-accent cursor-pointer transition-colors';
  const chipIdleClass   = 'text-xs px-2 py-0.5 rounded-full border border-border text-muted hover:border-accent hover:text-accent cursor-pointer transition-colors';

  const chipsRow = document.createElement('div');
  chipsRow.className = 'flex flex-wrap gap-1 items-center';

  // All / None controls
  const controlsWrap = document.createElement('div');
  controlsWrap.className = 'flex gap-1 items-center border-r border-border pr-2 mr-0.5 shrink-0';
  const mkCtrl = (label: string, fn: () => void) => {
    const btn = document.createElement('button');
    btn.className = 'text-[9px] text-dim hover:text-muted cursor-pointer transition-colors';
    btn.textContent = label;
    btn.onclick = fn;
    return btn;
  };

  const chipEls = new Map<string, HTMLButtonElement>();

  const updateChips = () => {
    for (const [id, chip] of chipEls) {
      chip.className = selectedDecks.has(id) ? chipActiveClass : chipIdleClass;
    }
  };

  controlsWrap.append(
    mkCtrl(t('dashboard.filterAll'),  () => { deckList.forEach(d => selectedDecks.add(d.id));    updateChips(); rebuildSvg(); }),
    mkCtrl(t('dashboard.filterNone'), () => { selectedDecks.clear();                              updateChips(); rebuildSvg(); }),
  );
  chipsRow.appendChild(controlsWrap);

  for (const deck of deckList) {
    const chip = document.createElement('button');
    chip.className = chipActiveClass;
    chip.textContent = deck.name;
    chip.title = deckPath(deck.id, state);
    chip.onclick = () => {
      if (selectedDecks.has(deck.id)) selectedDecks.delete(deck.id);
      else selectedDecks.add(deck.id);
      chip.className = selectedDecks.has(deck.id) ? chipActiveClass : chipIdleClass;
      rebuildSvg();
    };
    chipEls.set(deck.id, chip);
    chipsRow.appendChild(chip);
  }
  wrap.appendChild(chipsRow);

  // ── SVG with ResizeObserver ──
  let lastW = 0;
  let currentSvg: Element | null = null;
  const svgWrap = document.createElement('div');

  const rebuildSvg = () => {
    if (lastW <= 0) return;
    const newSvg = buildSvg(lastW, getVisible());
    if (currentSvg) svgWrap.replaceChild(newSvg, currentSvg);
    else svgWrap.appendChild(newSvg);
    currentSvg = newSvg;
  };

  const obs = new ResizeObserver(entries => {
    requestAnimationFrame(() => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w <= 0) return;
      lastW = w;
      rebuildSvg();
    });
  });
  obs.observe(svgWrap);
  wrap.appendChild(svgWrap);

  return wrap;
}

// ── Folder view ───────────────────────────────────────────────────────────────

export function renderFolderView(ctx: AppContext, folderId: string | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'p-6 space-y-6 view-enter overflow-y-auto h-full';

  const { state } = ctx;
  const folder = folderId ? state.folders[folderId] : null;

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'flex items-center justify-between';

  const titleWrap = document.createElement('div');
  const title = document.createElement('h1');
  title.textContent = folder ? folder.name : t('folder.title.home');
  titleWrap.appendChild(title);

  const headerActions = document.createElement('div');
  headerActions.className = 'flex gap-2';

  if (folder) {
    makeInlineEditable(title, folder.name, val => ctx.mutate(s => { s.folders[folderId!]!.name = val; }));

    const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger px-2'; deleteBtn.title = t('folder.deleteFolder'); deleteBtn.appendChild(trashIcon());
    deleteBtn.onclick = () => confirmModal(t('folder.delete.title'), t('folder.delete.message', { name: folder.name }), t('common.delete'), () => {
      const parent = findParentFolder(folderId!, 'folder', state);
      ctx.mutate(s => { deleteFolderRecursive(s, folderId!); });
      ctx.navigate({ view: 'folder', folderId: parent });
    });
    headerActions.append(deleteBtn);
  } else {
    title.className = 'text-xl font-semibold text-primary';
  }

  header.append(titleWrap, headerActions);
  wrap.appendChild(header);

  // ── Dashboard (root only) ──
  if (!folderId) wrap.appendChild(renderDashboard(ctx));

  const folderIds = folder ? folder.folderIds : state.rootFolderIds;
  const deckIds   = folder ? folder.deckIds   : state.rootDeckIds;

  // ── Sub-folders ──
  const foldersSection = document.createElement('div');
  foldersSection.className = 'space-y-2';

  const foldersHeader = document.createElement('div');
  foldersHeader.className = 'flex items-center justify-between';
  const foldersTitle = document.createElement('span');
  foldersTitle.className = 'section-title'; foldersTitle.textContent = t('folder.section.folders');
  const addFolderBtn = document.createElement('button');
  addFolderBtn.className = 'btn-ghost text-xs'; addFolderBtn.textContent = t('folder.newFolder');
  addFolderBtn.onclick = () => promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
    ctx.mutate(s => {
      const id = generateId();
      s.folders[id] = { userId: s.currentUserId, id, name, folderIds: [], deckIds: [] };
      if (folderId) s.folders[folderId]!.folderIds.push(id);
      else s.rootFolderIds.push(id);
    });
  });
  foldersHeader.append(foldersTitle, addFolderBtn);
  foldersSection.appendChild(foldersHeader);

  if (folderIds.length === 0) {
    const empty = document.createElement('p'); empty.className = 'text-xs text-dim italic'; empty.textContent = t('folder.empty.folders');
    foldersSection.appendChild(empty);
  } else {
    const grid = document.createElement('div'); grid.className = 'grid grid-cols-3 gap-2';
    for (const subId of folderIds) {
      const sub = state.folders[subId]; if (!sub) continue;
      const card = document.createElement('div');
      card.className = 'card-block cursor-pointer hover:border-accent/40 transition-colors';
      card.onclick = () => ctx.navigate({ view: 'folder', folderId: subId });
      const icon = document.createElement('div'); icon.className = 'text-2xl mb-1'; icon.textContent = '▤';
      const name = document.createElement('div'); name.className = 'text-sm font-medium text-primary truncate'; name.textContent = sub.name;
      const meta = document.createElement('div'); meta.className = 'text-xs text-muted mt-0.5';
      meta.textContent = t('folder.meta', { folders: sub.folderIds.length, decks: sub.deckIds.length });
      card.append(icon, name, meta); grid.appendChild(card);
    }
    foldersSection.appendChild(grid);
  }
  wrap.appendChild(foldersSection);

  // ── Decks ──
  const decksSection = document.createElement('div');
  decksSection.className = 'space-y-2';

  const decksHeader = document.createElement('div');
  decksHeader.className = 'flex items-center justify-between';
  const decksTitle = document.createElement('span'); decksTitle.className = 'section-title'; decksTitle.textContent = t('folder.section.decks');
  const addDeckBtn = document.createElement('button');
  addDeckBtn.className = 'btn-ghost text-xs'; addDeckBtn.textContent = t('folder.newDeck');
  addDeckBtn.onclick = () => showCreateDeckModal(ctx, folderId);
  decksHeader.append(decksTitle, addDeckBtn);
  decksSection.appendChild(decksHeader);

  if (deckIds.length === 0) {
    const empty = document.createElement('p'); empty.className = 'text-xs text-dim italic'; empty.textContent = t('folder.empty.decks');
    decksSection.appendChild(empty);
  } else {
    const grid = document.createElement('div'); grid.className = 'grid grid-cols-3 gap-2';
    for (const deckId of deckIds) {
      const deck = state.decks[deckId]; if (!deck) continue;
      const card = document.createElement('div');
      card.className = 'card-block cursor-pointer hover:border-accent/40 transition-colors';
      card.onclick = () => ctx.navigate({ view: 'deck', deckId });
      const icon = document.createElement('div'); icon.className = 'text-2xl mb-1'; icon.textContent = '⊞';
      const name = document.createElement('div'); name.className = 'text-sm font-medium text-primary truncate'; name.textContent = deck.name;
      const meta = document.createElement('div'); meta.className = 'text-xs text-muted mt-0.5'; meta.textContent = t('folder.deckMeta', { count: deck.entries.length });
      card.append(icon, name, meta); grid.appendChild(card);
    }
    decksSection.appendChild(grid);
  }
  wrap.appendChild(decksSection);

  return wrap;
}

function deleteFolderRecursive(s: AppState, folderId: string): void {
  const folder = s.folders[folderId]; if (!folder) return;
  for (const subId of folder.folderIds) deleteFolderRecursive(s, subId);
  for (const deckId of folder.deckIds) delete s.decks[deckId];
  delete s.folders[folderId];
  s.rootFolderIds = s.rootFolderIds.filter(id => id !== folderId);
  for (const f of Object.values(s.folders)) f.folderIds = f.folderIds.filter(id => id !== folderId);
}
