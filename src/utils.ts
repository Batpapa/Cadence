import { t, tIn, currentLanguage, type Lang } from './services/i18nService';

export function generateId(): string {
  return crypto.randomUUID();
}

/** Rejects with `message` if `promise` hasn't settled within `ms` — turns a
 *  silent hang (blocked IndexedDB upgrade, a stuck OAuth popup) into a
 *  surfaced, recoverable error instead of freezing the app forever. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

// Only the URL: the pin's colour names the site, and the tooltip now shows the
// stored `externalId` itself, so no source ever needs a display name here.
const EXTERNAL_SOURCES: Record<string, { url: (id: string) => string }> = {
  thesession: { url: id => `https://thesession.org/tunes/${id}` },
  irishtuneinfo: { url: id => `https://www.irishtune.info/tune/${id}/` },
  // A set's id alone cannot rebuild its URL — thesession.org/sets/{id} is a 404,
  // only /members/{memberId}/sets/{id} resolves — so the id carries both, as
  // "{member}-{set}", and the pin shows that pair whole: it IS the set's
  // address here, and hiding half of it made the pin unquotable.
  'thesession-set': {
    url: id => {
      const [member, set] = id.split('-');
      return `https://thesession.org/members/${member}/sets/${set}`;
    },
  },
};

/** "thesession:52302" → { source: "thesession", id: "52302", label: "thesession:52302",
 *  url: "https://thesession.org/tunes/52302" }. `id` alone is what the card page's pin
 *  shows (the source is already carried by the pin's colour); `label` is the `externalId`
 *  verbatim, which is what the tooltip spells out — the stored value, quotable as-is into
 *  a bug report or a search, rather than a prettied-up rendering of it.
 *  Reconstructed from the id alone (no slug needed by either source) — independent of
 *  `content.notes`, which the user can freely edit away. */
export function externalSourceLink(externalId: string | undefined): { source: string; id: string; label: string; url: string } | null {
  if (!externalId) return null;
  const sep = externalId.indexOf(':');
  if (sep === -1) return null;
  const source = externalId.slice(0, sep);
  const id = externalId.slice(sep + 1);
  const def = EXTERNAL_SOURCES[source];
  if (!def) return null;
  return { source, id, label: externalId, url: def.url(id) };
}

export function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The recall dot's colour. `neverReviewed`: grey, like the ease dot beside
 *  it — a card nobody has studied yet is not a card that was forgotten, and it
 *  was red on the first day for every card of a fresh library (UX review,
 *  2026-11-11, the user's call). */
export function availabilityColor(k: number, neverReviewed = false): string {
  if (neverReviewed) return 'bg-border';
  if (k >= 0.75) return 'bg-success';
  if (k >= 0.4)  return 'bg-warn';
  return 'bg-danger';
}

export function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor(diff / 60000);
  if (days > 30) return t('time.ago.months', { n: Math.floor(days / 30) });
  if (days > 0)  return t('time.ago.days',   { n: days });
  if (hours > 0) return t('time.ago.hours',  { n: hours });
  if (minutes > 0) return t('time.ago.minutes', { n: minutes });
  return t('time.ago.justNow');
}

export const DAY_NAMES_KEYS = [
  'time.days.sun', 'time.days.mon', 'time.days.tue', 'time.days.wed',
  'time.days.thu', 'time.days.fri', 'time.days.sat',
] as const;

/** Human-readable byte size, for the places where storage weight is the point
 *  being made (removing a user, embedding session audio, sharing a recording).
 *  Deliberately coarse: one decimal below 10 units and none above, because
 *  these numbers exist to convey an order of magnitude, not an exact figure.
 *  Uses MB/GB in the everyday (1024-based) sense the rest of the app already
 *  displays. In the interface's language: octets in French (Mo, Go — 2026-10-26, « bytes »
 *  read as English there), with its decimal comma. */
export function formatBytes(bytes: number, lang: Lang = currentLanguage()): string {
  return formatSize(bytes, 1024, lang);
}

/** In powers of 1000, as Android's Settings → Storage counts: for a figure
 *  someone will hold up against that screen, where formatBytes' powers of 1024
 *  would show 2.8 GB for the phone's 3.0 GB. */
export function formatDiskBytes(bytes: number, lang: Lang = currentLanguage()): string {
  return formatSize(bytes, 1000, lang);
}

function formatSize(bytes: number, base: number, lang: Lang): string {
  const unit = (key: string) => tIn(lang, `units.${key}`);
  // No grouping: « 1000 Mo » rather than « 1 000 Mo » or « 1,000 MB ».
  const num = (v: number, digits: number) =>
    v.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
  if (bytes < base) return `${Math.round(bytes)} ${unit('B')}`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / base;
  let i = 0;
  while (value >= base && i < units.length - 1) { value /= base; i++; }
  return `${value >= 10 ? num(Math.round(value), 0) : num(value, 1)} ${unit(units[i]!)}`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
