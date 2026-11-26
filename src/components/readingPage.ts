import { registerOverlay } from './overlayStack';
import { WakeLockManager } from '../services/wakeLock';

// ── The reading page ──────────────────────────────────────────────────────────
// A score, or a PDF, given the whole page (2026-09-21 for scores; 2026-10-15
// for PDFs, group feedback: "the same as for the ABC scores"): a stand to read
// from across the room, the screen kept on. Not the dialog's own "Full page"
// (modal.tsx), which keeps the header and gives the room to everything in it.
//
// What goes is MOVED into an overlay on document.body rather than pinned
// where it stands: the dialog around it is `overflow-hidden`, and the modal's
// backdrop-filter makes it a containing block for fixed children, so an
// element fixed in place would be positioned and then clipped by the very
// window it is escaping. Placeholders mark where each piece goes back to —
// rather than remembered siblings: the rows around them come and go.
//
// One for both since 2026-11-26: the score's and the PDF's were built twice,
// the same overlay to the class.

export interface ReadingPage {
  /** Whether the pieces have the page. */
  readonly on: boolean;
  enter: () => void;
  /** Back where they were; nothing when they are already. */
  exit: () => void;
}

/** `pieces` given the page together, in that order, as a column — each
 *  must be in the document when it is entered. `onChange` runs once they have
 *  moved, either way: the caller's own classes, labels and sizes. */
export function readingPage(pieces: HTMLElement[], onChange: (on: boolean) => void): ReadingPage {
  let overlay: HTMLElement | null = null;
  let anchors: Comment[] = [];
  let unregister = () => {};
  const wakeLock = new WakeLockManager();

  const exit = (): void => {
    if (!overlay) return;
    unregister();
    unregister = () => {};
    wakeLock.stop();
    pieces.forEach((piece, i) => anchors[i]?.replaceWith(piece));
    anchors = [];
    overlay.remove();
    overlay = null;
    onChange(false);
  };

  const enter = (): void => {
    if (overlay) return;
    const page = document.createElement('div');
    // What shows of the overlay itself is only the bands under the system
    // bars: the dialog colour there, not the paper — the bars' icons are
    // picked for the theme (native/systemBars.ts), and white ones vanish on a
    // cream sheet.
    page.className = 'fixed inset-0 z-[100] flex flex-col safe-area-pad';
    page.style.background = 'var(--color-elevated)';
    anchors = pieces.map((piece) => {
      const anchor = document.createComment('reading-page');
      piece.replaceWith(anchor);
      return anchor;
    });
    page.append(...pieces);
    document.body.appendChild(page);
    overlay = page;
    onChange(true);
    void wakeLock.start();
    // Topmost overlay: Escape and the Android back gesture leave the reading
    // page, not the viewer underneath it.
    unregister = registerOverlay(exit);
  };

  return { get on() { return overlay !== null; }, enter, exit };
}
