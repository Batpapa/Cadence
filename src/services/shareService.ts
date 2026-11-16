import { SCRAPER_BASE as BASE, markScraperServerWarm } from './scraperServerStatus';

export interface ShareUploadResult {
  key: string;
  secondsRemaining: number;
}

/** The share server has no fixed cap since 2026-11-15: it takes what fits on
 *  its disk, and an item that does not fit yet waits its turn in a queue
 *  (everything stored expires within 10 minutes). Only an item larger than
 *  the store could EVER hold is refused, with that figure. */
export class ShareTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('share_too_large');
  }
}

export interface ShareCapacity {
  /** What would fit right now. */
  availableBytes: number;
  /** The most that could ever fit, once everything stored has expired. Null
   *  from a server older than the queue. */
  maxBytes: number | null;
}

/** Room on the share server, asked before a package is offered for sending. */
export async function getShareCapacity(): Promise<ShareCapacity> {
  const res = await fetch(`${BASE}/share/capacity`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  markScraperServerWarm();
  const json = await res.json() as { availableBytes: number; maxBytes?: number };
  return { availableBytes: json.availableBytes, maxBytes: json.maxBytes ?? null };
}

export interface UploadShareOptions {
  /** How much of the body has gone. */
  onProgress?: (sent: number, total: number) => void;
  /** Waiting for room: this many items are ahead, this one included. */
  onWaiting?: (position: number) => void;
  /** Cancels the wait or the upload; the promise rejects with an AbortError. */
  signal?: AbortSignal;
}

/** How often a waiting ticket is asked about — well inside the server's 60 s
 *  after which an unasked ticket is dropped. */
const TICKET_POLL_MS = 4000;

interface TicketAnswer { ticket: string; status: 'ready' | 'waiting'; position?: number }

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A ticket for `size` bytes, once it is granted. Null when the server
 *  predates the queue (no /share/ticket route): the upload then goes straight
 *  in, as it always did. */
async function takeTicket(size: number, options: UploadShareOptions): Promise<string | null> {
  const { signal, onWaiting } = options;
  let res = await fetch(`${BASE}/share/ticket?size=${size}`, { method: 'POST', signal });
  if (res.status === 404) return null;
  for (;;) {
    if (res.status === 413) {
      const json = await res.json().catch(() => ({})) as { maxBytes?: number };
      throw new ShareTooLargeError(json.maxBytes ?? 0);
    }
    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(json.message ?? `HTTP ${res.status}`);
    }
    markScraperServerWarm();
    const answer = await res.json() as TicketAnswer;
    if (answer.status === 'ready') return answer.ticket;
    onWaiting?.(answer.position ?? 1);
    try {
      await sleep(TICKET_POLL_MS, signal);
    } catch (e) {
      // Given back, so the room it may be about to get goes to the next one.
      void fetch(`${BASE}/share/ticket/${encodeURIComponent(answer.ticket)}`, { method: 'DELETE' }).catch(() => {});
      throw e;
    }
    res = await fetch(`${BASE}/share/ticket/${encodeURIComponent(answer.ticket)}`, { signal });
    // Lapsed — the server restarted, or the phone slept past a minute: a new
    // ticket, at the back of the queue.
    if (res.status === 404) res = await fetch(`${BASE}/share/ticket?size=${size}`, { method: 'POST', signal });
  }
}

/** Sends one item, raw. XMLHttpRequest rather than fetch for the one thing
 *  fetch cannot do: say how much of the body has gone — a 3-hour recording
 *  from a phone takes minutes. The size goes in the URL too, for a proxy that
 *  would drop Content-Length: the server checks it before reading anything. */
function send(body: Blob, ticket: string | null, options: UploadShareOptions): Promise<ShareUploadResult> {
  const { onProgress, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const xhr = new XMLHttpRequest();
    const query = `size=${body.size}` + (ticket ? `&ticket=${encodeURIComponent(ticket)}` : '');
    xhr.open('POST', `${BASE}/share/upload?${query}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'text';
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : body.size);
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      let json: { key?: string; secondsRemaining?: number; message?: string } = {};
      try { json = JSON.parse(xhr.responseText); } catch { /* not JSON: said by its status below */ }
      if (xhr.status >= 200 && xhr.status < 300 && json.key) {
        markScraperServerWarm();
        resolve({ key: json.key, secondsRemaining: json.secondsRemaining ?? 0 });
      } else {
        reject(new Error(json.message ?? `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('network_error'));
    xhr.onabort = () => reject(abortError());
    xhr.send(body);
  });
}

/** Takes a place in the queue, waits for its turn, then sends. */
export async function uploadShare(content: string | Blob, options: UploadShareOptions = {}): Promise<ShareUploadResult> {
  const body = typeof content === 'string' ? new Blob([content]) : content;
  const ticket = await takeTicket(body.size, options);
  return send(body, ticket, options);
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

async function fetchShare(key: string): Promise<Response> {
  const res = await fetch(`${BASE}/share/${encodeURIComponent(key.toUpperCase())}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Clé introuvable ou expirée.');
    throw new Error(`HTTP ${res.status}`);
  }
  markScraperServerWarm();
  return res;
}

/** A shared item as it was sent (a package, attachments or audio included). */
export async function downloadShareBlob(key: string): Promise<Blob> {
  return (await fetchShare(key)).blob();
}
