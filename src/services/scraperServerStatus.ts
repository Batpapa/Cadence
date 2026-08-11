// ── Shared "is the scraper server warm" tracking ──────────────────────────────
// The IrishTuneInfo scraper endpoints (irishTuneInfoService.ts) and the share
// upload/download endpoints (shareService.ts) are hosted on the same Render
// free-tier instance, which sleeps after inactivity — the first request after
// a while can take up to ~1 min to wake it. One shared flag, not one per
// feature: whichever of them hits the server first marks it warm for both.

export const SCRAPER_BASE = 'https://irishtuneinfo-scraper-api.onrender.com';

let serverWarm = false;
export function isScraperServerWarm(): boolean { return serverWarm; }
export function markScraperServerWarm(): void { serverWarm = true; }
