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
