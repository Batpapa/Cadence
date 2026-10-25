import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

// ── A small menu behind a button ──────────────────────────────────────────────
// The Session's own disclosure, as on a tune's "Play audio" and "download"
// (thesession.org/tunes/2266, 2026-10-25): under the button, a gold
// "clapperboard" panel that swings down — rows of a label and its box (their
// "repeat"), small brick buttons for actions (their ABC / midi). The button
// itself stays a bare glyph (the user's call): two brick buttons on every
// analysis's title weighed too much. The behaviour is the app's context menu's (contextMenu.tsx):
// closed by a click outside or Escape, opening upwards when the frame has no
// room below.
//
// Fixed to the frame rather than placed inside its button's line: the list of
// analyses scrolls, and would cut a panel opened inside it. So it closes when
// that list scrolls, as the button it hangs from moves away.
//
// Entries: a box that stays ticked (the panel stays open, so several can be
// set in one go), an action (which closes it), or a piece of content of its
// own — the pitch's stepper, which also leaves it open.

export interface MenuToggle {
  kind: 'toggle';
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface MenuAction {
  kind: 'action';
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is off, said on hover. */
  hint?: string;
}

/** Anything else the panel holds — the pitch's stepper. It stays open. */
export interface MenuContent {
  kind: 'content';
  key: string;
  content: ComponentChildren;
}

export type MenuEntry = MenuToggle | MenuAction | MenuContent;

let ids = 0;

export function Menu({ icon, label, entries, disabled, busy, class: className }: {
  icon: ComponentChildren;
  /** On the button, beside `icon-button`. */
  class?: string;
  /** The button's name, for hover and screen readers. */
  label: string;
  entries: MenuEntry[];
  disabled?: boolean;
  /** Something it started is still running: the button says so and waits. */
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** Where it hangs, in the frame's own pixels: under the button, its right
   *  edge on the button's — or above it, when there is no room below. */
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [panelId] = useState(() => `menu-${++ids}`);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = (e: Event) => { if (!listRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onScroll);
    };
  }, [open]);

  // Measured once it is on screen: below if it fits under the button, above
  // otherwise — a frame is short, and the bottom of it cuts. Joined to the
  // button, as The Session's panel is (its top border tucked under it).
  useLayoutEffect(() => {
    if (!open || !rootRef.current || !listRef.current) { setPos(null); return; }
    const anchor = rootRef.current.getBoundingClientRect();
    const height = listRef.current.offsetHeight;
    const right = Math.max(4, document.documentElement.clientWidth - anchor.right);
    const upwards = anchor.bottom + height > innerHeight && anchor.top - height > 0;
    setPos(upwards ? { right, bottom: innerHeight - anchor.top - 1 } : { right, top: anchor.bottom - 1 });
  }, [open]);

  return (
    <span class="menu" ref={rootRef}>
      <button
        type="button"
        class={`icon-button${className ? ` ${className}` : ''}`}
        title={label}
        aria-label={label}
        aria-controls={panelId}
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={() => setOpen(!open)}
      >{busy ? <span class="busy" aria-hidden="true">…</span> : icon}</button>
      {open && (
        <div
          id={panelId}
          class={`clapperboard feedback${pos?.bottom !== undefined ? ' up' : ''}`}
          role="menu"
          aria-label={label}
          ref={listRef}
          // Measured before it is placed: hidden for that one frame.
          style={pos
            ? { right: `${pos.right}px`, top: pos.top !== undefined ? `${pos.top}px` : undefined, bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined }
            : { visibility: 'hidden', top: '0px', right: '0px' }}
        >
          {entries.map(e => e.kind === 'content' ? (
            <div key={e.key} class="menu-content">{e.content}</div>
          ) : e.kind === 'toggle' ? (
            <label key={e.label} class="bill-item" role="menuitemcheckbox" aria-checked={e.checked}>
              <span class="bill-item-title">{e.label}</span>
              <span class="bill-item-cost">
                <input type="checkbox" checked={e.checked} onChange={ev => e.onChange((ev.target as HTMLInputElement).checked)} />
              </span>
            </label>
          ) : (
            <button
              key={e.label}
              type="button"
              role="menuitem"
              class="button discrete"
              disabled={e.disabled}
              title={e.disabled ? e.hint : undefined}
              onClick={() => { setOpen(false); e.onClick(); }}
            >{e.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}
