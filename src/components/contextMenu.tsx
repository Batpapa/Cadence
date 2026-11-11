import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChild } from 'preact';
import { createPortal } from 'preact/compat';
import { getZoom } from '../services/zoomService';
import { useLongPress } from './longPress';
import { registerOverlay } from './overlayStack';

// ── Context menu (right-click / long-press) ──────────────────────────────────
// Generic, not card-specific: anchors a small menu at the click/touch point
// rather than at a trigger element's rect (unlike header.tsx's profile
// dropdown, the closest existing anchored-popover precedent, which anchors to
// a button). Same dismissal idioms as that dropdown though — document-level
// mousedown/touchstart to close on an outside click, Escape, portal to
// document.body, zoom-compensated fixed coordinates (CSS zoom on <html> means
// getBoundingClientRect()/clientX/clientY need dividing by getZoom()/100).
//
// The long-press gesture itself is shared (components/longPress.ts) with the
// library's long-press range-select (#X) — same detection, different things
// done with it: this hook opens a menu, the library simulates a Shift+click.

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Optional leading glyph. The row is already a flex line with a gap, so a
   *  menu where only some entries carry one still keeps its labels aligned. */
  icon?: ComponentChild;
}

/** A labelled divider grouping the items that follow it. Used where a menu
 *  mixes actions of different natures — the library's bulk menu ends with the
 *  operations that only apply to cards imported from a given site, and the
 *  heading is what says which site (and how many of the selection it covers)
 *  before you commit to a network round trip. */
export interface ContextMenuHeading {
  heading: string;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuHeading;

const isHeading = (e: ContextMenuEntry): e is ContextMenuHeading => 'heading' in e;

/** Anchor point + which corner of the menu it pins, in CSS-pixel space (already
 *  zoom-divided). Pinning the corner nearest the click/touch — rather than
 *  always the top-left — means the menu grows back toward the center of the
 *  screen instead of off the edge when opened near a border. */
interface MenuAnchor {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export function useContextMenu(items: ContextMenuEntry[]) {
  const [pos, setPos] = useState<MenuAnchor | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const open = (clientX: number, clientY: number) => {
    const z = getZoom() / 100;
    const x = clientX / z;
    const y = clientY / z;
    const vw = window.innerWidth / z;
    const vh = window.innerHeight / z;
    // Which half of the screen the point falls in decides which corner of the
    // menu hooks onto it: top-left point → menu anchored by its top-left
    // corner (grows right/down, toward center); bottom-right point → anchored
    // by its bottom-right corner (grows left/up), etc.
    setPos({
      ...(x > vw / 2 ? { right: vw - x } : { left: x }),
      ...(y > vh / 2 ? { bottom: vh - y } : { top: y }),
    });
  };
  const close = () => setPos(null);
  // Registered for as long as it is on screen; the cleanup drops it however
  // it was dismissed.
  useEffect(() => (pos ? registerOverlay(close) : undefined), [pos]);
  const { firedRef: _longPressFired, ...longPress } = useLongPress(open);

  useEffect(() => {
    if (!pos) return;
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    // The outside-click stays here — it is about THIS element's bounds, which
    // only this component knows. Escape does not: it is about what is topmost,
    // which is the overlay registry's business (registered just above, closed
    // from main.ts's single listener).
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
    };
  }, [pos]);

  const triggerProps = {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      open(e.clientX, e.clientY);
    },
    ...longPress,
  };

  const menu = pos ? createPortal((
    <div
      ref={menuRef}
      data-tour="context-menu"
      class="fixed z-[100] menu-surface overflow-hidden min-w-[180px]"
      style={{
        left:   pos.left   !== undefined ? `${pos.left}px`   : undefined,
        right:  pos.right  !== undefined ? `${pos.right}px`  : undefined,
        top:    pos.top    !== undefined ? `${pos.top}px`    : undefined,
        bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined,
      }}
    >
      {/* The app's one menu surface and row (styles.css, UI charter of
          2026-11-11): the ⋮ menu, this one and the select lists. */}
      {items.map((item, i) => isHeading(item) ? (
        <div
          key={`h:${item.heading}`}
          class={`menu-heading ${i === 0 ? '' : 'mt-1 border-t border-border'}`}
        >
          {item.heading}
        </div>
      ) : (
        <button
          key={item.label}
          class={`menu-item border-none${item.danger ? ' menu-item-danger' : ''}`}
          onClick={() => { close(); item.onClick(); }}
        >
          {item.icon && <span class="shrink-0 flex items-center">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  ), document.body) : null;

  // `open` is returned too so a plain button can raise the same menu on a left
  // click (the library's ⋯ overflow), not just right-click/long-press. Safe to
  // call from onClick: the outside-click listener is only attached once `pos`
  // is set, by which point this click's own mousedown has already passed.
  return { menu, triggerProps, open };
}
