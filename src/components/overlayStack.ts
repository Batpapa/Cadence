// ── What is on top, and how to close it ──────────────────────────────────────
// Until 2026-09-10 nothing in the app could answer "close the topmost thing".
// Modals raised through modal.tsx sat in one stack; the settings dialog, the
// library's export picker, the new-card overlay and the command palette each
// ran their own escape hatch. That was survivable while only Escape asked the
// question, because every listener stopped at its own scope — but the Android
// back gesture asks the same question from outside all of them, and had nobody
// to ask. It navigated behind whatever was open.
//
// Deliberately dependency-free: store.ts imports this from its popstate
// handler, and anything reaching back into the modal layer from there would
// close a cycle.

type Closer = () => void;

interface Entry { id: number; close: Closer }

let nextId = 1;
const stack: Entry[] = [];

/** Registers an overlay as the topmost thing on screen. The returned function
 *  removes it WITHOUT closing it — call it from the overlay's own teardown, so
 *  a close that came from anywhere else (a ✕, an action, Escape) leaves the
 *  stack correct rather than holding a closer for something already gone. */
export function registerOverlay(close: Closer): () => void {
  const entry: Entry = { id: nextId++, close };
  stack.push(entry);
  return () => {
    const i = stack.findIndex(e => e.id === entry.id);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function anyOverlayOpen(): boolean {
  return stack.length > 0;
}

/** Closes the topmost overlay and says whether there was one.
 *
 *  The closer is expected to end up calling its own unregister — so this pops
 *  optimistically first, and a closer that forgets cannot leave an entry that
 *  can never be closed again. */
export function closeTopOverlay(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top.close();
  return true;
}
