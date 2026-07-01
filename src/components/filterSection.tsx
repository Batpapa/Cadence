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
