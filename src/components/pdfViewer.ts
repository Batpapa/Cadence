import { entryToObjectUrl, entryToBytes, downloadBlob } from '../services/fileTransfer';
import { isAppleTouchDevice } from '../services/device';
import { isNative } from '../native/platform';
import { iconElement, ExpandIcon, CollapseIcon } from './icons';
import { t } from '../services/i18nService';
import { modalMaxH } from '../services/zoomService';
import { safeFileName } from '../services/attachmentNames';
import { readingPage } from './readingPage';
import type { ViewerContext } from './viewerShared';

// ── A PDF in the file viewer ──────────────────────────────────────────────────

export function mountPdfViewer(ctx: ViewerContext): void {
  const { entry, body, mediaMaxH } = ctx;
  // `!== false`, not truthy: a browser too old to have the property at all
  // is a desktop one with its viewer, and keeps getting the frame it had.
  //
  // Not on an iPhone or an iPad, which say they have a viewer and, in a
  // frame, show the first page alone with no way to scroll to the next. They
  // get pdf.js — when they can run it: pdf.js 6 needs Promise.withResolvers
  // (Safari 17.4) and does not polyfill it; older ones keep the first page.
  const pdfJsRuns = typeof (Promise as { withResolvers?: unknown }).withResolvers === 'function';
  const useEmbed = navigator.pdfViewerEnabled !== false && !(isAppleTouchDevice() && pdfJsRuns);

  // ── The reading page (2026-10-15, group feedback: "PDFs in full screen,
  // like the scores") ──
  // Two ways to more room. The dialog's own "Full page" (modal.tsx), which
  // keeps its header; and this, the score's reading page: the PDF alone on
  // the page, its way out the very button that led in, the screen kept on.
  // Neither viewer offers one to call: the browser's, in an <embed>, takes
  // no orders from the page, and pdf.js is used without its viewer app —
  // its presentation mode lives in that app, not in the library.
  //
  // The PDF and its button travel together, MOVED into an overlay on
  // document.body (readingPage.ts). Moving an <embed> reloads it, which for a
  // blob: URL costs nothing but the page the reader was on.
  const pdfFrame = document.createElement('div');
  pdfFrame.className = 'relative w-full';
  body.appendChild(pdfFrame);
  let pdfModalExpanded = false;

  /** The viewer: the browser's <embed>, or the box pdf.js draws pages into. */
  let viewer: HTMLElement;
  /** Its height: the dialog's room, more of it once the dialog itself has
   *  the page (its header and padding still take theirs), and none set on
   *  the reading page, whose column sizes it. */
  const sizePdf = () => {
    const height = page.on ? ''
      : pdfModalExpanded ? `calc(${modalMaxH(1)} - 6rem - var(--safe-top) - var(--safe-bottom))`
      : mediaMaxH;
    if (useEmbed) viewer.style.height = height; else viewer.style.maxHeight = height;
  };

  if (useEmbed) {
    // An <embed> loading a blob: URL is governed by the page's object-src —
    // which must keep allowing blob: (webpack.config.js's CSP). With 'none'
    // this rendered an empty frame and said nothing (2026-09-06 to 14).
    //
    // `#navpanes=0`: the page thumbnails closed at opening (2026-10-15, the
    // user) — they took a third of a dialog's width from the page itself.
    // Adobe's open parameter, which Chrome's viewer reads too (its
    // open_pdf_params_parser.ts: navpanes alone hides the side panel and
    // keeps the toolbar); the panel's own button still opens it. Firefox
    // opens with it closed anyway; a viewer that knows nothing of it
    // ignores a fragment.
    const embed = document.createElement('embed'); embed.src = `${entryToObjectUrl(entry)}#navpanes=0`;
    embed.type = 'application/pdf'; embed.className = 'block w-full rounded';
    viewer = embed;
    pdfFrame.appendChild(embed);
  } else {
    // No inline PDF viewer here — Chrome on Android, first of all — so an
    // <embed> would stay an empty frame. The pages are drawn with pdf.js
    // instead, loaded only now (see pdfCanvas.ts). Handing the file to the
    // device was tried first and turned down: on the phone it downloaded.
    const frame = document.createElement('div');
    frame.className = 'w-full overflow-y-auto';
    viewer = frame;
    const loading = document.createElement('p');
    loading.className = 'text-sm text-muted text-center py-6';
    loading.textContent = t('fileViewer.pdf.loading');
    frame.appendChild(loading);
    pdfFrame.appendChild(frame);

    import('./pdfCanvas')
      .then(({ renderPdfPages }) => renderPdfPages(frame, entryToBytes(entry), ctx.closed))
      // Its worker and canvases go with the modal.
      .then(release => ctx.whenClosed(release))
      .catch(() => {
        if (ctx.closed()) return;
        // Last resort — a PDF pdf.js cannot read, or its code not loadable
        // (offline before it was ever fetched): the device may still open it.
        const box = document.createElement('div');
        box.className = 'flex flex-col items-center gap-4 py-6 text-center';
        const msg = document.createElement('p');
        msg.className = 'text-sm text-muted leading-relaxed max-w-sm';
        msg.textContent = t('fileViewer.pdf.failed');
        const open = document.createElement('a');
        open.href = entryToObjectUrl(entry);
        open.download = safeFileName(entry.name);
        // The Android app's WebView ignores `download` on a blob: link.
        if (isNative()) open.addEventListener('click', e => {
          e.preventDefault();
          downloadBlob(new Blob([entryToBytes(entry)], { type: entry.mimeType }), entry.name);
        });
        open.className = 'btn-primary';
        open.textContent = t('fileViewer.pdf.open');
        box.append(msg, open);
        frame.replaceChildren(box);
      });
  }
  ctx.hooks.onExpanded = (expanded) => { pdfModalExpanded = expanded; sizePdf(); };

  // The score's own button (2026-10-15, the user: "the same as for the ABC
  // scores"), top right of where the pages are. Its class reads its colours
  // from the paper it sits on (--abc-ink); a PDF has no paper of ours, so it
  // gets a white patch of one — black ink on it reads over a white page, the
  // dialog of either theme, and the browser viewer's grey alike.
  //
  // Over pdf.js, the frame's corner is the first page's. Over the browser's
  // viewer, the top of the frame is the viewer's own toolbar (download,
  // print, its menu, at the right): the button goes under it, and left of
  // its scrollbar. 56 px is Chrome's toolbar; Firefox's is lower and
  // Safari's floats at the bottom, where both leave the button in the
  // grey around the page.
  const pdfFullscreenBtn = document.createElement('button');
  pdfFullscreenBtn.className = 'abc-score-tool-small absolute z-20 rounded-md transition-colors cursor-pointer flex items-center justify-center';
  pdfFullscreenBtn.style.setProperty('--abc-ink', '#000000');
  pdfFullscreenBtn.style.background = 'rgba(255, 255, 255, 0.85)';
  Object.assign(pdfFullscreenBtn.style, useEmbed
    ? { top: '3.75rem', right: '1.25rem' }
    : { top: '0.25rem', right: '0.25rem' });
  const labelPdfButton = () => {
    const key = page.on ? 'fileViewer.pdf.fullscreenExit' : 'fileViewer.pdf.fullscreen';
    pdfFullscreenBtn.replaceChildren(iconElement(page.on ? CollapseIcon : ExpandIcon, 14));
    pdfFullscreenBtn.title = t(key);
    pdfFullscreenBtn.setAttribute('aria-label', t(key));
  };
  pdfFrame.appendChild(pdfFullscreenBtn);

  const page = readingPage([pdfFrame], (on) => {
    pdfFrame.classList.toggle('flex', on);
    pdfFrame.classList.toggle('flex-col', on);
    pdfFrame.classList.toggle('flex-1', on);
    pdfFrame.classList.toggle('min-h-0', on);
    viewer.classList.toggle('flex-1', on);
    viewer.classList.toggle('min-h-0', on);
    viewer.classList.toggle('rounded', !on);
    sizePdf();
    labelPdfButton();
  });
  sizePdf();
  labelPdfButton();
  pdfFullscreenBtn.addEventListener('click', () => {
    pdfFullscreenBtn.blur();
    if (page.on) page.exit(); else page.enter();
  });
  // The viewer can be taken down from elsewhere while the PDF has the page
  // (closeAllModals): the overlay must not outlive it.
  ctx.whenClosed(page.exit);
}
