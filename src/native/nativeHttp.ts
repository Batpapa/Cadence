import { CapacitorHttp } from '@capacitor/core';

// ── A GET through Android's own HTTP stack ───────────────────────────────────
// For the app only (2026-10-09, group feedback): a page may read another
// origin's response only if that origin allows it (CORS), and the app's
// origin, https://localhost, is the one every Capacitor app shares — allowing
// it on a server proves nothing about who asks. A request made by the OS
// itself is not a page's, so no CORS applies.
//
// `CapacitorHttp.request`, called per request, never the global switch that
// replaces `fetch` and `XMLHttpRequest` for the whole app: that one would also
// take over Drive, the blob URLs and everything else that works as it is.
//
// The body comes back whole, base64 — what a FileEntry stores anyway. No
// streaming and no cancelling once sent: progress and cancelling come from
// asking for a file piece by piece (remoteFile.ts's fetchNative).

export interface NativeGetResult {
  status: number;
  /** After redirects. */
  url: string;
  /** Names in lower case: Android hands them over as the server spelt them. */
  headers: Map<string, string>;
  /** The body, for a 2xx; '' for a JSON one, which the plugin parses instead. */
  base64: string;
}

export async function nativeGet(url: string, opts: {
  headers?: Record<string, string>;
  /** Connecting, and then each pause in the data. */
  timeoutMs: number;
}): Promise<NativeGetResult> {
  const res = await CapacitorHttp.request({
    url,
    method: 'GET',
    headers: opts.headers,
    responseType: 'arraybuffer',
    connectTimeout: opts.timeoutMs,
    readTimeout: opts.timeoutMs,
  });
  const headers = new Map<string, string>();
  // The status line comes through under a null name.
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (k && k !== 'null') headers.set(k.toLowerCase(), String(v));
  }
  return {
    status: res.status,
    url: res.url || url,
    headers,
    // Android's Base64.DEFAULT breaks lines every 76 characters.
    base64: typeof res.data === 'string' ? res.data.replace(/\s+/g, '') : '',
  };
}
