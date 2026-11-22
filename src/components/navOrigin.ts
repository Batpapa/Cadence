// ── The row a link left from, lit up on the way back (2026-11-22) ───────────
// A row that leads elsewhere carries a key (fromAttrs), and its link passes
// that key to navigate as `from` — read off the row by originOf, so the two
// cannot disagree. Going back to that page, the scroll
// restoration flashes the row once the page is placed (flashOrigin): a gold
// ring held a moment, then gone — a bearing, not a state (the user). One key
// per row, unique on its page: two detections of one tune, two mentions of one
// card, are two keys.
//
// Drawn with the Web Animations API rather than a class: a list drawn again
// while it runs — an analysis's play head lighting another tune — rewrites
// its rows' classes and would cut a class-driven flash short.

/** The attributes of a row a link leaves from. `inset`: rows packed edge to
 *  edge, the ring drawn inside the row's box rather than over its neighbours. */
export function fromAttrs(key: string, inset = false): Record<string, string> {
  return inset ? { 'data-from': key, 'data-from-inset': '' } : { 'data-from': key };
}

/** The key of the row a click happened in: what its link passes as
 *  navigate's `from`. A link where no row carries one passes nothing. */
export function originOf(e: Event): string | undefined {
  const el = e.currentTarget instanceof Element ? e.currentTarget : e.target instanceof Element ? e.target : null;
  return el?.closest('[data-from]')?.getAttribute('data-from') ?? undefined;
}

/** How long a page may take to draw the row after it is placed: an analysis
 *  reads its detections from the disk first. */
const FIND_BUDGET_MS = 3000;
const FLASH_MS = 2200;

/** Flashes the row of `root` keyed `key`, as soon as it is drawn. Returns a
 *  cancel, for a page left before the row came. */
export function flashOrigin(root: HTMLElement, key: string): () => void {
  let raf = 0;
  const deadline = performance.now() + FIND_BUDGET_MS;
  const find = () => {
    raf = 0;
    const el = root.querySelector<HTMLElement>(`[data-from="${CSS.escape(key)}"]`);
    if (!el) {
      if (performance.now() < deadline) raf = requestAnimationFrame(find);
      return;
    }
    // The theme's own gold: TARGET_RING's colour (components/ui.tsx).
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--color-warn-ch').trim() || '251 191 36';
    const inset = el.hasAttribute('data-from-inset') ? 'inset ' : '';
    const ring = (alpha: number) => `${inset}0 0 0 2px rgb(${rgb} / ${alpha})`;
    // No fill: once over, the row's own rings and marks are back.
    el.animate(
      [{ boxShadow: ring(1), offset: 0 }, { boxShadow: ring(1), offset: 0.45 }, { boxShadow: ring(0), offset: 1 }],
      { duration: FLASH_MS, easing: 'ease-out' },
    );
  };
  raf = requestAnimationFrame(find);
  return () => { if (raf) cancelAnimationFrame(raf); };
}
