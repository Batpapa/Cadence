import type { AppContext } from '../types';
import { t } from '../services/i18nService';

// ── Types ─────────────────────────────────────────────────────────────────────

type PaletteItem = {
  label: string;
  sublabel?: string;
  kind: 'card' | 'deck' | 'folder';
  onSelect: (ctx: AppContext) => void;
};

// ── Search ────────────────────────────────────────────────────────────────────

function score(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q)           return 3;
  if (n.startsWith(q))   return 2;
  if (n.includes(q))     return 1;
  return 0;
}

function buildItems(ctx: AppContext, query: string): PaletteItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const items: PaletteItem[] = [];

  for (const card of Object.values(ctx.state.cards)) {
    const s = Math.max(
      score(card.name, q),
      ...(card.tags ?? []).map(tg => score(tg, q) * 0.5),
    );
    if (s > 0) items.push({
      label: card.name,
      sublabel: card.tags?.join(', ') || undefined,
      kind: 'card',
      onSelect: (c) => c.navigate({ view: 'card', cardId: card.id }),
    });
  }

  for (const deck of Object.values(ctx.state.decks)) {
    const s = score(deck.name, q);
    if (s > 0) items.push({
      label: deck.name,
      sublabel: t(deck.entries.length !== 1 ? 'commandPalette.deckCountPlural' : 'commandPalette.deckCount', { count: deck.entries.length }),
      kind: 'deck',
      onSelect: (c) => c.navigate({ view: 'deck', deckId: deck.id }),
    });
  }

  for (const folder of Object.values(ctx.state.folders)) {
    const s = score(folder.name, q);
    if (s > 0) items.push({
      label: folder.name,
      kind: 'folder',
      onSelect: (c) => c.navigate({ view: 'folder', folderId: folder.id }),
    });
  }

  items.sort((a, b) => {
    const sa = Math.max(score(a.label, q), 0);
    const sb = Math.max(score(b.label, q), 0);
    return sb - sa || a.label.localeCompare(b.label);
  });

  return items.slice(0, 10);
}

// ── Kind badge ────────────────────────────────────────────────────────────────

const KIND_STYLE: Record<PaletteItem['kind'], string> = {
  card:   'bg-accent/10 text-accent',
  deck:   'bg-success/10 text-success',
  folder: 'bg-elevated text-muted',
};

// ── Palette UI ────────────────────────────────────────────────────────────────

export function showCommandPalette(getCtx: () => AppContext): void {
  if (document.getElementById('cmd-palette')) return;

  const overlay = document.createElement('div');
  overlay.id = 'cmd-palette';
  overlay.className = 'fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col';

  const inputRow = document.createElement('div');
  inputRow.className = 'flex items-center gap-3 px-4 py-3 border-b border-border';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'text-dim text-sm shrink-0';
  searchIcon.textContent = '⌕';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('commandPalette.placeholder');
  input.className = 'flex-1 bg-transparent outline-none text-sm text-primary placeholder-dim';
  const hint = document.createElement('span');
  hint.className = 'text-[10px] text-dim font-mono shrink-0';
  hint.textContent = 'Esc';
  inputRow.append(searchIcon, input, hint);
  dialog.appendChild(inputRow);

  const list = document.createElement('div');
  list.className = 'max-h-72 overflow-y-auto py-1';
  dialog.appendChild(list);

  let activeIndex = 0;

  const close = () => overlay.remove();

  const select = (item: PaletteItem) => {
    close();
    item.onSelect(getCtx());
  };

  const render = () => {
    const items = buildItems(getCtx(), input.value);
    list.innerHTML = '';
    activeIndex = 0;

    if (!input.value.trim()) {
      const empty = document.createElement('p');
      empty.className = 'text-xs text-dim text-center py-6';
      empty.textContent = t('commandPalette.typeToSearch');
      list.appendChild(empty);
      return;
    }

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-xs text-dim text-center py-6';
      empty.textContent = t('commandPalette.noResults');
      list.appendChild(empty);
      return;
    }

    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = `flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${i === activeIndex ? 'bg-accent/10' : 'hover:bg-bg'}`;
      row.dataset['index'] = String(i);

      const badge = document.createElement('span');
      badge.className = `text-[10px] font-medium px-1.5 py-0.5 rounded ${KIND_STYLE[item.kind]} shrink-0 w-12 text-center`;
      badge.textContent = t(`commandPalette.kind.${item.kind}`);

      const labelWrap = document.createElement('div');
      labelWrap.className = 'flex-1 min-w-0';
      const label = document.createElement('span');
      label.className = 'text-sm text-primary block truncate';
      label.textContent = item.label;
      labelWrap.appendChild(label);

      if (item.sublabel) {
        const sub = document.createElement('span');
        sub.className = 'text-xs text-dim truncate block';
        sub.textContent = item.sublabel;
        labelWrap.appendChild(sub);
      }

      row.append(badge, labelWrap);
      row.onmouseenter = () => setActive(i);
      row.onclick = () => select(item);
      list.appendChild(row);
    });
  };

  const setActive = (i: number) => {
    const rows = list.querySelectorAll<HTMLElement>('[data-index]');
    rows.forEach(r => r.classList.replace('bg-accent/10', 'hover:bg-bg'));
    activeIndex = i;
    const active = list.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (active) {
      active.classList.remove('hover:bg-bg');
      active.classList.add('bg-accent/10');
      active.scrollIntoView({ block: 'nearest' });
    }
  };

  input.addEventListener('input', render);

  input.addEventListener('keydown', (e) => {
    const items = buildItems(getCtx(), input.value);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIndex + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIndex - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const item = items[activeIndex]; if (item) select(item); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { mouseDownOnOverlay = e.target === overlay; });
  overlay.onclick = (e) => { if (e.target === overlay && mouseDownOnOverlay) close(); };

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  render();
  setTimeout(() => input.focus(), 10);
}

// ── Global shortcut registration ──────────────────────────────────────────────

export function registerCommandPalette(getCtx: () => AppContext): void {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      showCommandPalette(getCtx);
    }
  });
}
