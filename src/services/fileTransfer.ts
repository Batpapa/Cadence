import type { FileEntry } from '../types';
import { t } from './i18nService';
import { needsAudioSniff, sniffAudioMime, SNIFF_BYTES } from './audioSniff';
import { sniffHeif } from './heic';
import { isNative } from '../native/platform';
import { safeFileName } from './attachmentNames';

// ── Files in and out: a stored file's bytes, a save-as, the clipboard ────────
// Out of utils.ts since 2026-11-26.

/** What to store as an attachment's type.
 *
 *  `file.type` is the browser's guess from the EXTENSION, and it is wrong in a
 *  way that matters: `.webm` is video/webm in Chromium whatever the file holds,
 *  so a recording attached by hand opened in a bare <video> instead of the
 *  custom audio player. When the label is one of those guesses, the file's own
 *  head decides — see audioSniff.ts.
 *
 *  An empty label is also what a HEIC photo gets where the system knows no
 *  type for the extension: its head says so too (see heic.ts). */
async function resolveMimeType(file: File): Promise<string> {
  if (!needsAudioSniff(file.type)) return file.type;
  try {
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    return sniffAudioMime(head) ?? sniffHeif(head) ?? file.type;
  } catch {
    return file.type; // unreadable head: the declared type is all we have
  }
}

export async function fileToEntry(file: File): Promise<FileEntry> {
  const mimeType = await resolveMimeType(file);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target!.result as string;
      resolve(dataUrl.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return { name: file.name, data, mimeType };
}

/** A stored file's bytes — kept as base64 in the user blob. A fresh array on
 *  every call, which matters to pdf.js: it takes the buffer over. */
export function entryToBytes(entry: FileEntry): Uint8Array<ArrayBuffer> {
  const bytes = atob(entry.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return arr;
}

export function entryToObjectUrl(entry: FileEntry): string {
  return URL.createObjectURL(new Blob([entryToBytes(entry)], { type: entry.mimeType }));
}

/** Chunked to avoid "Maximum call stack size exceeded" on large buffers (spread args limit). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Inverse of arrayBufferToBase64. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

/** Client-side "save as": a Blob URL, clicked once, revoked immediately.
 *  Shared by every export in the app rather than re-typed in each — the revoke
 *  is the part that gets forgotten when this is copied around, and a leaked
 *  object URL pins its whole Blob in memory for the life of the document. */
export function downloadTextFile(content: string, filename: string, mime: string): void {
  downloadBlob(new Blob([content], { type: mime }), filename);
}

/** The same save-as for something that is already bytes. Separate from the
 *  text helper rather than widening it to BlobPart: a function called
 *  downloadTextFile handed a Uint8Array reads as a bug at every call site,
 *  and the archive path is bytes all the way down. */
export function downloadBlob(blob: Blob, filename: string): void {
  // Names come from the user (an analysis, an attachment) and may hold what
  // no filesystem accepts — see safeFileName.
  filename = safeFileName(filename);
  // A .abc from TheSession is stored as text/plain, which Android would save
  // as "….abc.txt" — see downloadCadenceFile for why.
  if (/^text\/plain\b/.test(blob.type) && !/\.txt$/i.test(filename)) {
    blob = new Blob([blob], { type: 'application/octet-stream' });
  }
  // The Android app's WebView does nothing with the anchor below: the file
  // goes through the system's save dialog instead (native/saveFile.ts).
  if (isNative()) {
    void import('../native/saveFile')
      .then(m => m.saveBlobNative(blob, filename))
      .catch(err => {
        console.error('[native] save failed', err);
        // Native, not alertModal: the recovery screen saves through here too,
        // and it has no ModalHost for a modal to appear in.
        alert(t('native.save.failed', { message: err instanceof Error ? err.message : String(err) })); // ui-ok: also reached from the recovery screen, which has no ModalHost
      });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Not revoked straight away: some browsers cancel a download whose URL
  // dies before they have taken the blob (seen on audio, the largest files).
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save-as for Cadence's own formats — .cdb, .cdbf, .cdc, .cds — and the only
 *  way they should reach a disk.
 *
 *  Always application/octet-stream, never the type of what is inside. Android
 *  saves a download through its MediaProvider, which appends the extension of
 *  the declared type to any name whose extension it does not map to that type:
 *  a .cdb sent as application/json lands as "….cdb.json" (found on a user's
 *  phone, 2026-09-17: five of them), and the import, which filters on our
 *  extensions, can then not even select it. octet-stream is the one type it
 *  leaves alone, and it is also the truth: nothing else knows how to open
 *  these files. */
export function downloadCadenceFile(content: BlobPart, filename: string): void {
  downloadBlob(new Blob([content], { type: 'application/octet-stream' }), filename);
}

/** Copies text, and says whether it worked.
 *
 *  `navigator.clipboard` is absent outside a secure context and can be refused
 *  by permission, so the textarea + execCommand path stays: it is deprecated,
 *  not gone, and it is the only thing that works when the modern API is not
 *  there. The caller gets a boolean rather than a rejected promise because
 *  "the copy did not happen" is a normal outcome to show in the UI, not an
 *  error to log. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* refused or unavailable — try the old way below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen rather than hidden: execCommand needs a focusable, selectable
    // element, and display:none is neither.
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** copyText for a text not ready yet — built after the press, out of the
 *  database or the network. Safari only lets a page write the clipboard
 *  during the press itself, which is long over by the time the text exists:
 *  the copy failed there. A ClipboardItem takes the content as a promise, so
 *  the write starts within the press and completes when the text arrives
 *  (Safari 13.1+). Wherever that is missing or refused, the text is awaited
 *  and handed to copyText, which works where the press need not be live.
 *  Null from `text`: nothing to copy, and false. */
export async function copyTextWhenReady(text: Promise<string | null>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const blob = text.then(t => {
        if (t === null) throw new Error('nothing to copy');
        return new Blob([t], { type: 'text/plain' });
      });
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch { /* refused, or a browser that wants the content itself: below */ }
  }
  const t = await text;
  return t === null ? false : copyText(t);
}
