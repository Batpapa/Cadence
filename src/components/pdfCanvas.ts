import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

// ── PDF pages drawn by pdf.js, where the browser has no viewer of its own ─────
// Only for browsers that say they cannot show a PDF inline (Chrome on Android
// first of all): everywhere else the file viewer keeps the browser's own
// viewer, which searches, zooms and prints better than this. Handing the file
// to the device instead was tried and turned down (2026-09-14): on the phone
// it meant a download, not a page.
//
// Measured before choosing it (2026-09-14), in Chrome, under this app's real
// CSP: ten real PDFs rendered, no violation — the worker is a same-origin
// module (script-src 'self'), its image decoders need 'wasm-unsafe-eval',
// both already allowed. A score of one to four pages takes 0.2-0.4 s; a
// single 28 MB image page took 11 s on a desktop, which is why only the pages
// near the screen are ever drawn, and why pages scrolled far away give their
// pixels back.
//
// The legacy build: pdf.js's modern one targets only the latest browsers, and
// a phone that has not updated this week must still see its scores.

/** Emitted by webpack as an asset; pdf.js starts it as a module worker. */
const WORKER_URL = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url);

/** Sharp enough on any phone, without a 3× screen's canvas per page. */
const MAX_PIXEL_RATIO = 2;

interface Slot {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  task: ReturnType<PDFPageProxy['render']> | null;
}

/** Fills `host` — a scrolling box — with every page of the PDF, drawing them
 *  as they come near the screen. Resolves with the function that releases it
 *  all (the worker included), which the viewer calls when it closes.
 *  `cancelled` is asked between steps: a modal closed while pdf.js was still
 *  loading must not leave a worker running behind it. */
export async function renderPdfPages(host: HTMLElement, bytes: Uint8Array<ArrayBuffer>, cancelled: () => boolean): Promise<() => void> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (cancelled()) return () => {};
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL.href;

  // Copied next to the app by webpack (see its CopyPlugin and devServer), and
  // only ever fetched by a PDF that needs them: fonts a file names without
  // embedding, and decoders for scanned images.
  // The loading task, not the document, is what tears the worker down in
  // pdf.js 6 (PDFDocumentProxy lost its destroy()).
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
    wasmUrl: new URL('pdfjs/wasm/', document.baseURI).href,
  });
  const doc = await loadingTask.promise;
  if (cancelled()) { void loadingTask.destroy(); return () => {}; }

  const width = host.clientWidth || 600;
  const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const slots = new Map<Element, Slot>();

  // Every page gets its place at once, sized from its own proportions, so the
  // scrollbar is right from the start and nothing jumps as pages are drawn.
  host.replaceChildren();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    if (cancelled()) { void loadingTask.destroy(); return () => {}; }
    const base = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.className = 'block w-full bg-white rounded mb-2';
    canvas.style.height = `${(width * base.height) / base.width}px`;
    host.appendChild(canvas);
    slots.set(canvas, { page, canvas, task: null });
  }

  const draw = (slot: Slot) => {
    if (slot.task) return;
    const base = slot.page.getViewport({ scale: 1 });
    const viewport = slot.page.getViewport({ scale: (width / base.width) * ratio });
    slot.canvas.width = Math.floor(viewport.width);
    slot.canvas.height = Math.floor(viewport.height);
    slot.task = slot.page.render({ canvas: slot.canvas, viewport });
    // Cancelled when scrolled away, or one bad page: never the viewer's problem.
    slot.task.promise.catch(() => {});
  };

  // The CSS height stays, so the page keeps its place while holding no pixels.
  const release = (slot: Slot) => {
    if (!slot.task) return;
    slot.task.cancel();
    slot.task = null;
    slot.canvas.width = 0;
    slot.canvas.height = 0;
  };

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const slot = slots.get(entry.target);
      if (slot) (entry.isIntersecting ? draw : release)(slot);
    }
  }, { root: host, rootMargin: '100% 0px' });
  for (const canvas of slots.keys()) observer.observe(canvas);

  return () => {
    observer.disconnect();
    for (const slot of slots.values()) slot.task?.cancel();
    void loadingTask.destroy();
  };
}
