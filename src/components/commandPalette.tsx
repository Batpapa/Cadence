import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { AppContext } from '../types';
import { t } from '../services/i18nService';
import { focusIfDesktop, scoreMatch, NO_SCORE_MATCH } from '../utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type PaletteItem = {
  label: string;
  sublabel?: string;
  kind: 'card' | 'deck' | 'folder';
  onSelect: (ctx: AppContext) => void;
};

// ── Search ────────────────────────────────────────────────────────────────────

function buildItems(ctx: AppContext, query: string): PaletteItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const items: PaletteItem[] = [];

  for (const card of Object.values(ctx.user.cards)) {
    if (scoreMatch(card.name, q) < NO_SCORE_MATCH) items.push({
      label: card.name,
      sublabel: card.tags?.join(', ') || undefined,
      kind: 'card',
      onSelect: (c) => c.navigate({ view: 'card', cardId: card.id }),
    });
  }

  for (const deck of Object.values(ctx.user.decks)) {
    if (scoreMatch(deck.name, q) < NO_SCORE_MATCH) items.push({
      label: deck.name,
      sublabel: t(deck.entries.length !== 1 ? 'commandPalette.deckCountPlural' : 'commandPalette.deckCount', { count: deck.entries.length }),
      kind: 'deck',
      onSelect: (c) => c.navigate({ view: 'deck', deckId: deck.id }),
    });
  }

  for (const folder of Object.values(ctx.user.folders)) {
    if (scoreMatch(folder.name, q) < NO_SCORE_MATCH) items.push({
      label: folder.name,
      kind: 'folder',
      onSelect: (c) => c.navigate({ view: 'folder', folderId: folder.id }),
    });
  }

  items.sort((a, b) =>
    scoreMatch(a.label, q) - scoreMatch(b.label, q) || a.label.localeCompare(b.label)
  );

  return items;
}

// ── Kind badge ────────────────────────────────────────────────────────────────

const KIND_STYLE: Record<PaletteItem['kind'], string> = {
  card:   'bg-accent/10 text-accent',
  deck:   'bg-success/10 text-success',
  folder: 'bg-elevated text-muted',
};

// ── Palette UI ────────────────────────────────────────────────────────────────
// Single-instance, signal-backed (same idea as modal.tsx's modalStack): open
// state lives outside any one Preact tree since showCommandPalette() is
// called imperatively both from header.tsx's search button (already Preact)
// and from the global Ctrl/Cmd+K listener below (not tied to any component).

const activeGetCtx = signal<(() => AppContext) | null>(null);

export function showCommandPalette(getCtx: () => AppContext): void {
  if (activeGetCtx.value) return;
  activeGetCtx.value = getCtx;
}

function closePalette(): void {
  activeGetCtx.value = null;
}

function CommandPalette({ getCtx }: { getCtx: () => AppContext }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => buildItems(getCtx(), query), [query, getCtx]);

  useLayoutEffect(() => { focusIfDesktop(inputRef.current!); }, []);
  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const select = (item: PaletteItem) => { closePalette(); item.onSelect(getCtx()); };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const item = items[activeIndex]; if (item) select(item); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  };

  const mouseDownOnOverlay = useRef(false);

  return (
    <div
      class="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) closePalette(); }}
    >
      <div class="bg-elevated border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden flex flex-col">
        <div class="flex items-center gap-3 px-4 py-3 border-b border-border">
          <span class="text-dim text-sm shrink-0">⌕</span>
          <input
            ref={inputRef}
            type="text"
            placeholder={t('commandPalette.placeholder')}
            class="flex-1 bg-transparent outline-none text-sm text-primary placeholder-dim"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
          />
          <span class="text-[10px] text-dim font-mono shrink-0">Esc</span>
        </div>

        <div ref={listRef} class="max-h-72 overflow-y-auto py-1">
          {!query.trim() ? (
            <p class="text-xs text-dim text-center py-6">{t('commandPalette.typeToSearch')}</p>
          ) : items.length === 0 ? (
            <p class="text-xs text-dim text-center py-6">{t('commandPalette.noResults')}</p>
          ) : (
            items.map((item, i) => (
              <div
                key={i}
                data-index={i}
                class={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${i === activeIndex ? 'bg-accent/10' : 'hover:bg-bg'}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(item)}
              >
                <span class={`text-[10px] font-medium px-1.5 py-0.5 rounded ${KIND_STYLE[item.kind]} shrink-0 w-12 text-center`}>
                  {t(`commandPalette.kind.${item.kind}`)}
                </span>
                <div class="flex-1 min-w-0">
                  <span class="text-sm text-primary block truncate">{item.label}</span>
                  {item.sublabel && <span class="text-xs text-dim truncate block">{item.sublabel}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Mount once in AppRoot (not UserSelector — the palette is only reachable
 *  once a user is logged in). Renders nothing while closed. */
export function CommandPaletteHost() {
  const getCtx = activeGetCtx.value;
  if (!getCtx) return null;
  return createPortal(<CommandPalette getCtx={getCtx} />, document.body);
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
