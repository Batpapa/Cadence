import { signal } from '@preact/signals';
import { currentLanguage } from './i18nService';

// ── How dates and times are written ──────────────────────────────────────────
// Until 2026-10-13 every screen called toLocaleDateString() with no locale,
// which writes the BROWSER's convention — not the interface's, not the
// person's. Someone using Cadence in English on a browser set to US English got
// 10/12/2026 and 6 PM, with no way out short of changing their whole system.
//
// One setting now, on the user (synced: it describes how they read, like the
// language), and one place that writes a date. `auto` is exactly what the app
// did before, so nobody who leaves it alone sees anything move.
//
// The setting lives in a signal of its own rather than being read off the
// store: this module is imported by code the store's own import chain reaches
// (session naming), and store.ts's commitState sets it at the one point every
// state passes through — boot, edits and Drive alike.

export type DateFormat = 'auto' | 'dmy' | 'mdy' | 'ymd';
export const DATE_FORMATS: readonly DateFormat[] = ['auto', 'dmy', 'mdy', 'ymd'];

export const dateFormatPref = signal<DateFormat>('auto');

/** The stored value as a format: absent, or one a later build may add, reads
 *  as `auto` — the behaviour from before the setting existed. */
export function dateFormatOf(value: string | undefined): DateFormat {
  return DATE_FORMATS.includes(value as DateFormat) ? value as DateFormat : 'auto';
}

/** Called by commitState with the user's stored value. */
export function setDateFormatPref(value: string | undefined): void {
  const next = dateFormatOf(value);
  if (dateFormatPref.value !== next) dateFormatPref.value = next;
}

type When = Date | number | string;
const asDate = (d: When): Date => (d instanceof Date ? d : new Date(d));
const pad = (n: number) => String(n).padStart(2, '0');

/** The two explicit numeric conventions borrow a locale that writes exactly
 *  them; the third is ISO, written by hand since no locale is guaranteed to.
 *  `undefined` is the browser's own, for `auto`. */
const LOCALE: Record<DateFormat, string | undefined> = { auto: undefined, dmy: 'en-GB', mdy: 'en-US', ymd: undefined };

/** The date alone: 12/10/2026, 10/12/2026, 2026-10-12. */
export function fmtDate(d: When, fmt: DateFormat = dateFormatPref.value, locale?: string): string {
  const date = asDate(d);
  if (fmt === 'ymd') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.toLocaleDateString(fmt === 'auto' ? locale : LOCALE[fmt]);
}

/** The time of day, to the minute unless `seconds`: 18:00, 6:00 PM. */
export function fmtTime(d: When, opts: { seconds?: boolean } = {}, fmt: DateFormat = dateFormatPref.value, locale?: string): string {
  const date = asDate(d);
  const parts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', ...(opts.seconds ? { second: '2-digit' } : {}) };
  if (fmt === 'ymd') {
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return opts.seconds ? `${hm}:${pad(date.getSeconds())}` : hm;
  }
  // `[]` and not undefined for `auto`: what session naming always passed, and
  // the migration of generated names compares against exactly that string.
  return date.toLocaleTimeString(fmt === 'auto' ? (locale ?? []) : LOCALE[fmt], parts);
}

/** Date and time, joined by a space — the shape generated analysis names have
 *  always had (sessionNaming.ts), which is why it is kept for every format. */
export function fmtDateTime(d: When, opts: { seconds?: boolean } = {}, fmt: DateFormat = dateFormatPref.value, locale?: string): string {
  return `${fmtDate(d, fmt, locale)} ${fmtTime(d, opts, fmt, locale)}`;
}

// ── Reading a date someone typed ─────────────────────────────────────────────
// For components/dateField.tsx, which shows and takes dates in the format above
// — a native <input type="date"> cannot: its display follows the browser and
// no standard lets a page change it (2026-10-13). Values travel in the native
// field's own shape, 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' in local time, so every
// caller keeps the value it already handled.

type Part = 'd' | 'm' | 'y';

/** The order the three numbers come in, for a format. `auto` asks the
 *  browser, through the same locale fmtDate writes with. */
export function dateOrder(fmt: DateFormat = dateFormatPref.value): Part[] {
  if (fmt === 'dmy') return ['d', 'm', 'y'];
  if (fmt === 'mdy') return ['m', 'd', 'y'];
  if (fmt === 'ymd') return ['y', 'm', 'd'];
  const order = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(new Date(2026, 11, 24))
    .map(p => (p.type === 'day' ? 'd' : p.type === 'month' ? 'm' : p.type === 'year' ? 'y' : null))
    .filter((p): p is Part => p !== null);
  return order.length === 3 ? order : ['d', 'm', 'y'];
}

/** What stands between the three numbers when the format writes a date. */
export function dateSeparator(fmt: DateFormat = dateFormatPref.value): string {
  if (fmt === 'ymd') return '-';
  if (fmt !== 'auto') return '/';
  const lit = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(new Date(2026, 11, 24)).find(p => p.type === 'literal');
  return lit?.value.trim() || '/';
}

/** Whether times are written on a 12-hour clock in this format. */
export function uses12Hour(fmt: DateFormat = dateFormatPref.value): boolean {
  if (fmt === 'mdy') return true;
  if (fmt !== 'auto') return false;
  const opts = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
  return opts.hour12 ?? (opts.hourCycle === 'h11' || opts.hourCycle === 'h12');
}

const pad4 = (n: number) => String(n).padStart(4, '0');

/** A field value — 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' — as the local Date it
 *  names, or null. Read by components, never `new Date(value)`: a bare
 *  'YYYY-MM-DD' parses as UTC midnight, the day before west of Greenwich. */
export function fieldValueToDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!m) return null;
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return isNaN(d.getTime()) ? null : d;
}

/** A Date as a field value, to the day or to the minute. */
export function dateToFieldValue(d: Date, withTime: boolean): string {
  const day = `${pad4(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** A field value as the person reads it, in their format. Empty stays empty. */
export function fieldValueText(value: string, withTime: boolean, fmt: DateFormat = dateFormatPref.value): string {
  const d = fieldValueToDate(value);
  if (!d) return '';
  return withTime ? fmtDateTime(d, {}, fmt) : fmtDate(d, fmt);
}

/** What someone typed, read in their format — the three numbers of the date in
 *  the format's order, whatever separates them (/ . - or a space), and, with
 *  `withTime`, a time after them: "18:30", "18h30", "6:30 PM", "6pm". A date
 *  typed without a time is at midnight. Two-digit years are this century.
 *
 *  Returns the field value, or null when the text is not a real date — 31
 *  February included, which `new Date` would quietly turn into 3 March. */
export function parseFieldText(text: string, withTime: boolean, fmt: DateFormat = dateFormatPref.value): string | null {
  const m = /^\s*(\d{1,4})\s*[/.\- ]\s*(\d{1,4})\s*[/.\- ]\s*(\d{1,4})(.*)$/.exec(text);
  if (!m) return null;
  const nums = [m[1]!, m[2]!, m[3]!];
  const order = dateOrder(fmt);
  const at = (p: Part) => nums[order.indexOf(p)]!;
  let y = parseInt(at('y'), 10);
  if (at('y').length <= 2) y += 2000;
  const mo = parseInt(at('m'), 10);
  const d = parseInt(at('d'), 10);
  if (at('y').length === 3 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  let h = 0, min = 0;
  // Whatever follows the date — a comma some locales put there, or ISO's T,
  // then the time.
  const rest = m[4]!.replace(/^\s*,?\s*T?/, '');
  if (rest !== '') {
    if (!withTime) return null;
    const tm = /^(\d{1,2})(?:\s*[:h.]\s*(\d{2}))?(?::\d{2})?\s*(?:([ap])\.?\s*m\.?)?$/i.exec(rest);
    if (!tm) return null;
    h = parseInt(tm[1]!, 10);
    min = tm[2] ? parseInt(tm[2], 10) : 0;
    const meridiem = tm[3]?.toLowerCase();
    if (meridiem) {
      if (h < 1 || h > 12) return null;
      if (meridiem === 'p' && h !== 12) h += 12;
      if (meridiem === 'a' && h === 12) h = 0;
    }
    if (h > 23 || min > 59) return null;
  }
  const date = new Date(y, mo - 1, d, h, min);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return dateToFieldValue(date, withTime);
}

/** Day and short month, for a chart's axis: "12 Oct", "Oct 12". The month's
 *  NAME is in the interface's language; only its place follows the setting. */
export function fmtDayMonth(d: When, fmt: DateFormat = dateFormatPref.value): string {
  const date = asDate(d);
  if (fmt === 'auto') return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const month = date.toLocaleDateString(currentLanguage(), { month: 'short' });
  return fmt === 'mdy' ? `${month} ${date.getDate()}` : `${date.getDate()} ${month}`;
}
