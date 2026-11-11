import { useState, useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { getZoom } from '../services/zoomService';
import { registerOverlay } from './overlayStack';
import { ChevronDownIcon } from './icons';

/** A panel is never narrower than this, whatever its trigger measures.
 *
 *  The width normally follows the trigger, which is right for a full-width
 *  select and wrong for a small inline one: the analyses library's "Dossier :"
 *  row is a text button the width of the current folder's NAME, so its list
 *  came out a few characters wide and every option read "A…". A floor rather
 *  than a per-caller prop — a list narrower than its own options is unusable
 *  wherever it happens, and anything already wider is untouched. */
const MIN_PANEL_PX = 180;

export function CustomSelect({ value, options, onChange, triggerClass, renderTrigger, align = 'left' }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  triggerClass?: string;
  renderTrigger?: (label: string, open: boolean, toggle: () => void) => ComponentChild;
  /** Which edge of the trigger the panel lines up with when it is wider than
   *  the trigger (MIN_PANEL_PX). 'right' for a small trigger at the end of a
   *  line — the analyser settings' network choice — whose list would
   *  otherwise hang out past the card it belongs to (2026-10-09). */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  // Where the panel goes once it is out of the flow — see the portal below.
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggle = () => setOpen(o => !o);

  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown: Safari on iOS only sends mouse events to what
    // it deems clickable, so a tap on empty space left the list open.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // BOTH, because the panel is no longer a descendant of the wrapper:
      // testing only the wrapper would close the list on the very mousedown
      // that is choosing an option, and the click that follows would land on
      // nothing.
      if (!ref.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // The panel is placed once, in viewport coordinates, so anything that moves
  // the trigger afterwards would leave it stranded beside nothing. Closing is
  // the honest answer — a select is a moment, not a state to maintain. Capture
  // phase because the scrolling is usually a container's, not the window's.
  //
  // Except the list's own scrolling — a long list scrolled to reach an option
  // closed under the finger. Capture phase sees that one too.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) setOpen(false); };
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
    const anchor = align === 'right' ? r.right / z - width : r.left / z;
    const left = Math.max(8, Math.min(anchor, window.innerWidth / z - width - 8));
    setPos({ top: (r.bottom + 4) / z, left, width });
  }, [open]);

  const label = options.find(o => o.value === value)?.label ?? '';

  return (
    <div class="relative" ref={ref}>
      {renderTrigger ? renderTrigger(label, open, toggle) : (
        <button type="button" class={triggerClass} onClick={toggle}>
          <span class="truncate flex-1 text-left">{label}</span>
          <span class={`shrink-0 flex transition-transform ${open ? 'rotate-180' : ''}`}><ChevronDownIcon size={12} /></span>
        </button>
      )}
      {/* Portaled to the body rather than positioned inside the wrapper: an
          absolutely placed panel is clipped by any scrolling ancestor, which is
          what a modal body is as soon as its content is a little tall. Same
          treatment as the import screen's suggestion list, for the same
          reason. The app's one menu surface and row (UI charter, 2026-11-11),
          the same as the vanilla select's (customSelectVanilla.ts). */}
      {open && pos && createPortal((
        <div
          ref={panelRef}
          class="fixed z-[100] menu-surface max-h-52 overflow-y-auto"
          style={{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.width}px` }}
        >
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              class={`menu-item${opt.value === value ? ' menu-item-on' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              <span class="truncate">{opt.label}</span>
            </button>
          ))}
        </div>
      ), document.body)}
    </div>
  );
}
