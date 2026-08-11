import { SCRAPER_BASE as BASE, markScraperServerWarm } from './scraperServerStatus';

export interface ShareUploadResult {
  key: string;
  secondsRemaining: number;
}

export async function uploadShare(content: string): Promise<ShareUploadResult> {
  const res = await fetch(`${BASE}/share/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new TextEncoder().encode(content),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as { message?: string }).message ?? `HTTP ${res.status}`);
  }
  markScraperServerWarm();
  return res.json() as Promise<ShareUploadResult>;
}

export async function downloadShare(key: string): Promise<string> {
  const res = await fetch(`${BASE}/share/${encodeURIComponent(key.toUpperCase())}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Clé introuvable ou expirée.');
    throw new Error(`HTTP ${res.status}`);
  }
  markScraperServerWarm();
  return res.text();
}
