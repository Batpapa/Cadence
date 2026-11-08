/** HEIC/HEIF pictures: what an iPhone takes by default, and the one image
 *  format the app's browsers do not all read. Safari does; Chrome, and so
 *  Android's WebView, does not (2026-11-08: iPhone photos attached on an
 *  Android tablet showed as a broken image).
 *
 *  The file is kept exactly as it came: only what is SHOWN is converted, at
 *  the moment it is shown, and only once the browser has failed to show it
 *  itself — so Safari never pays for the decoder, and a file labelled HEIF
 *  that is something the browser reads (an AVIF shares the container) is
 *  shown natively.
 *
 *  Two decoders. The device's own video decoder through WebCodecs
 *  (heicWebCodecs.ts), where it has HEVC, which every phone and tablet has;
 *  otherwise libheif (libheif-js, LGPL-3.0) in a worker of its own
 *  (heicWorker.ts), started on first need: 2 MB nobody else downloads. */

import type { HeicRequest, HeicResponse } from './heicWorker';

const HEIF_NAME = /\.hei[cf]$/i;

/** The `ftyp` major brands of a HEIF still image or sequence. The same list
 *  as heic-to's own `isHeic`, which reads the same four bytes. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

/** What a stored label is, before the name or the bytes say more: nothing,
 *  or the generic binary fallback. */
function isGenericType(mime: string): boolean {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return base === '' || base === 'application/octet-stream';
}

export function isHeifName(name: string): boolean {
  return HEIF_NAME.test(name);
}

/** The type the first bytes prove, or null: an ISO-BMFF `ftyp` box first, its
 *  major brand one of HEIF's. */
export function sniffHeif(head: Uint8Array): string | null {
  if (head.length < 12) return null;
  const ascii = (from: number) => String.fromCharCode(head[from]!, head[from + 1]!, head[from + 2]!, head[from + 3]!);
  if (ascii(4) !== 'ftyp') return null;
  const brand = ascii(8);
  if (HEIC_BRANDS.has(brand)) return 'image/heic';
  if (HEIF_BRANDS.has(brand)) return 'image/heif';
  return null;
}

/** The type to open a file by. A HEIC picked on a system that has no mapping
 *  for the extension comes with an empty label (or the generic one): its name
 *  says what it is. Nothing stored is rewritten — this is read at each use. */
export function viewMimeType(mime: string, name: string): string {
  if (isGenericType(mime) && isHeifName(name)) return name.toLowerCase().endsWith('.heif') ? 'image/heif' : 'image/heic';
  return mime;
}

/** Whether a file is one this module may have to convert to be shown. */
export function isHeif(mime: string, name: string): boolean {
  const base = viewMimeType(mime, name).split(';')[0]!.trim().toLowerCase();
  return base.startsWith('image/hei') || isHeifName(name);
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (jpeg: Blob) => void; reject: (e: Error) => void }>();

/** The pixels as a JPEG, on the page: for a worker that has no canvas. */
function encodeJpeg(pixels: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  canvas.getContext('2d')!.putImageData(pixels, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', 0.92));
}

function heicWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./heicWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<HeicResponse>) => {
    const msg = e.data;
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    if ('jpeg' in msg) job.resolve(msg.jpeg);
    else if ('pixels' in msg) encodeJpeg(msg.pixels).then(job.resolve, job.reject);
    else job.reject(new Error(msg.error));
  };
  // A worker that cannot even start (its script refused, memory): every
  // picture waiting fails now rather than never, and the next one tries a
  // fresh worker.
  w.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message || 'HEIC worker failed'));
    pending.clear();
    w.terminate();
    worker = null;
  };
  worker = w;
  return w;
}

/** The picture as a JPEG the browser can show: the device's video decoder
 *  first (heicWebCodecs.ts, ~0.2 s for an iPhone photo), libheif when it
 *  cannot (~2-3 s). Rejects when neither can read it. */
export async function heifToJpeg(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  try {
    const fast = await import('./heicWebCodecs');
    if (fast.webCodecsAvailable()) return await fast.heifToJpegWebCodecs(new Uint8Array(bytes));
  } catch (e) {
    console.info('[heic] no hardware decoding, libheif instead:', e);
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const request: HeicRequest = { id, bytes };
    heicWorker().postMessage(request, [bytes]);
  });
}
