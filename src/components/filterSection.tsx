import { useState } from 'preact/hooks';
import type { FilterState } from '../types';
import { t } from '../services/i18nService';
import { ChevronDownIcon, VennAndIcon, VennOrIcon } from './icons';

export type FilterMap = Map<string, FilterState>;

export function cycleFilter(prev: FilterMap, key: string): FilterMap {
  const n = new Map(prev);
  const s = n.get(key);
  if (s === undefined)       n.set(key, 'include');
  else if (s === 'include')  n.set(key, 'exclude');
  else                       n.delete(key);
  return n;
}

export function FilterSection({ labelKey, items, activeMap, labelOf, titleOf, available, onToggle, highlight, orMode, onToggleOr }: {
  labelKey: string;
  items: string[];
  activeMap: FilterMap;
  labelOf: (id: string) => string;
  titleOf: (id: string) => string;
  available: Set<string>;
  onToggle: (id: string) => void;
  highlight?: string;
  orMode?: boolean;
  onToggleOr?: () => void;
}) {
  const [open, setOpen] = useState(() => activeMap.size > 0);
  const showOrToggle = !!onToggleOr;
  return (
    <div>
      <div class="flex items-center">
        <button
          class="flex items-center gap-1.5 text-xs text-dim hover:text-primary transition-colors py-0.5"
          onClick={() => setOpen(o => !o)}
        >
          <span class={`flex items-center shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
            <ChevronDownIcon size={10} />
          </span>
          <span>{t(labelKey)}</span>
        </button>
        {showOrToggle && (
          <button
            class="ml-1 flex items-center p-0.5 rounded text-muted hover:text-primary transition-colors"
            title={orMode ? t('library.filter.or') : t('library.filter.and')}
            onClick={() => onToggleOr()}
          >
            {orMode ? <VennOrIcon size={15} /> : <VennAndIcon size={15} />}
          </button>
        )}
      </div>
      {open && (
        <div class="flex flex-wrap gap-1.5 pt-1">
          {items.map(id => {
            const state        = activeMap.get(id);
            const isAvail      = state !== undefined || available.has(id);
            const label        = labelOf(id);
            const isHighlighted = !!highlight && state === undefined &&
              label.toLowerCase().includes(highlight.toLowerCase());
            return (
              <button
                key={id}
                disabled={!isAvail && !orMode}
                class={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  state === 'include' ? 'bg-accent text-white border-accent cursor-pointer' :
                  state === 'exclude' ? 'bg-danger/10 text-danger border-danger/50 line-through cursor-pointer' :
                  isHighlighted       ? `bg-warn/10 text-warn border-warn/40 ${isAvail || orMode ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}` :
                  isAvail             ? 'border-border text-muted hover:border-accent hover:text-accent cursor-pointer' :
                  orMode              ? 'border-border text-muted opacity-50 hover:border-accent hover:text-accent cursor-pointer' :
                                        'border-border text-muted opacity-30 cursor-not-allowed'
                }`}
                title={titleOf(id)}
                onClick={() => onToggle(id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
 *  caller can leave the whole thing collapsed and lose nothing. */
export function ReviewedRangeSection({ from, to, onChange }: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
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
            <ChevronDownIcon size={10} />
          </span>
          <span class={active ? 'text-accent' : ''}>{t('library.filterReviewed')}</span>
        </button>
      </div>
      {open && (
        <div class="flex flex-wrap items-center gap-1.5 pt-1">
          <input
            type="date"
            class="input py-0.5 px-2 text-xs w-auto"
            value={from}
            max={to || undefined}
            title={t('library.filterReviewed.from')}
            onInput={(e) => onChange((e.target as HTMLInputElement).value, to)}
          />
          <span class="text-xs text-dim">–</span>
          <input
            type="date"
            class="input py-0.5 px-2 text-xs w-auto"
            value={to}
            min={from || undefined}
            title={t('library.filterReviewed.to')}
            onInput={(e) => onChange(from, (e.target as HTMLInputElement).value)}
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
