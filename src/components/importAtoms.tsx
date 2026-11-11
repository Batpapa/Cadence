// The lookup field and its suggestion list, shared by the two tune imports
// (theSessionImport.tsx, irishTuneInfoImport.tsx). Each file used to keep its
// own copy, and the copies had started to drift (the walkthrough marker below
// was on one list only). Their tab bars are the shared `Segmented` now.
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChild, RefObject } from 'preact';
import { getZoom } from '../services/zoomService';
import { InlineStatus } from './ui';

/** The status line under an import says how it went: an error is red and
 *  marked, a finished import is marked done. Both used to be the same grey
 *  line as "Fetching…". Progress and neutral outcomes stay plain text. */
export const errorLine = (msg: string): ComponentChild => <InlineStatus tone="error">{msg}</InlineStatus>;
export const successLine = (msg: ComponentChild): ComponentChild => <InlineStatus tone="success">{msg}</InlineStatus>;

/** A field drawn as `.input`, with an inline right-side info span (what the
 *  typed text resolves to), wired to a floating <SuggestDropdown>. The frame
 *  is the `.input`, not the <input> inside it, so the info sits within it. */
export function InputRow({ placeholder, value, onInput, info, inputRef, title, onKeyDown, onFocus, onBlur, maxLength, disabled }: {
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
  info: string;
  inputRef: RefObject<HTMLInputElement>;
  title?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <div class="input flex-1 relative flex items-center focus-within:border-accent overflow-hidden" title={title}>
      <input
        ref={inputRef}
        type="text"
        class="flex-1 min-w-0 bg-transparent outline-none text-sm text-primary placeholder:text-dim"
        placeholder={placeholder}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={(e) => {
          // Pasting a newline-separated list into a single-line input drops
          // the newlines on some browsers — normalize to ';' before it hits onInput.
          const text = e.clipboardData?.getData('text');
          if (!text || !/[\r\n]/.test(text)) return;
          e.preventDefault();
          const el = e.target as HTMLInputElement;
          const cleaned = text.replace(/[\r\n]+/g, ';');
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          const next = el.value.slice(0, start) + cleaned + el.value.slice(end);
          onInput(next);
        }}
      />
      <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dim bg-bg pl-2 pointer-events-none whitespace-nowrap">{info}</span>
    </div>
  );
}

/** Floating suggestion list anchored under an input — position computed at
 *  open-time (and whenever `items` changes), portaled to document.body so it
 *  isn't clipped by the modal's own overflow. Unmounts along with whatever
 *  renders it — no manual cleanup needed. */
export function SuggestDropdown<T>({ anchorRef, items, renderItem, onPick, open, tourFloat = false }: {
  anchorRef: RefObject<HTMLElement>;
  items: T[];
  renderItem: (item: T) => ComponentChild;
  onPick: (item: T) => void;
  open: boolean;
  /** Belongs to a field a walkthrough drives: lifted over its veil and
   *  pickable from it (walkthrough/, styles.css). Only TheSession's lists
   *  are in a walkthrough. */
  tourFloat?: boolean;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open || !anchorRef.current || items.length === 0) { setPos(null); return; }
    const z = getZoom() / 100;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({ top: (rect.bottom + 4) / z, left: rect.left / z, width: rect.width / z });
    // eslint-disable-next-line
  }, [open, items]);

  if (!open || !pos || items.length === 0) return null;

  return createPortal((
    <div
      data-tour-float={tourFloat ? '' : undefined}
      class="fixed z-[100] bg-elevated border border-border rounded-lg shadow-2xl overflow-y-auto"
      style={{ top: `${pos.top}px`, left: `${pos.left}px`, width: `${pos.width}px`, maxHeight: '220px' }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          class="flex items-center gap-3 px-3 py-2 hover:bg-bg cursor-pointer"
          onMouseDown={(e) => { e.preventDefault(); onPick(item); }}
        >
          {renderItem(item)}
        </div>
      ))}
    </div>
  ), document.body);
}
