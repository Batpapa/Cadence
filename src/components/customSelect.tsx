import { useState, useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { render, type ComponentChild } from 'preact';
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

/** Height the list is allowed before it prefers to open upwards. */
const PANEL_MAX_H = 208; // matches max-h-52

/** Where the panel goes, in unzoomed pixels: hanging under the trigger
 *  (`top`), or standing over it (`bottom`) when the bottom of the window is
 *  nearer than the list is tall and there is more room above. */
type PanelPos = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number });

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
  const [pos, setPos] = useState<PanelPos | null>(null);
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

  // A dropdown is something on top too: the back gesture should put it away
  // rather than navigate out from under it.
  useEffect(() => (open ? registerOverlay(() => setOpen(false)) : undefined), [open]);

  // Placed in viewport coordinates, so anything that moves the trigger
  // afterwards — a scroll, usually a container's (hence the capture phase), a
  // resize — has it placed again, rather than left stranded beside nothing.
  // It used to CLOSE here ("a select is a moment", 2026-09-06), while the
  // select of the dialogs built by hand followed its trigger: closing was its
  // first answer and it was wrong — a score playing back scrolls itself to
  // follow the cursor, which shut the list under the user's hand (the ABC
  // preferences, 2026-09-04). One select since 2026-11-26, which follows.
  //
  // Divided by the zoom: a `position: fixed` element placed from
  // getBoundingClientRect would otherwise be scaled twice when the app runs
  // at anything but 100% (see zoomService).
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      if (!ref.current) return;
      const z = getZoom() / 100;
      const r = ref.current.getBoundingClientRect();
      const width = Math.max(r.width / z, MIN_PANEL_PX);
      // Pulled back inside when the floor above makes the panel wider than the
      // trigger it hangs from, and that trigger sits near the right edge.
      const anchor = align === 'right' ? r.right / z - width : r.left / z;
      const left = Math.max(8, Math.min(anchor, window.innerWidth / z - width - 8));
      const below = r.bottom / z, above = r.top / z;
      const viewportH = window.innerHeight / z;
      // Its height: max-h-52, or the room there is, down to a floor.
      const fit = (room: number) => Math.min(PANEL_MAX_H, Math.max(80, room - 8));
      setPos(viewportH - below < PANEL_MAX_H && above > viewportH - above
        ? { left, width, bottom: viewportH - above + 4, maxHeight: fit(above) }
        : { left, width, top: below + 4, maxHeight: fit(viewportH - below) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
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
          reason. The app's one menu surface and row (UI charter, 2026-11-11). */}
      {open && pos && createPortal((
        <div
          ref={panelRef}
          class="fixed z-[100] menu-surface max-h-52 overflow-y-auto"
          style={{
            left: `${pos.left}px`, width: `${pos.width}px`, maxHeight: `${pos.maxHeight}px`,
            ...('top' in pos ? { top: `${pos.top}px` } : { bottom: `${pos.bottom}px` }),
          }}
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

/** The same select in a dialog built by hand, with no Preact around it (the
 *  ABC preferences): mounted into an element of its own, which the caller
 *  places — `flex: 1`, so it takes what its row leaves. Its value lives here,
 *  `onChange` hearing each pick. `dispose` takes it down with the dialog: an
 *  open list holds listeners and a place among the overlays. Until
 *  2026-11-26 this was a copy of the select in plain DOM, and the two had
 *  drifted apart. */
export function mountCustomSelect(
  options: Array<{ value: string; label: string }>,
  initial: string,
  onChange: (v: string) => void,
  triggerClass: string,
): { el: HTMLElement; getValue: () => string; dispose: () => void } {
  const el = document.createElement('div');
  el.style.position = 'relative';
  el.style.flex = '1';
  let value = initial;
  const draw = () => render(
    <CustomSelect value={value} options={options} triggerClass={triggerClass}
      onChange={(v) => { value = v; draw(); onChange(v); }} />,
    el,
  );
  draw();
  return { el, getValue: () => value, dispose: () => render(null, el) };
}
