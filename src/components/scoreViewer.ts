import type { FileEntry } from '../types';
import { arrayBufferToBase64 } from '../services/fileTransfer';
import { mountAbcViewer } from './abcViewer';
import { showAbcPrefsModal } from './abcPlaybackPrefs';
import { overlayCount } from './overlayStack';
import type { PreviewModalOpts, ViewerContext, ViewerHooks, ViewerSaveOutcome } from './viewerShared';

// ── A score in a page ─────────────────────────────────────────────────────────
// The score viewer (abcViewer.ts) without its dialog, for a page that shows a
// score as its own content — the Transcription module's draft (2026-11-27, the
// user: "share as much code as possible with the ABC viewer"). The very same
// viewer as a card's score opens in: its faces, its editor and syntax check,
// its versions, its sound, its audio sync and Play-along, its full page. What
// the dialog gave it, the page gives it here:
// - its box: `host`, which must have a height — the viewer lays itself out in
//   it as in the dialog's (`fill`), the stave being what scrolls. The host's
//   classes are the viewer's (it sets them, as it does the dialog body's):
//   the page sizes a wrapper around it, not the host itself;
// - its life: until `dispose`, which the page calls as it goes;
// - the header's gear and way out to abcTools: `openPrefs` / `openInAbcTools`,
//   for the page to put wherever its own header is;
// - the dialog's question on closing over an unsaved edit: `guardLeave`;
// - the space bar, which is the score's only while nothing is open over the
//   page (`ownsKeys`).

export interface ScoreViewerOptions extends PreviewModalOpts {
  /** The score: one tune or several (its `X:` blocks are its versions). */
  text: string;
  /** Its file name, as the viewer would show a file's. */
  name: string;
  /** Writes an edited text — the whole score, every version. Absent, the
   *  score is read-only: no editor face. */
  save?: (text: string) => Promise<ViewerSaveOutcome>;
}

export interface ScoreViewer {
  /** What the viewer hands its surroundings (see ViewerHooks). */
  readonly hooks: ViewerHooks;
  /** The ABC playback preferences (the dialog's gear). */
  openPrefs(): void;
  /** The version on screen, in abcTools. */
  openInAbcTools(): void;
  /** Before the page goes: true when an edit not saved made it ask, `proceed`
   *  then running once that is answered; false when there was nothing to ask
   *  (the caller goes on at once). */
  guardLeave(proceed: () => void): boolean;
  /** The text with the edit not saved in, or null (ViewerHooks.pendingText). */
  pendingText(): string | null;
  /** Takes the viewer down — its sound, its listeners, its timers, its full
   *  page. Once; later calls do nothing. */
  dispose(): void;
}

export function mountScoreViewer(host: HTMLElement, options: ScoreViewerOptions): ScoreViewer {
  const { text, name, save, ...opts } = options;
  const entry: FileEntry = {
    name,
    mimeType: 'text/vnd.abc',
    // Not encodeAbc: its spread of the bytes overflows the stack on a long text.
    data: arrayBufferToBase64(new TextEncoder().encode(text).buffer),
  };
  let closed = false;
  const onClosed: Array<() => void> = [];
  const whenClosed = (fn: () => void) => { if (closed) fn(); else onClosed.push(fn); };
  const hooks: ViewerHooks = {};
  const ctx: ViewerContext = {
    entry, body: host, opts, save,
    closed: () => closed, whenClosed, hooks,
    mediaMaxH: '60vh',
    ownsKeys: () => overlayCount() === 0,
  };
  mountAbcViewer(ctx);
  return {
    hooks,
    openPrefs: () => showAbcPrefsModal(() => hooks.reapplyPrefs?.(), () => hooks.recheckSyntax?.()),
    openInAbcTools: () => hooks.openInAbcTools?.(),
    guardLeave: (proceed) => hooks.guardClose?.(proceed) ?? false,
    pendingText: () => hooks.pendingText?.() ?? null,
    dispose: () => {
      if (closed) return;
      closed = true;
      for (const fn of onClosed.splice(0)) fn();
      host.replaceChildren();
    },
  };
}
