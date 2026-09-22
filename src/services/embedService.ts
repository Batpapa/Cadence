import type { EmbedEntry, LinkMode } from '../types';

export type EmbedPlatform = 'youtube' | 'spotify' | 'deezer' | 'soundcloud';

export interface EmbedMeta {
  platform: EmbedPlatform;
  embedUrl: string;
  title: string;
  icon: string;
}

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

async function fetchOEmbed(platform: EmbedPlatform, url: string): Promise<{ title: string; embedUrl: string } | null> {
  try {
    const endpoint = OEMBED_ENDPOINTS[platform];
    const res = await fetch(`${endpoint}?format=json&url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json() as { title?: string; html?: string; thumbnail_url?: string };
    const title = data.title ?? '';
    const match = data.html?.match(/src="([^"]+)"/);
    const embedUrl = match?.[1] ?? null;
    if (!embedUrl) return null;
    return { title, embedUrl };
  } catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function resolveEmbed(url: string): Promise<EmbedMeta | null> {
  const platform = detectPlatform(url);
  if (!platform) return null;
  const result = await fetchOEmbed(platform, url);
  if (!result) return null;
  return { platform, ...result, icon: PLATFORM_ICONS[platform] };
}
