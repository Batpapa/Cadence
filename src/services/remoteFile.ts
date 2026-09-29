import type { FileEntry } from '../types';
import { arrayBufferToBase64, formatBytes } from '../utils';
import { needsAudioSniff, sniffAudioMime, SNIFF_BYTES } from './audioSniff';
import { t } from './i18nService';

// ── A file behind a link ─────────────────────────────────────────────────────
// Since 2026-09-29 the "In-app player" side of a link is not only the four
// platforms' iframes: a URL that answers with a plain file — an mp3 on a home
// server, a PDF on a club's site — opens in the same viewers as an attached
// file, the audio one with its speed, pitch and loop included. Asked for from
// the field, by a user serving his recordings over `tailscale serve`.
//
// What makes it work or not is the server, never this code: the player decodes
// the bytes (SoundTouch needs the samples), so they have to be READ, and a page
// may only read another origin's response if that origin says so with
// `Access-Control-Allow-Origin`. An `<audio src>` would play without it — but
// Web Audio is handed silence from a cross-origin element that lacks it, so the
// advanced player cannot be built on one.
//
// Nothing is kept: the server is where the file lives, so a file changed there
// is the one read next time, and the synced state holds a URL and a name.

/** Why a URL cannot be used — as specific as the browser lets it be
 *  (categories asked for by the user, 2026-09-29):
 *
 *  - `scheme`      — not http(s): nothing will be fetched, in either mode;
 *  - `nowhere`     — no server answered, or it said nothing is there (404,
 *                    5xx…), in either mode;
 *  - `unsupported` — something is there, but neither a platform's player nor a
 *                    file a viewer opens: a web page, a zip. In-app only;
 *  - `forbidden`   — the server said no: 401/403, a private video. In-app only;
 *  - `cors`        — a server answered, without the header that lets Cadence
 *                    read it. In-app only. Whether a file is even there stays
 *                    unknown: such a server's 404 reaches a script exactly as
 *                    a file would, which is why the message speaks of the
 *                    address and not of a file. (A mistyped URL reported this
 *                    way was the question on 2026-09-29; working round it
 *                    through `<audio>`/`<img>` loads was offered, and
 *                    declined as not worth it.);
 *  - `insecure`    — `http://` from an `https://` page, blocked before it
 *                    leaves. In-app only;
 *  - `too-big`     — past MAX_REMOTE_FILE_BYTES. In-app only.
 *
 *  `nowhere` and `cors` are told apart by asking twice: the browser hands a
 *  script the same bare TypeError for a dead host and for a refused CORS read,
 *  on purpose, but a `no-cors` request succeeds (opaquely) as soon as anything
 *  answers — see `reachable`. */
export type RemoteRefusal =
  | { why: 'scheme' }
  | { why: 'nowhere' }
  | { why: 'unsupported' }
  | { why: 'forbidden' }
  | { why: 'cors' }
  | { why: 'insecure' }
  | { why: 'too-big'; bytes: number };

export class RemoteFileError extends Error {
  constructor(readonly refusal: RemoteRefusal) {
    super(`remote file: ${refusal.why}`);
    this.name = 'RemoteFileError';
  }
}

/** The refusal in words, for the link dialog and for an opening that failed. */
export function refusalMessage(r: RemoteRefusal): string {
  switch (r.why) {
    case 'scheme':      return t('embed.badUrl');
    case 'nowhere':     return t('embed.err.nowhere');
    case 'unsupported': return t('embed.err.unsupported');
    case 'forbidden':   return t('embed.err.forbidden');
    case 'cors':        return t('embed.err.cors');
    case 'insecure':    return t('embed.err.insecure');
    case 'too-big':     return t('embed.file.tooBig', { size: formatBytes(r.bytes), max: formatBytes(MAX_REMOTE_FILE_BYTES) });
  }
}

/** A refusal for an HTTP status: the server is there and said no to THIS
 *  page, or there is nothing at that address. Shared with the platforms'
 *  oEmbed answers, which fail the same two ways. */
export function statusRefusal(status: number): RemoteRefusal {
  return status === 401 || status === 403 ? { why: 'forbidden' } : { why: 'nowhere' };
}

/** `http://` from a page served over `https://`: the browser blocks the read
 *  before it leaves (mixed content), so nothing about the server can be
 *  learnt — neither whether it is there nor whether it would allow the read.
 *  Only ever true in production; the dev server is plain http. */
function isMixedContent(url: string): boolean {
  try {
    return location.protocol === 'https:' && new URL(url).protocol === 'http:';
  } catch { return false; }
}

/** How long a mere "is anything there?" may take. */
const REACH_TIMEOUT_MS = 10_000;

/** Whether ANYTHING answers at `url`. A `no-cors` request resolves (to an
 *  opaque response whose status cannot be read) as soon as a server replies,
 *  and rejects only when none does: DNS, refused connection, bad certificate.
 *  The body is dropped the moment the headers are in. */
async function reachable(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REACH_TIMEOUT_MS);
  try {
    await fetch(url, { mode: 'no-cors', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}


/** Whether an external link leads anywhere, for the "Open in a new tab" side
 *  of the dialog. Null is "fine" — or "cannot tell", which must not block
 *  anyone: offline, where every URL would look dead, and mixed content, which
 *  never leaves the browser. A tab has no CORS and no file type to care about,
 *  so this is the only question worth asking about it.
 *
 *  A plain read first, for the servers that allow one: their 404 is then
 *  readable. Only 404 and 410 count against a tab — a 401 or 403 is usually a
 *  login page, which the tab, carrying the user's cookies, gets past. Without
 *  CORS, "something answered" is all there is to know. The media check is
 *  deliberately NOT used here: a real file in a format this browser cannot
 *  decode would fail it, and refusing a good link is worse than accepting a
 *  dead one. */
export async function checkLinkTarget(url: string): Promise<RemoteRefusal | null> {
  if (!safeHttpUrl(url)) return { why: 'scheme' };
  if (isMixedContent(url) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REACH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status === 404 || res.status === 410 ? { why: 'nowhere' } : null;
  } catch {
    return (await reachable(url)) ? null : { why: 'nowhere' };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** embedService's safeExternalUrl, as a predicate — which that module cannot
 *  lend here, importing this one. */
function safeHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch { return false; }
}

/** The whole file is held three times over while it opens — the bytes, their
 *  base64 (a FileEntry's only form), and whatever the viewer decodes them into
 *  — and a base64 string cannot grow past V8's ~512 M characters at all. The
 *  audio player also decodes to PCM in full: 200 MB of mp3 is already hours.
 *  Attached files have no such limit only because a file picked on this device
 *  is one somebody chose; a link can point at anything. */
export const MAX_REMOTE_FILE_BYTES = 200 * 1024 * 1024;

/** How long the server may take to START answering. A host that is not there
 *  — a machine off the tailnet — can otherwise hold the connection for a
 *  minute or more before the browser gives up on its own. */
const HEADERS_TIMEOUT_MS = 20_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** What a URL's extension says, for the servers that label everything
 *  `application/octet-stream` and for choosing the row's icon before anything
 *  is fetched. Only the formats a viewer opens. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  weba: 'audio/webm', webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4',
  mov: 'video/quicktime',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', abc: 'text/vnd.abc',
};

/** Labels that say nothing about the content. */
const GENERIC_TYPES = new Set([
  '', 'application/octet-stream', 'binary/octet-stream',
  'application/force-download', 'application/x-download', 'application/download',
]);

/** Spellings of the three text formats, to the one each viewer checks for. */
const TEXT_ALIASES: Record<string, string> = {
  'text/x-markdown': 'text/markdown', 'text/x-abc': 'text/vnd.abc', 'text/abc': 'text/vnd.abc',
};

function extensionOf(path: string): string {
  const last = path.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

/** The type a URL's extension announces, or '' when it announces none. */
export function typeFromUrl(url: string): string {
  return TYPE_BY_EXTENSION[extensionOf(pathOf(url))] ?? '';
}

/** Whether the viewers can show this type. Deliberately a list, NOT `text/*`:
 *  a web page is `text/html`, and a page that happens to send a CORS header —
 *  TheSession's does, for its API — would otherwise open as its source. */
function isViewableType(mime: string): boolean {
  return mime.startsWith('audio/') || mime.startsWith('video/') || mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/vnd.abc';
}

/** What the response says it is, completed by the URL where it says nothing
 *  useful. `text/plain` counts as saying little: it is what most servers give
 *  an `.abc` or an `.md`, and the viewers pick those out by type. */
function declaredType(res: Response, url: string): string {
  const header = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const said = TEXT_ALIASES[header] ?? header;
  const byName = typeFromUrl(res.url || url) || typeFromUrl(url);
  if (GENERIC_TYPES.has(said)) return byName;
  if (said === 'text/plain' && byName.startsWith('text/')) return byName;
  return said;
}

/** The few formats worth recognising by their first bytes when neither the
 *  server nor the name says anything. Audio is sniffAudioMime's business. */
function sniffOther(head: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => head[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';           // %PDF-
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';                         // GIF8
  return null;
}

/** Whether the content is worth reading at all, before a byte of it is: a
 *  label that is already viewable, or one that says nothing and might hide a
 *  viewable file. A web page stops here, without its body being downloaded. */
function worthReading(declared: string): boolean {
  return isViewableType(declared) || needsAudioSniff(declared) || GENERIC_TYPES.has(declared);
}

/** The final type from the declared one and the first bytes, or null if what
 *  the bytes are is still nothing a viewer opens. */
function finalType(declared: string, head: Uint8Array): string | null {
  const sniffed = needsAudioSniff(declared) ? sniffAudioMime(head) : null;
  const type = sniffed ?? (GENERIC_TYPES.has(declared) ? sniffOther(head) ?? '' : declared);
  return isViewableType(type) ? type : null;
}

// ── Names ─────────────────────────────────────────────────────────────────────

/** The file's own name: the server's `Content-Disposition` when it lets a page
 *  read it (it is not one of the headers CORS exposes by default), else the
 *  last segment of the URL, else its host. */
function fileNameOf(res: Response | null, url: string): string {
  const disposition = res?.headers.get('content-disposition') ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
  const fromHeader = star?.[1] ?? plain?.[1];
  if (fromHeader) {
    try { return decodeURIComponent(fromHeader.trim()); } catch { return fromHeader.trim(); }
  }
  const segment = pathOf(res?.url || url).split('/').filter(Boolean).pop() ?? '';
  if (segment) {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }
  try { return new URL(url).hostname; } catch { return url; }
}

/** The name a remote file is shown under: the link's own label, with the
 *  file's extension added when the label has none — the viewer's download
 *  button names the file after it, and a download without its extension is
 *  one nobody can open. */
export function remoteDisplayName(label: string | undefined, url: string): string {
  const fileName = fileNameOf(null, url);
  const name = label?.trim() || fileName;
  const ext = extensionOf(fileName);
  return ext && extensionOf(name) !== ext ? `${name}.${ext}` : name;
}

// ── Fetching ──────────────────────────────────────────────────────────────────

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** The response, once its headers are in. Throws RemoteFileError for anything
 *  the server or the browser refused, and the caller's own AbortError as is —
 *  a cancel is not a refusal and must not be reported as one. */
async function openResponse(url: string, signal: AbortSignal | undefined, ctrl: AbortController): Promise<Response> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  if (isMixedContent(url)) throw new RemoteFileError({ why: 'insecure' });
  const forward = () => ctrl.abort();
  signal?.addEventListener('abort', forward);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, HEADERS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) { ctrl.abort(); throw new RemoteFileError(statusRefusal(res.status)); }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_REMOTE_FILE_BYTES) { ctrl.abort(); throw new RemoteFileError({ why: 'too-big', bytes: length }); }
    return res;
  } catch (e) {
    if (e instanceof RemoteFileError) throw e;
    if (isAbort(e) && !timedOut) throw e;
    // A host that has not started answering in 20 s is, for anyone waiting,
    // not there. Otherwise: was it the host, or the CORS read? Ask again.
    if (timedOut) throw new RemoteFileError({ why: 'nowhere' });
    throw new RemoteFileError((await reachable(url)) ? { why: 'cors' } : { why: 'nowhere' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** Reads the body, up to `limit` bytes when one is given (then stops the
 *  download), with progress along the way. */
async function readBody(
  res: Response, ctrl: AbortController, limit: number | null,
  onProgress?: (received: number, total: number | null) => void,
): Promise<Uint8Array> {
  const total = Number(res.headers.get('content-length')) || null;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      // A server that sends no length can still send too much.
      if (received > MAX_REMOTE_FILE_BYTES) throw new RemoteFileError({ why: 'too-big', bytes: received });
      onProgress?.(received, total);
      if (limit !== null && received >= limit) break;
    }
  } catch (e) {
    if (e instanceof RemoteFileError || isAbort(e)) throw e;
    // The connection dropped mid-file: for this file, the same as no server.
    throw new RemoteFileError({ why: 'nowhere' });
  } finally {
    if (limit !== null) ctrl.abort();
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export interface RemoteFileHead {
  /** The file's own name, which the link dialog offers as the automatic one. */
  name: string;
  mimeType: string;
}

/** Whether `url` opens here, found by asking for it and stopping as soon as
 *  the answer is known: at the headers for a labelled file or a web page, a
 *  few kilobytes in for a file that has to be recognised by its content. For
 *  the link dialog, which says so while the link is still in front of the
 *  user rather than at the first click on it. */
export async function probeRemoteFile(url: string, signal?: AbortSignal): Promise<RemoteFileHead> {
  const ctrl = new AbortController();
  const res = await openResponse(url, signal, ctrl);
  const declared = declaredType(res, url);
  if (!worthReading(declared)) { ctrl.abort(); throw new RemoteFileError({ why: 'unsupported' }); }
  const needsHead = GENERIC_TYPES.has(declared) || needsAudioSniff(declared);
  const head = needsHead ? await readBody(res, ctrl, SNIFF_BYTES) : new Uint8Array(0);
  if (!needsHead) ctrl.abort();
  const type = finalType(declared, head);
  if (!type) throw new RemoteFileError({ why: 'unsupported' });
  return { name: fileNameOf(res, url), mimeType: type };
}

/** The whole file, as the viewers take it. Asked again at every opening rather
 *  than trusted from the dialog's probe: the server may have changed its mind,
 *  or the file, since. `name` is what the viewer's title shows. */
export async function fetchRemoteFile(url: string, name: string, opts: {
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
} = {}): Promise<FileEntry> {
  const ctrl = new AbortController();
  const res = await openResponse(url, opts.signal, ctrl);
  const declared = declaredType(res, url);
  if (!worthReading(declared)) { ctrl.abort(); throw new RemoteFileError({ why: 'unsupported' }); }
  const bytes = await readBody(res, ctrl, null, opts.onProgress);
  const mimeType = finalType(declared, bytes.subarray(0, SNIFF_BYTES));
  if (!mimeType) throw new RemoteFileError({ why: 'unsupported' });
  return { name, mimeType, data: arrayBufferToBase64(bytes.buffer as ArrayBuffer) };
}
