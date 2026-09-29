import type { EmbedEntry, LinkMode } from '../types';
import { probeRemoteFile, checkLinkTarget, statusRefusal, RemoteFileError, type RemoteRefusal } from './remoteFile';

export type EmbedPlatform = 'youtube' | 'spotify' | 'deezer' | 'soundcloud';

export const PLATFORM_ICONS: Record<EmbedPlatform, string> = {
  youtube:    '▶',
  spotify:    '♫',
  deezer:     '♪',
  soundcloud: '☁',
};

const OEMBED_ENDPOINTS: Record<EmbedPlatform, string> = {
  youtube:    'https://www.youtube.com/oembed',
  spotify:    'https://open.spotify.com/oembed',
  deezer:     'https://deezer.com/oembed',
  soundcloud: 'https://soundcloud.com/oembed',
};

// ── What a link does when opened ──────────────────────────────────────────────

/** The one reader of `EmbedEntry.mode`. An absent mode is an embed: that is
 *  what every link stored before 2026-09-22 was, and what a card package or an
 *  AI import that says nothing still means. New entries write both values
 *  explicitly all the same — an optional flag read in two places is how a
 *  deliberate choice turns back into a default (see CLAUDE.md). */
export function linkMode(entry: EmbedEntry): LinkMode {
  return entry.mode === 'link' ? 'link' : 'embed';
}

/** The name the platform gives an embed, or undefined for an external link,
 *  which has none. An embed stored before 2026-09-28 has no `autoTitle`, but
 *  nothing could be typed over its `title` then, so that title is the one. */
export function embedAutoTitle(entry: EmbedEntry): string | undefined {
  if (linkMode(entry) !== 'embed') return undefined;
  return entry.autoTitle ?? entry.title;
}

/** Whether an embed is a FILE, opened by Cadence's own viewers (remoteFile.ts),
 *  rather than one of the four platforms' iframes. Told by the URL and never by
 *  `embedUrl`: a file's is its own URL, stored so that an older bundle, which
 *  knows only iframes, still shows it in one (see EmbedEntry). */
export function isFileEmbed(entry: EmbedEntry): boolean {
  return linkMode(entry) === 'embed' && detectPlatform(entry.url) === null;
}

/** `url` if it is safe to put in an `href`, else null.
 *
 *  An external link is the first place this app hands a stored string straight
 *  to the browser as a navigation target, and attachments arrive from card
 *  packages and AI-written JSON as well as from the dialog — `javascript:` in
 *  that field would be a script injection with the CSP none the wiser, since
 *  it is the user's own click that runs it. Only the two schemes an external
 *  link can plausibly want are let through. */
export function safeExternalUrl(url: string): string | null {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch { return null; }
}

// ── Platform detection ────────────────────────────────────────────────────────

export function detectPlatform(url: string): EmbedPlatform | null {
  try {
    const { hostname } = new URL(url);
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'youtube';
    if (hostname.includes('spotify.com'))    return 'spotify';
    if (hostname.includes('deezer.com'))     return 'deezer';
    if (hostname.includes('soundcloud.com')) return 'soundcloud';
  } catch { /* invalid URL */ }
  return null;
}

// ── Modal iframe dimensions ───────────────────────────────────────────────────

export const IFRAME_DIMS: Record<EmbedPlatform, { width: string; height: string }> = {
  youtube:    { width: '854px', height: '480px' },
  spotify:    { width: '500px', height: '352px' },
  deezer:     { width: '500px', height: '200px' },
  soundcloud: { width: '600px', height: '200px' },
};

// ── oEmbed fetch ──────────────────────────────────────────────────────────────

/** The platform's own answer about a URL, or why there is none, in the same
 *  words as a file's refusal: a video that does not exist is `nowhere`, a
 *  private or non-embeddable one `forbidden` (YouTube answers 401), and a
 *  platform page that is no playable item — a profile, a search — comes back
 *  without an iframe, which is `unsupported`. */
async function fetchOEmbed(platform: EmbedPlatform, url: string): Promise<{ title: string; embedUrl: string } | RemoteRefusal> {
  try {
    const endpoint = OEMBED_ENDPOINTS[platform];
    const res = await fetch(`${endpoint}?format=json&url=${encodeURIComponent(url)}`);
    if (!res.ok) return statusRefusal(res.status);
    const data = await res.json() as { title?: string; html?: string; thumbnail_url?: string };
    const title = data.title ?? '';
    const match = data.html?.match(/src="([^"]+)"/);
    const embedUrl = match?.[1] ?? null;
    if (!embedUrl) return { why: 'unsupported' };
    return { title, embedUrl };
  } catch { return { why: 'nowhere' }; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** What the link dialog learns about a URL, on either side of its toggle. An
 *  external link has no title to learn and no iframe, hence the empty ones. */
export type LinkCheck =
  | { ok: true; title: string; embedUrl: string }
  | { ok: false; refusal: RemoteRefusal };

/** Whether `url` plays in the app, and under what name — oEmbed for the four
 *  platforms, a probe of the file itself for anything else. A file's
 *  `embedUrl` is its own URL: nothing else would show it in an older bundle's
 *  iframe, which is the only thing such a bundle does with an embed. */
export async function checkEmbed(url: string): Promise<LinkCheck> {
  if (!safeExternalUrl(url)) return { ok: false, refusal: { why: 'scheme' } };
  const platform = detectPlatform(url);
  if (platform) {
    const answer = await fetchOEmbed(platform, url);
    return 'why' in answer ? { ok: false, refusal: answer } : { ok: true, ...answer };
  }
  try {
    const head = await probeRemoteFile(url);
    return { ok: true, title: head.name, embedUrl: url };
  } catch (e) {
    return { ok: false, refusal: e instanceof RemoteFileError ? e.refusal : { why: 'nowhere' } };
  }
}

/** Whether an external link leads anywhere — the one thing a new tab needs. */
export async function checkLink(url: string): Promise<LinkCheck> {
  const refusal = await checkLinkTarget(url);
  return refusal ? { ok: false, refusal } : { ok: true, title: '', embedUrl: '' };
}
