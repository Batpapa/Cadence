import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { getZoom } from '../services/zoomService';
import { useLongPress } from './longPress';

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
  const { firedRef: _longPressFired, ...longPress } = useLongPress(open);

  useEffect(() => {
    if (!pos) return;
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
      document.removeEventListener('keydown', onKey);
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
      class="fixed z-[100] bg-elevated border border-border rounded-lg shadow-2xl overflow-hidden py-1 min-w-[180px]"
      style={{
        left:   pos.left   !== undefined ? `${pos.left}px`   : undefined,
        right:  pos.right  !== undefined ? `${pos.right}px`  : undefined,
        top:    pos.top    !== undefined ? `${pos.top}px`    : undefined,
        bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined,
      }}
    >
      {items.map((item, i) => isHeading(item) ? (
        <div
          key={`h:${item.heading}`}
          class={`px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-dim ${
            i === 0 ? 'pt-1' : 'mt-1 pt-2 border-t border-border'
          }`}
        >
          {item.heading}
        </div>
      ) : (
        <button
          key={item.label}
          class={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left cursor-pointer border-none bg-transparent transition-colors ${
            item.danger ? 'text-danger hover:bg-danger/10' : 'text-primary hover:bg-surface'
          }`}
          onClick={() => { close(); item.onClick(); }}
        >
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
