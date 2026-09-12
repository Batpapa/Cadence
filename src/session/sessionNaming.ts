import { t } from '../services/i18nService';
import type { Analysis } from './model';

// ── What a session is called ─────────────────────────────────────────────────
// A session's name is DATA, not a rendering. It is written once, when the
// session is saved (or backfilled by db.ts's migrateSession for sessions
// recorded before this existed), and every screen afterwards just reads
// `session.name`.
//
// It used to be derived at display time instead, which meant the same session
// could read differently in the library, on a card's detection list and in a
// downloaded filename, and that renaming had to fight a fallback. One stored
// string removes all of that.

/** Start date and time of day — the pair that actually tells two sessions
 *  apart. A festival day produces several, so the date alone identifies
 *  nothing. */
export function fmtSessionDateTime(dateIso: string): string {
  const d = new Date(dateIso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** The name a newly saved session gets, naming what it actually is: captured
 *  device audio and a microphone recording are different enough acts that
 *  someone scanning thirty of them wants to know which is which at a glance.
 *
 *  Imports never come here — a file already has a name, and it is a better one
 *  than anything this could invent. */
export function generatedSessionName(source: Analysis['source'], dateIso: string | null): string {
  const when = dateIso ? fmtSessionDateTime(dateIso) : '';
  const key = source === 'device' ? 'sessions.defaultName.device' : 'sessions.defaultName.mic';
  return when ? t(key, { when }) : t(`${key}.undated`);
}

/** The date, for a place that prints the name in full and wants the date on a
 *  separate line — the library row. Empty when the name already carries it,
 *  which the generated names do, so a default-named session says it once and a
 *  renamed one still shows when it was recorded. */
export function dateBesideName(name: string, dateIso: string | null): string {
  if (!dateIso) return '';
  const when = fmtSessionDateTime(dateIso);
  return name.includes(when) ? '' : when;
}
