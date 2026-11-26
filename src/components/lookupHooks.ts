import { useEffect, useRef, useState } from 'preact/hooks';

// ── A field that looks things up as it is typed in ────────────────────────────
// The three pieces every such field had a copy of — the tune and member tabs of
// TheSession's import (theSessionImport.tsx), irishtune.info's
// (irishTuneInfoImport.tsx), the analyser's manual pick (ManualTunePick.tsx):
// which answer may land, when to ask, and the list of suggestions. Together
// since 2026-11-26.

/** Only the newest lookup gets to write. A field that previews what is being
 *  typed has several previews in flight at once — each keystroke of "12"
 *  starts one — and without this the LAST ANSWER TO ARRIVE wins rather than
 *  the last one asked for, and the two are not the same order: member 1 (the
 *  site's founder, eleven aggregate counts) answers in ~310 ms where an
 *  ordinary member or a 410 answers in ~130 ms. So "12" showed member 1 — and,
 *  far worse than a wrong caption, ARMED THE IMPORT on him: the field read 12,
 *  the button would have fetched Jeremy's 526 tunes. Doubly worth having on
 *  irishtune.info's side: its calls go through the scraper, slower and
 *  rate-limited, so answers arrive further out of order.
 *
 *  `cancel()` on every edit is half the point: it also stops an answer landing
 *  on a field the user has since cleared or changed. Debouncing merely reduces
 *  the number of racers; only this decides which one counts. Nothing lands
 *  once the field is gone either. */
export function useLatestOnly() {
  const seq = useRef(0);
  useEffect(() => () => { seq.current++; }, []);
  return {
    /** Claims the slot; the returned test says whether it is still ours. */
    begin: () => { const mine = ++seq.current; return () => mine === seq.current; },
    /** Abandons whatever is in flight — its answer will not be written. */
    cancel: () => { seq.current++; },
  };
}

/** One run waiting at a time: `schedule` replaces whatever was waiting,
 *  `cancel` drops it, and the field going drops it too. */
export function useDebounce() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return {
    schedule: (run: () => void, ms: number): void => {
      cancel();
      timer.current = setTimeout(() => { timer.current = null; run(); }, ms);
    },
    cancel,
  };
}

/** The suggestions under a field, and whether they are showing: shown as they
 *  arrive when there are any, again when the field is focused, and hidden as
 *  it loses the focus.
 *
 *  At once on the blur: it waited 150 ms for a press on a suggestion to land
 *  first, which it does anyway — SuggestDropdown picks on `mousedown`, and
 *  keeps the focus in the field (importAtoms.tsx). */
export function useSuggestions<T>() {
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  return {
    items,
    open,
    /** A new list, shown when it has anything in it. */
    show: (next: T[]): void => { setItems(next); setOpen(next.length > 0); },
    /** None any more. */
    clear: (): void => { setItems([]); setOpen(false); },
    /** Hidden, kept for the next focus. */
    close: (): void => setOpen(false),
    onFocus: (): void => { if (items.length) setOpen(true); },
    onBlur: (): void => setOpen(false),
  };
}
