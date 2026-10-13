import { describe, it, expect, afterEach } from 'vitest';
import { fmtDate, fmtTime, fmtDateTime, fmtDayMonth, dateFormatOf, setDateFormatPref, dateFormatPref, parseFieldText, fieldValueText, fieldValueToDate, dateToFieldValue, AUTO_LOCALE } from './dateFormat';
import { setLanguage } from './i18nService';

// Built from LOCAL components, so the expectations hold in whatever time zone
// the suite runs.
const EVENING = new Date(2026, 11, 24, 18, 30, 5);

describe('dateFormat', () => {
  afterEach(() => setDateFormatPref(undefined));

  it('writes the date in each explicit convention', () => {
    expect(fmtDate(EVENING, 'dmy')).toBe('24/12/2026');
    expect(fmtDate(EVENING, 'mdy')).toBe('12/24/2026');
    expect(fmtDate(EVENING, 'ymd')).toBe('2026-12-24');
  });

  it('writes the time on a 24-hour clock except month-first', () => {
    expect(fmtTime(EVENING, {}, 'dmy')).toBe('18:30');
    expect(fmtTime(EVENING, {}, 'ymd')).toBe('18:30');
    // \s: recent ICU puts a narrow no-break space before PM.
    expect(fmtTime(EVENING, {}, 'mdy')).toMatch(/^06:30\sPM$/u);
    expect(fmtTime(EVENING, { seconds: true }, 'ymd')).toBe('18:30:05');
    expect(fmtTime(EVENING, { seconds: true }, 'dmy')).toBe('18:30:05');
  });

  it('joins date and time with a space, the shape generated names have', () => {
    expect(fmtDateTime(EVENING, {}, 'dmy')).toBe('24/12/2026 18:30');
  });

  it('auto follows the interface language, never the browser', () => {
    setLanguage('en');
    expect(fmtDateTime(EVENING, {}, 'auto')).toBe('24/12/2026 18:30');
    expect(fmtDayMonth(EVENING, 'auto')).toBe('24 Dec');
    expect(parseFieldText('24/12/2026', false, 'auto')).toBe('2026-12-24');
    setLanguage('fr');
    expect(fmtDateTime(EVENING, {}, 'auto')).toBe('24/12/2026 18:30');
    expect(fmtDayMonth(EVENING, 'auto')).toBe('24 déc.');
    setLanguage('en');
  });

  it('defines auto for every language of the interface', () => {
    // The type already refuses a missing one; this says why it matters.
    for (const lang of ['en', 'fr'] as const) expect(AUTO_LOCALE[lang]).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  });

  it('places the day and the month name by the setting', () => {
    expect(fmtDayMonth(EVENING, 'dmy')).toBe('24 Dec');
    expect(fmtDayMonth(EVENING, 'mdy')).toBe('Dec 24');
  });

  it('reads an absent or unknown stored value as auto', () => {
    expect(dateFormatOf(undefined)).toBe('auto');
    expect(dateFormatOf('dd.mm.yy')).toBe('auto');
    expect(dateFormatOf('ymd')).toBe('ymd');
  });

  it('reads a typed date in the order of its format', () => {
    expect(parseFieldText('24/12/2026', false, 'dmy')).toBe('2026-12-24');
    expect(parseFieldText('12/24/2026', false, 'mdy')).toBe('2026-12-24');
    expect(parseFieldText('2026-12-24', false, 'ymd')).toBe('2026-12-24');
    // Whatever the separator, short numbers, a two-digit year.
    expect(parseFieldText('1.2.26', false, 'dmy')).toBe('2026-02-01');
    expect(parseFieldText(' 3 4 2026 ', false, 'dmy')).toBe('2026-04-03');
  });

  it('refuses what is not a real date', () => {
    expect(parseFieldText('31/02/2026', false, 'dmy')).toBeNull();
    expect(parseFieldText('24/13/2026', false, 'dmy')).toBeNull();
    expect(parseFieldText('24/12', false, 'dmy')).toBeNull();
    expect(parseFieldText('yesterday', false, 'dmy')).toBeNull();
    expect(parseFieldText('24/12/2026 18:30', false, 'dmy')).toBeNull();
  });

  it('reads a time after the date, on either clock', () => {
    expect(parseFieldText('24/12/2026 18:30', true, 'dmy')).toBe('2026-12-24T18:30');
    expect(parseFieldText('24/12/2026 18h30', true, 'dmy')).toBe('2026-12-24T18:30');
    expect(parseFieldText('12/24/2026 6:30 PM', true, 'mdy')).toBe('2026-12-24T18:30');
    expect(parseFieldText('12/24/2026, 12:05 am', true, 'mdy')).toBe('2026-12-24T00:05');
    expect(parseFieldText('12/24/2026 6pm', true, 'mdy')).toBe('2026-12-24T18:00');
    expect(parseFieldText('2026-12-24T07:15', true, 'ymd')).toBe('2026-12-24T07:15');
    expect(parseFieldText('24/12/2026', true, 'dmy')).toBe('2026-12-24T00:00');
    expect(parseFieldText('24/12/2026 25:00', true, 'dmy')).toBeNull();
    expect(parseFieldText('12/24/2026 13:00 PM', true, 'mdy')).toBeNull();
  });

  it('reads back what it writes, in every format', () => {
    for (const fmt of ['auto', 'dmy', 'mdy', 'ymd'] as const) {
      expect(parseFieldText(fieldValueText('2026-12-24', false, fmt), false, fmt)).toBe('2026-12-24');
      expect(parseFieldText(fieldValueText('2026-12-24T18:30', true, fmt), true, fmt)).toBe('2026-12-24T18:30');
      expect(parseFieldText(fieldValueText('2026-01-05T00:07', true, fmt), true, fmt)).toBe('2026-01-05T00:07');
    }
  });

  it('turns a field value into the local moment it names', () => {
    expect(fieldValueToDate('2026-09-03')!.getDate()).toBe(3);
    expect(fieldValueToDate('2026-09-03T18:30')!.getHours()).toBe(18);
    expect(fieldValueToDate('nonsense')).toBeNull();
    expect(dateToFieldValue(new Date(2026, 8, 3, 7, 5), true)).toBe('2026-09-03T07:05');
  });

  it('follows the stored preference when no format is passed', () => {
    setDateFormatPref('ymd');
    expect(dateFormatPref.value).toBe('ymd');
    expect(fmtDate(EVENING)).toBe('2026-12-24');
    setDateFormatPref('nonsense');
    expect(fmtDate(EVENING)).toBe('24/12/2026'); // auto, in English
  });
});
