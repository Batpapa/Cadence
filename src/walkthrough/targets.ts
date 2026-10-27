// ── Finding a step's element ─────────────────────────────────────────────────
// By its `data-tour` name (see scenarios.ts), and only where the user can SEE
// it: present in the page is not enough. A collapsed side panel is there at
// zero width, a closed drawer is slid off the screen, the header keeps no
// button it has moved into ⋮ — and a step that lit any of those would talk
// about something nobody can see (the author's rule, 2026-10-27).

export type TourTarget = string;

/** Sideways only: what is merely scrolled out of sight, below a long list, is
 *  scrolled to by driver.js. What is slid off to a side is put away. */
function onViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth
    && getComputedStyle(el).visibility !== 'hidden';
}

/** The first of the targets on screen, and which one it was. */
export function resolve(target: TourTarget | TourTarget[] | undefined): { el: Element; name: TourTarget } | null {
  for (const name of target === undefined ? [] : Array.isArray(target) ? target : [target]) {
    const el = Array.from(document.querySelectorAll(`[data-tour="${name}"]`)).find(onViewport);
    if (el) return { el, name };
  }
  return null;
}

export function onScreen(name: TourTarget): boolean {
  return resolve(name) !== null;
}

export function stillOnScreen(el: Element): boolean {
  return el.isConnected && onViewport(el);
}
