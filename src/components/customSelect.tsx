import { useState, useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { getZoom } from '../services/zoomService';
import { registerOverlay } from './overlayStack';

/** A panel is never narrower than this, whatever its trigger measures.
 *
 *  The width normally follows the trigger, which is right for a full-width
 *  select and wrong for a small inline one: the analyses library's "Dossier :"
 *  row is a text button the width of the current folder's NAME, so its list
 *  came out a few characters wide and every option read "A…". A floor rather
 *  than a per-caller prop — a list narrower than its own options is unusable
 *  wherever it happens, and anything already wider is untouched. */
const MIN_PANEL_PX = 180;

export function CustomSelect({ value, options, onChange, triggerClass, renderTrigger }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  triggerClass?: string;
  renderTrigger?: (label: string, open: boolean, toggle: () => void) => ComponentChild;
}) {
  const [open, setOpen] = useState(false);
  // Where the panel goes once it is out of the flow — see the portal below.
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggle = () => setOpen(o => !o);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // BOTH, because the panel is no longer a descendant of the wrapper:
      // testing only the wrapper would close the list on the very mousedown
      // that is choosing an option, and the click that follows would land on
      // nothing.
      if (!ref.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // The panel is placed once, in viewport coordinates, so anything that moves
  // the trigger afterwards would leave it stranded beside nothing. Closing is
  // the honest answer — a select is a moment, not a state to maintain. Capture
  // phase because the scrolling is usually a container's, not the window's.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // A dropdown is something on top too: the back gesture should put it away
  // rather than navigate out from under it.
  useEffect(() => (open ? registerOverlay(() => setOpen(false)) : undefined), [open]);

  useEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    // Divided by the zoom: a `position: fixed` element placed from
    // getBoundingClientRect would otherwise be scaled twice when the app runs
    // at anything but 100% (see zoomService).
    const z = getZoom() / 100;
    const r = ref.current.getBoundingClientRect();
    const width = Math.max(r.width / z, MIN_PANEL_PX);
    // Pulled back inside when the floor above makes the panel wider than the
    // trigger it hangs from, and that trigger sits near the right edge.
    const left = Math.max(8, Math.min(r.left / z, window.innerWidth / z - width - 8));
    setPos({ top: (r.bottom + 4) / z, left, width });
  }, [open]);

  const label = options.find(o => o.value === value)?.label ?? '';

  return (
    <div class="relative" ref={ref}>
      {renderTrigger ? renderTrigger(label, open, toggle) : (
        <button type="button" class={triggerClass} onClick={toggle}>
          <span class="truncate flex-1 text-left">{label}</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      )}
      {/* Portaled to the body rather than positioned inside the wrapper: an
          absolutely placed panel is clipped by any scrolling ancestor, which is
          what a modal body is as soon as its content is a little tall. Same
          treatment as the import screen's suggestion list, for the same
          reason. */}
      {open && pos && createPortal((
        <div
          ref={panelRef}
          class="fixed z-[100] bg-elevated border border-border rounded-lg shadow-xl py-1 max-h-52 overflow-y-auto"
          style={{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.width}px` }}
        >
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
      ), document.body)}
    </div>
  );
}
