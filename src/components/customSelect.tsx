import { useState, useEffect, useRef } from 'preact/hooks';

export function CustomSelect({ value, options, onChange, triggerClass }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  triggerClass: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const label = options.find(o => o.value === value)?.label ?? '';

  return (
    <div class="relative" ref={ref}>
      <button
        type="button"
        class={triggerClass}
        onClick={() => setOpen(o => !o)}
      >
        <span class="truncate flex-1 text-left">{label}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div class="absolute left-0 top-full z-40 mt-1 bg-elevated border border-border rounded-lg shadow-xl py-1 min-w-full max-h-52 overflow-y-auto">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              class={`w-full text-left px-3 py-1.5 text-xs cursor-pointer truncate ${opt.value === value ? 'text-accent bg-accent/5' : 'text-muted hover:bg-surface'}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
