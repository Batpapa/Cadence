import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { FilterState } from '../types';
import { t } from '../services/i18nService';
import { ChevronDownIcon, FilterClearIcon, FilterIcon, FolderIcon, PencilIcon, VennAndIcon, VennOrIcon } from './icons';
import { matchesSearch } from '../utils';
import { DateField } from './dateField';
import { IconButton } from './ui';

/** A chip of a section drawn as a tree (`tree`): a tag group and its tags
 *  (tagGroups.ts), a deck folder and its decks (deckChips.ts). */
export interface FilterTreeNode {
  /** The chip's key. */
  id: string;
  children: FilterTreeNode[];
  /** A group even with nothing under it on screen — a pinned folder whose
   *  decks are all filtered away still shows as a folder. Otherwise a node is
   *  a group when it has children. */
  group?: boolean;
}

const isGroupNode = (n: FilterTreeNode) => !!n.group || n.children.length > 0;

export type FilterMap = Map<string, FilterState>;

/** Steps a chip round: off → include → exclude → off.
 *
 *  `back` walks the same ring the other way, which is what a right click does.
 *  With only three states the shortcut is small but real — "off → exclude" is
 *  one gesture instead of two, and excluding is the common reason to touch a
 *  chip you have not touched yet. Same grammar as the repeat counter on a
 *  set's tunes, which already cycles up on click and down on right click. */
export function cycleFilter(prev: FilterMap, key: string, back = false): FilterMap {
  const n = new Map(prev);
  const s = n.get(key);
  if (back) {
    if (s === undefined)       n.set(key, 'exclude');
    else if (s === 'exclude')  n.set(key, 'include');
    else                       n.delete(key);
    return n;
  }
  if (s === undefined)       n.set(key, 'include');
  else if (s === 'include')  n.set(key, 'exclude');
  else                       n.delete(key);
  return n;
}

export function FilterSection({ labelKey, items, folderItems = [], tree, covered, activeMap, labelOf, titleOf, available, onToggle, highlight, orMode, onToggleOr, onRename }: {
  labelKey: string;
  items: string[];
  /** Drawn instead of `items` and `folderItems`: each group's chip (with a
   *  folder glyph) on a line of its own; under it, one step in, a line of its
   *  values, then its own groups; the plain values on a last line. A group chip
   *  stands for everything under it. Same layout for tag groups and deck
   *  folders (user's call, 2026-11-09). */
  tree?: FilterTreeNode[];
  /** Folder chips (keys from `folderChipKey`), shown first with a folder glyph
   *  and set apart from `items` by a thin rule. A folder chip stands for
   *  everything below it; the caller's predicate decides what that means. */
  folderItems?: string[];
  /** Chips an included folder already covers (see `coveredByFolders`): drawn
   *  with a light accent outline, so the reader sees what the folder took in
   *  and can exclude one of them from it. */
  covered?: ReadonlySet<string>;
  activeMap: FilterMap;
  labelOf: (id: string) => string;
  titleOf: (id: string) => string;
  available: Set<string>;
  /** `back` = the right-click direction round the three states. */
  onToggle: (id: string, back?: boolean) => void;
  highlight?: string;
  orMode?: boolean;
  onToggleOr?: () => void;
  /** Given, the open section gets a pencil: pressed, a chip click renames that
   *  chip instead of filtering on it — the card page's gesture (pick the tag,
   *  then rename it) turned round, because here a click on a chip is already
   *  taken. It stays pressed across renames, since cleaning up after an import
   *  is several in a row (user's call, 2026-11-01). */
  onRename?: (id: string) => void;
}) {
  const [open, setOpen] = useState(() => activeMap.size > 0);
  const [renaming, setRenaming] = useState(false);
  const showOrToggle = !!onToggleOr;

  const chip = (id: string, isFolder: boolean) => {
    // Every chip is a legal pick while renaming: a greyed-out chip only means
    // no card would match the filter, which has nothing to do with its name.
    // One look for all of them, dashed, so the mode cannot be mistaken for the
    // filter quietly no longer answering.
    if (renaming && onRename) {
      return (
        <button
          key={id}
          class={`text-xs px-2 py-0.5 rounded-full border border-dashed border-accent/60 text-primary hoverable:border-accent hoverable:text-accent transition-colors cursor-pointer ${isFolder ? 'inline-flex items-center gap-1' : ''}`}
          title={titleOf(id)}
          onClick={() => onRename(id)}
          onContextMenu={(e) => { e.preventDefault(); onRename(id); }}
        >
          {isFolder && <span class="flex items-center shrink-0"><FolderIcon size={12} /></span>}
          {labelOf(id)}
        </button>
      );
    }
    const state        = activeMap.get(id);
    const isAvail      = state !== undefined || available.has(id);
    const label        = labelOf(id);
    const isHighlighted = !!highlight && state === undefined &&
      matchesSearch(label, highlight);
    const isCovered    = state === undefined && !!covered?.has(id);
    return (
      <button
        key={id}
        disabled={!isAvail && !orMode}
        class={`text-xs px-2 py-0.5 rounded-full border transition-colors ${isFolder ? 'inline-flex items-center gap-1' : ''} ${
          state === 'include' ? 'bg-accent text-white border-accent cursor-pointer' :
          state === 'exclude' ? 'bg-danger/10 text-danger border-danger/50 line-through cursor-pointer' :
          isHighlighted       ? `bg-warn/10 text-warn border-warn/40 ${isAvail || orMode ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}` :
          isCovered           ? 'border-accent/50 text-primary hoverable:border-accent hoverable:text-accent cursor-pointer' :
          isAvail             ? 'border-border text-muted hoverable:border-accent hoverable:text-accent cursor-pointer' :
          orMode              ? 'border-border text-muted opacity-50 hoverable:border-accent hoverable:text-accent cursor-pointer' :
                                'border-border text-muted opacity-40 cursor-not-allowed'
        }`}
        title={titleOf(id)}
        onClick={() => onToggle(id)}
        // Right click walks the ring backwards. preventDefault because
        // a chip has no browser menu worth showing, and `disabled`
        // buttons never fire this anyway.
        onContextMenu={(e) => { e.preventDefault(); onToggle(id, true); }}
      >
        {isFolder && <span class="flex items-center shrink-0"><FolderIcon size={12} /></span>}
        {label}
      </button>
    );
  };

  // Indented (user's pick, 2026-11-09, after trying outlined boxes, folding,
  // and one line per top-level group: none read as clearly, whatever the room
  // this takes). A group's chip alone on its line; under it, one step in, a
  // line of its values, then its own groups; the top level's plain values
  // close the section.
  const step = (depth: number) => ({ paddingLeft: `${depth * 0.875}rem` });
  /** One line of values, `depth` steps in. */
  const valueRow = (values: FilterTreeNode[], depth: number): ComponentChildren => values.length > 0 && (
    <div class="flex flex-wrap items-center gap-1.5" style={step(depth)}>
      {values.map(v => chip(v.id, false))}
    </div>
  );
  const groupRow = (node: FilterTreeNode, depth: number): ComponentChildren => (
    <div key={node.id} class="space-y-1">
      <div class="flex items-center" style={step(depth)}>{chip(node.id, true)}</div>
      {valueRow(node.children.filter(c => !isGroupNode(c)), depth + 1)}
      {node.children.filter(isGroupNode).map(g => groupRow(g, depth + 1))}
    </div>
  );
  const level = (nodes: FilterTreeNode[]): ComponentChildren => (
    <div class="space-y-1">
      {nodes.filter(isGroupNode).map(g => groupRow(g, 0))}
      {valueRow(nodes.filter(n => !isGroupNode(n)), 0)}
    </div>
  );

  return (
    <div>
      <div class="flex items-center">
        <button
          class="flex items-center gap-1.5 text-xs text-dim hover:text-primary transition-colors py-0.5"
          // Folding the section leaves the rename mode: reopened, its chips
          // filter again, as anyone coming back to it would expect.
          onClick={() => { if (open) setRenaming(false); setOpen(o => !o); }}
        >
          <span class={`flex items-center shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
            <ChevronDownIcon size={12} />
          </span>
          <span>{t(labelKey)}</span>
        </button>
        {/* 32 px targets with a negative margin, so the heading line keeps
            the height of its text and the sections stay as tight as before. */}
        {showOrToggle && (
          <IconButton
            class="ml-1 -my-1.5"
            label={orMode ? t('library.filter.or') : t('library.filter.and')}
            onClick={() => onToggleOr()}
          >
            {orMode ? <VennOrIcon size={16} /> : <VennAndIcon size={16} />}
          </IconButton>
        )}
        {/* Only on an open section: the pencil acts on chips, so it shows
            with them (user's call, 2026-11-01). Its pressed state is the
            accent tint, which a hover never puts on. */}
        {open && onRename && (
          <IconButton
            class="ml-1 -my-1.5"
            on={renaming}
            label={t('library.tags.rename.mode')}
            aria-pressed={renaming}
            onClick={() => setRenaming(r => !r)}
          >
            <PencilIcon size={12} />
          </IconButton>
        )}
        {open && renaming && onRename && (
          <span class="ml-1.5 text-xs text-accent">{t('library.tags.rename.hint')}</span>
        )}
      </div>
      {open && tree && (
        <div class="pt-1">{level(tree)}</div>
      )}
      {open && !tree && (
        <div class="flex flex-wrap items-center gap-1.5 pt-1">
          {folderItems.map(id => chip(id, true))}
          {folderItems.length > 0 && items.length > 0 && <span class="w-px h-4 bg-border mx-0.5" aria-hidden="true" />}
          {items.map(id => chip(id, false))}
        </div>
      )}
    </div>
  );
}

/** Several sections under one heading, folded like a section (2026-11-05: the
 *  analyser's "Cards", holding its decks and card tags). Folding hides them,
 *  it never switches them off — as with a section's own chips — so the label
 *  turns accent while one of them filters, the one sign of it left in sight.
 *  Opens on arrival when it holds a filter, like the sections inside it. */
export function FilterGroup({ labelKey, active, children }: {
  labelKey: string;
  active: boolean;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(active);
  return (
    <div>
      <button
        class="flex items-center gap-1.5 text-xs text-dim hover:text-primary transition-colors py-0.5"
        onClick={() => setOpen(o => !o)}
      >
        <span class={`flex items-center shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
          <ChevronDownIcon size={12} />
        </span>
        <span class={active ? 'text-accent' : ''}>{t(labelKey)}</span>
      </button>
      {/* Set in under a rule from the chevron, so the sections read as its. */}
      {open && <div class="ml-[4px] pl-3 border-l border-border space-y-1 pt-0.5">{children}</div>}
    </div>
  );
}

/** Whether a list's filter sections show, behind the funnel button beside its
 *  search box — hidden by default, to lighten the screen (user's call,
 *  2026-11-01).
 *
 *  `count` = the chips and dates that do filter the list, as the screen reads
 *  them (a chip naming something deleted since does not count). While there
 *  is one, the sections show and cannot be hidden: the button then CLEARS the
 *  filters instead, so no filter ever narrows the list out of sight. Once one
 *  has been active the sections stay open after it goes — cleared by the
 *  button or chip by chip — rather than folding away under the finger; the
 *  next press hides them.
 *
 *  An effect rather than a value taken at mount: the analyser learns which of
 *  its pinned analyses still exist only once it has read them, after mount. */
export function useFiltersPanel(count: number, clear: () => void): { shown: boolean; press: () => void } {
  const active = count > 0;
  const [open, setOpen] = useState(active);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  return {
    shown: open || active,
    press: () => {
      if (active) { clear(); setOpen(true); }
      else setOpen(o => !o);
    },
  };
}

/** The funnel beside a search box (see useFiltersPanel). Its label when there
 *  is room for it. With a filter active it changes face — accent, the funnel
 *  crossed out, how many — because its press then clears them all, and a
 *  press meant to fold the sections away must not do that by surprise. */
export function FiltersButton({ shown, count, onPress, tour }: {
  shown: boolean;
  count: number;
  onPress: () => void;
  /** The walkthrough's handle (data-tour), only while the sections are hidden:
   *  a step that has the user press it must never press "clear", nor fold away
   *  the sections the next step lights. */
  tour?: string;
}) {
  const active = count > 0;
  const title = t(active ? 'library.filters.clear' : shown ? 'library.filters.hide' : 'library.filters.show');
  return (
    <button
      type="button"
      class={`shrink-0 inline-flex items-center gap-1.5 px-2.5 rounded-md border text-xs transition-colors cursor-pointer ${
        active ? 'bg-accent/10 border-accent text-accent hoverable:bg-accent/20' :
        shown  ? 'border-accent/50 text-primary hoverable:border-accent' :
                 'border-border text-muted hoverable:border-accent hoverable:text-primary'
      }`}
      title={title}
      aria-label={title}
      aria-expanded={shown}
      data-tour={shown ? undefined : tour}
      onClick={onPress}
    >
      {active ? <FilterClearIcon size={14} /> : <FilterIcon size={14} />}
      <span class="hidden sm:inline">{t('library.filters')}</span>
      {active && <span class="font-semibold tabular-nums">{count}</span>}
    </button>
  );
}

/** The library's "reviewed between" filter — a deliberate twin of the section
 *  above rather than a variant of it: the two share a visual grammar (chevron,
 *  label, opened when it carries something) and nothing else. Chips answer "is
 *  this tag on the card"; these two dates answer a question about the card's
 *  history, which has no chip to click and no availability to grey out.
 *
 *  Empty ends are open ends, so "everything since 1 September" needs one date,
 *  not a made-up upper bound. Both empty = no filter at all, which is why the
 *  caller can leave the whole thing collapsed and lose nothing.
 *
 *  Also the analyser's "detected between" (2026-11-05), which bounds when a
 *  tune was PLAYED rather than reviewed — the same two dates, under its own
 *  label. */
export function ReviewedRangeSection({ from, to, onChange, labelKey = 'library.filterReviewed' }: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  labelKey?: string;
}) {
  const [open, setOpen] = useState(() => from !== '' || to !== '');
  const active = from !== '' || to !== '';
  return (
    <div>
      <div class="flex items-center">
        <button
          class="flex items-center gap-1.5 text-xs text-dim hover:text-primary transition-colors py-0.5"
          onClick={() => setOpen(o => !o)}
        >
          <span class={`flex items-center shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
            <ChevronDownIcon size={12} />
          </span>
          <span class={active ? 'text-accent' : ''}>{t(labelKey)}</span>
        </button>
      </div>
      {open && (
        <div class="flex flex-wrap items-center gap-1.5 pt-1">
          {/* In the date format of the settings (dateField.tsx), not the
              browser's: read when the field is left, or picked. */}
          <DateField
            class="input py-0.5 px-2 text-xs w-auto"
            value={from}
            max={to || undefined}
            title={t('library.filterReviewed.from')}
            onChange={(v) => onChange(v, to)}
          />
          <span class="text-xs text-dim">–</span>
          <DateField
            class="input py-0.5 px-2 text-xs w-auto"
            value={to}
            min={from || undefined}
            title={t('library.filterReviewed.to')}
            onChange={(v) => onChange(from, v)}
          />
          {active && (
            <button
              class="text-xs text-muted hover:text-danger transition-colors cursor-pointer px-1"
              onClick={() => onChange('', '')}
            >
              {t('library.filterReviewed.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
