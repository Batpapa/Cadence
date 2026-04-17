import type { AppContext, AppState, User, CardWork } from '../types';
import { generateId, pct, timeAgo, trashIcon } from '../utils';
import { promptModal, confirmModal } from '../components/modal';
import { showCreateDeckModal } from '../components/sidebar';
import { findParentFolder } from '../services/deckService';
import { cardKnowledge, deckKnowledge, deckKnowledgeBuckets } from '../services/knowledgeService';
import { getCurrentUser } from '../services/userService';

// ── Dashboard helpers ─────────────────────────────────────────────────────────

function studyStreak(works: Record<string, CardWork>): number {
  const days = new Set<string>();
  for (const w of Object.values(works)) {
    for (const e of w.history) days.add(new Date(e.ts).toDateString());
  }
  let streak = 0;
  const d = new Date();
  // Allow today OR yesterday as the most recent active day (so streak survives the morning)
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
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
      fill.title = `${count} session${count !== 1 ? 's' : ''}`;
      const lbl = document.createElement('div'); lbl.className = 'text-[9px] text-dim'; lbl.textContent = DAY_NAMES[d.getDay()]!;
      col.append(fill, lbl); row.appendChild(col);
    }
  } else if (period === '30d') {
    const data = sessionsLastNDays(works, 30);
    const max = Math.max(...data, 1);
    for (let i = 0; i < 30; i++) {
      const count = data[i] ?? 0;
      const d = new Date(); d.setDate(d.getDate() - (29 - i));
      const col = document.createElement('div'); col.className = 'flex flex-col items-center gap-1 flex-1';
      const fill = document.createElement('div');
      fill.className = `rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`;
      fill.style.height = `${Math.max(4, Math.round((count / max) * 40))}px`;
      fill.title = `${count} session${count !== 1 ? 's' : ''}`;
      col.appendChild(fill); row.appendChild(col);
    }
  } else {
    const data = sessionsLastNWeeks(works, 52);
    const max = Math.max(...data, 1);
    for (let i = 0; i < 52; i++) {
      const count = data[i] ?? 0;
      const d = new Date(); d.setDate(d.getDate() - (51 - i) * 7);
      const col = document.createElement('div'); col.className = 'flex flex-col items-center gap-1 flex-1';
      const fill = document.createElement('div');
      fill.className = `rounded-sm w-full ${count === 0 ? 'bg-border' : 'bg-accent'}`;
      fill.style.height = `${Math.max(2, Math.round((count / max) * 40))}px`;
      fill.title = `${count} session${count !== 1 ? 's' : ''}`;
      col.appendChild(fill); row.appendChild(col);
    }
  }

  return row;
}

function renderDashboard(ctx: AppContext): HTMLElement {
  const { state } = ctx;
  const user = getCurrentUser(state);
  const allCards = Object.values(state.cards);
  const allWorks = state.cardWorks;

  const dash = document.createElement('div');
  dash.className = 'space-y-5 pb-2';

  // ── Top stats row ──
  const statsRow = document.createElement('div'); statsRow.className = 'grid grid-cols-3 gap-3';

  const totalSessions = Object.values(allWorks).reduce((sum, w) => sum + w.history.length, 0);
  const sessionsThisWeek = sessionsLastNDays(allWorks, 7).reduce((a, b) => a + b, 0);
  const streak = studyStreak(allWorks);

  const mkStat = (label: string, value: string, sub?: string) => {
    const box = document.createElement('div'); box.className = 'card-block space-y-0.5';
    const v = document.createElement('div'); v.className = 'text-2xl font-mono font-semibold text-primary'; v.textContent = value;
    const l = document.createElement('div'); l.className = 'text-xs text-muted'; l.textContent = label;
    box.append(v, l);
    if (sub) { const s = document.createElement('div'); s.className = 'text-xs text-dim'; s.textContent = sub; box.appendChild(s); }
    return box;
  };

  statsRow.append(
    mkStat('Cards', String(allCards.length), `${Object.keys(state.decks).length} deck${Object.keys(state.decks).length !== 1 ? 's' : ''}`),
    mkStat('This week', String(sessionsThisWeek), `${totalSessions} total sessions`),
    mkStat('Streak', `${streak}d`, streak > 0 ? 'keep it up!' : 'start today'),
  );
  dash.appendChild(statsRow);

  // ── Knowledge distribution ──
  const buckets = [0, 0, 0, 0]; // 0-25, 25-50, 50-75, 75-100
  for (const card of allCards) {
    const w = allWorks[`${user.id}:${card.id}`];
    const k = cardKnowledge(user, w);
    buckets[Math.min(3, Math.floor(k * 4))]++;
  }
  const total = allCards.length || 1;

  if (allCards.length > 0) {
    const distBox = document.createElement('div'); distBox.className = 'card-block space-y-2';
    const distLabel = document.createElement('div'); distLabel.className = 'section-title'; distLabel.textContent = 'Knowledge distribution';

    const bar = document.createElement('div'); bar.className = 'flex h-3 rounded overflow-hidden';
    const segments = [
      { pct: buckets[0]! / total, cls: 'bg-danger', label: `${buckets[0]} unknown` },
      { pct: buckets[1]! / total, cls: 'bg-warn',   label: `${buckets[1]} learning` },
      { pct: buckets[2]! / total, cls: 'bg-success/60', label: `${buckets[2]} good` },
      { pct: buckets[3]! / total, cls: 'bg-success', label: `${buckets[3]} mastered` },
    ];
    for (const seg of segments) {
      if (seg.pct === 0) continue;
      const s = document.createElement('div'); s.className = seg.cls; s.style.width = `${seg.pct * 100}%`; bar.appendChild(s);
    }

    const legend = document.createElement('div'); legend.className = 'flex gap-3 flex-wrap';
    for (const seg of segments) {
      const dot = document.createElement('span'); dot.className = `inline-flex items-center gap-1 text-xs text-dim`;
      dot.innerHTML = `<span class="w-2 h-2 rounded-full ${seg.cls} inline-block"></span>${seg.label}`;
      legend.appendChild(dot);
    }
    distBox.append(distLabel, bar, legend);
    dash.appendChild(distBox);
  }

  // ── Activity chart ──
  const actBox = document.createElement('div'); actBox.className = 'card-block space-y-2';

  const actHeader = document.createElement('div'); actHeader.className = 'flex items-center justify-between';
  const actLabel = document.createElement('div'); actLabel.className = 'section-title'; actLabel.textContent = 'Activity';

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

  periodBtns.append(mkPeriodBtn('7d', '7d'), mkPeriodBtn('30d', '1m'), mkPeriodBtn('1y', '1y'));
  actHeader.append(actLabel, periodBtns);

  let actChart = renderActivityBars(allWorks, actPeriod);
  actBox.append(actHeader, actChart);
  dash.appendChild(actBox);

  // ── Most neglected decks ──
  const deckList = Object.values(state.decks)
    .filter(d => d.entries.length > 0)
    .map(deck => ({ deck, k: deckKnowledge(user, deck, state.cards, allWorks, user.weightByImportance ?? true) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 3);

  if (deckList.length > 0) {
    const neglBox = document.createElement('div'); neglBox.className = 'card-block space-y-2';
    const neglLabel = document.createElement('div'); neglLabel.className = 'section-title'; neglLabel.textContent = 'Decks to review';
    const neglList = document.createElement('div'); neglList.className = 'space-y-1';
    for (const { deck, k } of deckList) {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 cursor-pointer hover:bg-bg rounded px-2 py-1 -mx-2 transition-colors';
      row.onclick = () => ctx.navigate({ view: 'deck', deckId: deck.id });
      const { buckets, total } = deckKnowledgeBuckets(user, deck, state.cards, allWorks, user.weightByImportance ?? true);
      const barWrap = document.createElement('div'); barWrap.className = 'flex-1 flex h-1.5 rounded overflow-hidden bg-border';
      if (total > 0) {
        for (const [i, cls] of (['bg-danger', 'bg-warn', 'bg-success/60', 'bg-success'] as const).entries()) {
          const w = buckets[i]! / total;
          if (w === 0) continue;
          const s = document.createElement('div'); s.className = cls; s.style.width = `${w * 100}%`;
          barWrap.appendChild(s);
        }
      }
      const name = document.createElement('span'); name.className = 'text-sm text-primary w-32 truncate shrink-0'; name.textContent = deck.name;
      const pctEl = document.createElement('span'); pctEl.className = 'text-xs font-mono text-dim shrink-0 w-10 text-right'; pctEl.textContent = pct(k);
      row.append(name, barWrap, pctEl);
      neglList.appendChild(row);
    }
    neglBox.append(neglLabel, neglList);
    dash.appendChild(neglBox);
  }

  return dash;
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
  title.textContent = folder ? folder.name : 'Home';
  titleWrap.appendChild(title);

  const headerActions = document.createElement('div');
  headerActions.className = 'flex gap-2';

  if (folder) {
    title.className = 'text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors';
    title.title = 'Click to rename';
    title.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = folder.name;
      inp.className = 'text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full';
      title.replaceWith(inp); inp.focus(); inp.select();
      const commit = () => {
        const val = inp.value.trim();
        if (val && val !== folder.name) { ctx.mutate(s => { s.folders[folderId!]!.name = val; }); }
        else { inp.replaceWith(title); }
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { inp.replaceWith(title); }
      });
    };

    const deleteBtn = document.createElement('button'); deleteBtn.className = 'btn-danger px-2'; deleteBtn.title = 'Delete folder'; deleteBtn.appendChild(trashIcon());
    deleteBtn.onclick = () => confirmModal('Delete Folder', `Delete "${folder.name}" and all its contents?`, 'Delete', () => {
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
  foldersTitle.className = 'section-title'; foldersTitle.textContent = 'Folders';
  const addFolderBtn = document.createElement('button');
  addFolderBtn.className = 'btn-ghost text-xs'; addFolderBtn.textContent = '+ New folder';
  addFolderBtn.onclick = () => promptModal('New Folder', 'Name', '', name => {
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
    const empty = document.createElement('p'); empty.className = 'text-xs text-dim italic'; empty.textContent = 'No subfolders';
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
      const meta = document.createElement('div'); meta.className = 'text-xs text-muted mt-0.5'; meta.textContent = `${sub.folderIds.length} folders · ${sub.deckIds.length} decks`;
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
  const decksTitle = document.createElement('span'); decksTitle.className = 'section-title'; decksTitle.textContent = 'Decks';
  const addDeckBtn = document.createElement('button');
  addDeckBtn.className = 'btn-ghost text-xs'; addDeckBtn.textContent = '+ New deck';
  addDeckBtn.onclick = () => showCreateDeckModal(ctx, folderId);
  decksHeader.append(decksTitle, addDeckBtn);
  decksSection.appendChild(decksHeader);

  if (deckIds.length === 0) {
    const empty = document.createElement('p'); empty.className = 'text-xs text-dim italic'; empty.textContent = 'No decks';
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
      const meta = document.createElement('div'); meta.className = 'text-xs text-muted mt-0.5'; meta.textContent = `${deck.entries.length} cards`;
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
