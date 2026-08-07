import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { getZoom } from '../services/zoomService';

// ── Context menu (right-click / long-press) ──────────────────────────────────
// Generic, not card-specific: anchors a small menu at the click/touch point
// rather than at a trigger element's rect (unlike header.tsx's profile
// dropdown, the closest existing anchored-popover precedent, which anchors to
// a button). Same dismissal idioms as that dropdown though — document-level
// mousedown/touchstart to close on an outside click, Escape, portal to
// document.body, zoom-compensated fixed coordinates (CSS zoom on <html> means
// getBoundingClientRect()/clientX/clientY need dividing by getZoom()/100).
//
// Not reused for the library's planned long-press range-select (#X) — that
// gesture simulates a Shift+click, it doesn't open a menu, so it's a
// different behavior wired directly where needed rather than through this hook.

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

const LONG_PRESS_MS = 550;
/** Touch movement past this many px cancels the long-press (treat as a scroll/drag). */
const LONG_PRESS_MOVE_TOLERANCE = 10;

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

export function useContextMenu(items: ContextMenuItem[]) {
  const [pos, setPos] = useState<MenuAnchor | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

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

  const clearLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

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
    onTouchStart: (e: TouchEvent) => {
      longPressFired.current = false;
      const touch = e.touches[0];
      if (!touch) return;
      touchStart.current = { x: touch.clientX, y: touch.clientY };
      const { clientX, clientY } = touch;
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        open(clientX, clientY);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch || !touchStart.current) return;
      const dx = touch.clientX - touchStart.current.x;
      const dy = touch.clientY - touchStart.current.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) clearLongPress();
    },
    onTouchEnd: (e: TouchEvent) => {
      clearLongPress();
      // Suppress the native link navigation/callout that would otherwise
      // follow a long-press release once our own menu already opened.
      if (longPressFired.current) e.preventDefault();
    },
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
      {items.map(item => (
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

  return { menu, triggerProps };
}
