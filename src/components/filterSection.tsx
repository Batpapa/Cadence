import { useState } from 'preact/hooks';
import type { FilterState } from '../types';
import { t } from '../services/i18nService';
import { ChevronDownIcon } from './icons';

export type FilterMap = Map<string, FilterState>;

export function cycleFilter(prev: FilterMap, key: string): FilterMap {
  const n = new Map(prev);
  const s = n.get(key);
  if (s === undefined)       n.set(key, 'include');
  else if (s === 'include')  n.set(key, 'exclude');
  else                       n.delete(key);
  return n;
}

export function FilterSection({ labelKey, items, activeMap, labelOf, titleOf, available, onToggle, highlight }: {
  labelKey: string;
  items: string[];
  activeMap: FilterMap;
  labelOf: (id: string) => string;
  titleOf: (id: string) => string;
  available: Set<string>;
  onToggle: (id: string) => void;
  highlight?: string;
}) {
  const [open, setOpen] = useState(() => activeMap.size > 0);
  return (
    <div>
      <button
        class="flex items-center gap-1.5 text-xs text-dim hover:text-primary transition-colors py-0.5"
        onClick={() => setOpen(o => !o)}
      >
        <span class={`flex items-center shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
          <ChevronDownIcon size={10} />
        </span>
        <span>{t(labelKey)}</span>
      </button>
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
                disabled={!isAvail}
                class={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                  state === 'include' ? 'bg-accent text-white border-accent cursor-pointer' :
                  state === 'exclude' ? 'bg-danger/10 text-danger border-danger/50 line-through cursor-pointer' :
                  isHighlighted       ? `bg-warn/10 text-warn border-warn/40 ${isAvail ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}` :
                  isAvail             ? 'border-border text-muted hover:border-accent hover:text-accent cursor-pointer' :
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
