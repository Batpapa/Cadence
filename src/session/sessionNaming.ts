import { t, tIn, type Lang } from '../services/i18nService';
import { fmtDateTime, browserLocale, AUTO_LOCALE, type DateFormat } from '../services/dateFormat';
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
  return fmtDateTime(dateIso);
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

// ── When the date format changes ─────────────────────────────────────────────
// A generated name is stored with the date written INTO it, in the format of
// the day it was saved. Changing the format would leave every one of them in
// the old convention — and `dateBesideName` below, no longer finding the date
// in the name, would print it a second time beside each of them.
//
// So the names Cadence wrote itself are rewritten, at the moment the setting
// changes (the user's rule, 2026-10-13) and never as a standing repair: a name
// is rewritten only if it is EXACTLY what the generator produced under the old
// format, in either language. Anything typed by hand differs by at least a
// character and is never touched; an analysis named on a device whose
// convention is not among the candidates keeps its name, and shows its date
// beside it like a renamed one.

const GENERATED_KEYS = ['sessions.defaultName.mic', 'sessions.defaultName.device'] as const;
const NAME_LANGS: Lang[] = ['en', 'fr'];
/** What `auto` may have written: what it means in each language today, and
 *  what it meant before 2026-10-13 — the browser's own convention, this one's
 *  or the ones the people using Cadence most likely had on another device. */
function autoLocales(): string[] {
  return [...new Set([...Object.values(AUTO_LOCALE), browserLocale(), 'en-US', 'en-GB', 'fr-FR'])];
}

function whenCandidates(dateIso: string, fmt: DateFormat): string[] {
  if (fmt !== 'auto') return [fmtDateTime(dateIso, {}, fmt)];
  return [...new Set(autoLocales().map(locale => fmtDateTime(dateIso, {}, 'auto', locale)))];
}

/** Every way Cadence may have written this date into a name: each explicit
 *  format, and each convention `auto` has stood for. */
function anyWhen(dateIso: string): string[] {
  return [...new Set([
    ...whenCandidates(dateIso, 'auto'),
    ...(['dmy', 'mdy', 'ymd'] as const).flatMap(f => whenCandidates(dateIso, f)),
  ])];
}

/** Rewrites, in place, the generated names among `sessions` from format `from`
 *  to format `to`; returns how many changed. Call it inside the mutate that
 *  stores the new setting, so the two land together. */
export function renameGeneratedNames(sessions: Analysis[], from: DateFormat, to: DateFormat): number {
  if (from === to) return 0;
  let renamed = 0;
  for (const s of sessions) {
    if (!s.date || !s.name) continue;
    const olds = whenCandidates(s.date, from);
    search: for (const lang of NAME_LANGS) {
      for (const key of GENERATED_KEYS) {
        const template = tIn(lang, key);
        for (const when of olds) {
          if (s.name !== template.split('{when}').join(when)) continue;
          const next = template.split('{when}').join(fmtDateTime(s.date, {}, to));
          if (next !== s.name) { s.name = next; renamed++; }
          break search;
        }
      }
    }
  }
  return renamed;
}

/** The date, for a place that prints the name in full and wants the date on a
 *  separate line — the library row. Empty when the name already carries it,
 *  which the generated names do, so a default-named session says it once and a
 *  renamed one still shows when it was recorded.
 *
 *  "Carries it" in ANY of the ways a date was ever written into a name, not
 *  only today's: a name generated on another device, or before the format
 *  setting, says it in another convention — and printing it again beside, in
 *  this one, read as two different dates (2026-10-13). */
export function dateBesideName(name: string, dateIso: string | null): string {
  if (!dateIso) return '';
  if (anyWhen(dateIso).some(w => name.includes(w))) return '';
  return fmtSessionDateTime(dateIso);
}
