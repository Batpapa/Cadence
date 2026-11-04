import { signal } from '@preact/signals';
import type { EmbedEntry, FileAttachment } from '../types';
import { fetchRemoteFile, remoteDisplayName } from './remoteFile';
import { arrayBufferToBase64 } from '../utils';

// ── A score that is a link ───────────────────────────────────────────────────
// A link to an `.abc` file is a card's score like an attached one
// (abcService's isAbcLink, 2026-11-04). Whoever needs its notation gets it
// here, as the file attachment it would have been — the readers of a score
// all take one — and puts it in the place of the link on a COPY: the card
// itself keeps only the URL (remoteFile.ts's whole point).
//
// Remembered by URL for the session, for the readers that draw during a
// render and cannot wait (the incipit): the first one asks, the row redraws
// when `abcLinkArrived` moves. `null` means it was tried and will not come.
// An opening asks again every time, as any link to a file does — the server
// may have changed the file since — and refreshes what is remembered.

const _byUrl = new Map<string, FileAttachment | null>();
const _fetching = new Set<string>();
export const abcLinkArrived = signal(0);

/** The link's ABC, fetched now. Throws what fetchRemoteFile throws. */
export async function fetchAbcLink(entry: EmbedEntry, signal?: AbortSignal): Promise<FileAttachment> {
  const remote = await fetchRemoteFile(entry.url, { signal });
  const att: FileAttachment = {
    type: 'file',
    name: remoteDisplayName(entry.title, entry.url),
    mimeType: remote.blob.type,
    data: arrayBufferToBase64(await remote.blob.arrayBuffer()),
  };
  _byUrl.set(entry.url, att);
  return att;
}

/** What is remembered of the link, without asking anything: the file, `null`
 *  when it could not be had, undefined when it was never asked for. */
export function peekAbcLink(url: string): FileAttachment | null | undefined {
  return _byUrl.get(url);
}

/** The same, and asked for in the background when it never was. */
export function abcLinkFile(entry: EmbedEntry): FileAttachment | null | undefined {
  if (_byUrl.has(entry.url)) return _byUrl.get(entry.url);
  if (!_fetching.has(entry.url)) {
    _fetching.add(entry.url);
    void fetchAbcLink(entry)
      .catch(() => { _byUrl.set(entry.url, null); })
      .finally(() => { _fetching.delete(entry.url); abcLinkArrived.value++; });
  }
  return undefined;
}
