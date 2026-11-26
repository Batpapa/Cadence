import type { FileEntry } from '../types';
import { entryToObjectUrl, entryToBytes, arrayBufferToBase64 } from '../services/fileTransfer';
import { iconElement, ExternalLinkIcon, GearIcon } from './icons';
import { t } from '../services/i18nService';
import { isAbcFile } from '../services/abcService';
import { modalMaxH, modalMaxW } from '../services/zoomService';
import { showModal, updateTopModal } from './modal';
import { splitFileName, renamedFileName } from '../services/attachmentNames';
import { registerOverlay } from './overlayStack';
import { viewMimeType, isHeif, heifToJpeg } from '../services/heic';
import { showAbcPrefsModal } from './abcPlaybackPrefs';
import {
  BOTH_FACES_WIDTH, isText, modalWidth,
  type PreviewModalOpts, type PreviewSaveResult, type ViewerContext, type ViewerHooks, type ViewerSaveOutcome,
} from './viewerShared';
import { mountPdfViewer } from './pdfViewer';
import { mountAbcViewer } from './abcViewer';
import { mountTextViewer } from './textViewer';

// ── The file viewer ───────────────────────────────────────────────────────────
// One dialog for every kind of attachment. The pictures, the films and the
// recordings are a few lines each and stay here; the PDF, the score and the
// text each have a file of their own (pdfViewer.ts, abcViewer.ts,
// textViewer.ts), handed the dialog through a `ViewerContext` (viewerShared.ts).

export function showPreviewModal(
  entry: FileEntry,
  onSave?: (data: string) => PreviewSaveResult | Promise<PreviewSaveResult>,
  opts?: PreviewModalOpts,
): void {
  // What the title shows, as renames and a save-as-copy change it.
  let shownName = entry.name;
  // Overlay/dialog/header/close-button/outside-click/Escape are the shared
  // Preact modal shell (modal.tsx, 2026-08-26) now — only this format-specific
  // body is still hand-built here.
  let closed = false;
  // What each branch takes down with the modal, whatever closes it (✕,
  // outside click, Escape, closeAllModals): a recording's player, pdf.js's
  // worker, a score's keyboard shortcut (a document-level listener outliving
  // its modal would keep swallowing the space bar for the rest of the
  // session), its timers, its watches, its player, a page given to a score or
  // a PDF (an overlay of its own, outside this dialog). Run in the order
  // registered. One registered once the modal is gone — abcjs or pdf.js
  // arriving after a quick close — runs at once: when it was a chain of
  // reassigned closures, such a late link was simply never called.
  const onClosed: Array<() => void> = [];
  const whenClosed = (fn: () => void) => { if (closed) fn(); else onClosed.push(fn); };
  const onDismiss = () => { closed = true; for (const fn of onClosed.splice(0)) fn(); };

  const body = document.createElement('div');
  body.className = 'w-full flex items-center justify-center';

  // What the branches hand the dialog's header and shell (see ViewerHooks).
  const hooks: ViewerHooks = {};

  // A HEIC with no type of its own is still a picture (heic.ts).
  const m = viewMimeType(entry.mimeType, entry.name);
  // 0.85 (not 0.9) to match the shared modal shell's own dialog max-height
  // (modal.tsx) now that this modal is portaled through it — media sized
  // against a bigger budget than the dialog actually allows would overflow.
  const mediaMaxH = `calc(${modalMaxH(0.85)} - 80px)`;

  const save = onSave && (async (text: string): Promise<ViewerSaveOutcome> => {
    // Awaited, and only then applied by the caller: a save may ask first (a
    // TheSession score is saved as a copy) and the answer may be no.
    let result: PreviewSaveResult;
    try {
      result = await onSave(arrayBufferToBase64(new TextEncoder().encode(text).buffer));
    } catch (e) {
      // Not written (a full device, typically): the caller says so where the
      // edit is, and does not pretend it was saved.
      console.warn('[viewer] save failed', e);
      return 'failed';
    }
    if (result === false) return 'refused';
    if (typeof result === 'string') {
      shownName = result;
      updateTopModal({ title: result });
    }
    return 'saved';
  });

  const ctx: ViewerContext = { entry, body, opts, save, closed: () => closed, whenClosed, hooks, mediaMaxH };

  if (m.startsWith('audio/')) {
    body.classList.replace('items-center', 'items-start');
    import('./audioPlayer').then(({ renderAudioPlayer, unmountAudioPlayer, stopCurrentAudio }) => {
      // Modal may already have been dismissed while this dynamic import was
      // in flight — don't spin up an AudioContext nobody will ever close.
      if (closed) return;
      const player = renderAudioPlayer(entry, opts?.audioPresets);
      body.appendChild(player);
      // The sound first, then the screen: a Preact tree since 2026-10-10,
      // whose effects (its animation frame, its resize watch) end with it.
      whenClosed(() => { stopCurrentAudio(); unmountAudioPlayer(player); });
    });

  } else if (m.startsWith('video/')) {
    const video = document.createElement('video'); video.controls = true; video.className = 'max-w-full rounded';
    // In the dialog, not taken over to full screen the moment it plays (iPhone).
    video.playsInline = true;
    video.style.maxHeight = mediaMaxH;
    video.src = entryToObjectUrl(entry);
    body.appendChild(video);

  } else if (m.startsWith('image/')) {
    const img = document.createElement('img'); img.src = entryToObjectUrl(entry); img.alt = entry.name;
    img.className = 'max-w-full object-contain rounded';
    img.style.maxHeight = mediaMaxH;
    img.style.cursor = 'zoom-in';

    // A HEIC the browser cannot show (every one but Safari's) is converted
    // here, at the moment it is shown; the stored file stays the original.
    // Native first: when the browser reads it, there is nothing to load.
    if (isHeif(entry.mimeType, entry.name)) {
      img.addEventListener('error', () => {
        if (closed) return;
        URL.revokeObjectURL(img.src);
        img.style.display = 'none';
        const status = document.createElement('p');
        status.className = 'text-sm text-muted py-8';
        status.textContent = t('fileViewer.imageConverting');
        body.appendChild(status);
        heifToJpeg(new Blob([entryToBytes(entry)]))
          .then((jpeg) => {
            if (closed) return;
            img.src = URL.createObjectURL(jpeg);
            img.style.display = '';
            status.remove();
          })
          .catch((e) => {
            console.warn('[heic] could not convert ' + entry.name, e);
            status.className = 'text-sm text-danger py-8';
            status.textContent = t('fileViewer.imageUnreadable');
          });
      }, { once: true });
    }

    img.addEventListener('click', () => {
      const lightbox = document.createElement('div');
      lightbox.style.cssText = 'position:fixed;inset:0;z-index:100;background:black;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
      const big = document.createElement('img');
      big.src = img.src; big.alt = img.alt;
      big.style.cssText = `max-width:${modalMaxW(1.0)};max-height:${modalMaxH(1.0)};object-fit:contain;`;
      lightbox.appendChild(big);
      let unregisterLightbox = () => {};
      const closeLightbox = () => {
        unregisterLightbox();
        lightbox.remove();
      };
      // No Escape listener of its own. It used to need a CAPTURING one with
      // stopImmediatePropagation, for one reason: the modal underneath ran its
      // own listener, and without cutting the event off, one Escape closed the
      // enlarged image and the dialog behind it. Registering as an overlay
      // says the same thing properly — this is on top, so this is what closes.
      lightbox.addEventListener('click', closeLightbox);
      document.body.appendChild(lightbox);
      unregisterLightbox = registerOverlay(closeLightbox);
    });

    body.appendChild(img);

  } else if (m === 'application/pdf') {
    mountPdfViewer(ctx);
  } else if (isAbcFile(entry)) {
    mountAbcViewer(ctx);
  } else if (isText(entry)) {
    mountTextViewer(ctx);
  }

  // Scores first: neither the preferences nor the room to spread out applied
  // to an image, a PDF or a recording. A score is the one thing here that a wider
  // frame genuinely re-renders — abcjs lays out to the container, so the extra
  // width buys fewer line breaks rather than a bigger picture.
  //
  // And recordings since 2026-10-10, at the user's request: a wider waveform
  // is a finer one to place the bounds of a part on. PDFs since 2026-10-15
  // (group feedback): a page read at the dialog's size is a page read small.
  const isScore = isAbcFile(entry);
  const onRename = opts?.onRename;
  showModal(entry.name, body, [], {
    // A file's name: in its own case, on one line — a viewer's title may be
    // cut (N3e, the user).
    nameTitle: 'line',
    maxWidth: isScore && opts?.initialFace === 'both' && save ? BOTH_FACES_WIDTH : modalWidth(entry),
    // The version arrows and the Sheet / ABC tabs are pressed again and again,
    // and every version, every face, is its own height (reported 2026-10-23).
    pinTop: true,
    // A score lays itself out in the dialog's whole height: its tools, the
    // score taking what is left, its controls (2026-11-20, the user).
    fill: isScore,
    onDismiss,
    guardDismiss: (dismiss) => hooks.guardClose?.(dismiss) ?? false,
    expandable: isScore || m.startsWith('audio/') || m === 'application/pdf',
    onExpandedChange: (expanded) => hooks.onExpanded?.(expanded),
    titleEdit: onRename
      ? {
          suffix: splitFileName(entry.name).ext,
          onCommit: (value) => {
            const next = renamedFileName(shownName, value);
            if (!next) return;
            onRename(next);
            shownName = next;
            updateTopModal({ title: next });
          },
        }
      : undefined,
    // abcTools left of the gear (2026-10-10, the user): both act on the tune as
    // a whole, and the dialog's own controls (full page, ✕) close the row.
    headerActions: isScore
      ? [
          {
            icon: iconElement(ExternalLinkIcon, 16),
            title: t('fileViewer.abc.openInAbcTools'),
            onClick: () => hooks.openInAbcTools?.(),
          },
          {
            icon: iconElement(GearIcon, 16),
            title: t('fileViewer.abc.prefs.title'),
            tour: 'abc-gear',
            onClick: () => showAbcPrefsModal(() => hooks.reapplyPrefs?.(), () => hooks.recheckSyntax?.()),
          },
        ]
      : [],
  });
}
