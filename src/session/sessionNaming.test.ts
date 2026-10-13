import { describe, it, expect, afterEach } from 'vitest';
import { renameGeneratedNames, generatedSessionName, dateBesideName } from './sessionNaming';
import { fmtDateTime, setDateFormatPref } from '../services/dateFormat';
import type { Analysis } from './model';

// Local components: the names are written in local time, as in the app.
const DATE = new Date(2026, 9, 12, 18, 0).toISOString();

const analysis = (name: string, date: string | null = DATE, source: Analysis['source'] = 'live'): Analysis => ({
  id: name, name, date, duration: 60, mimeType: 'audio/webm', source, annotations: [],
});

describe('renameGeneratedNames', () => {
  afterEach(() => setDateFormatPref(undefined));

  it('rewrites a name generated in the browser convention', () => {
    const s = analysis(generatedSessionName('live', DATE));
    expect(renameGeneratedNames([s], 'auto', 'dmy')).toBe(1);
    expect(s.name).toBe('Recording of 12/10/2026 18:00');
  });

  it('recognises the other language and the device capture name', () => {
    const fr = analysis(`Enregistrement du ${fmtDateTime(DATE, {}, 'auto', 'fr-FR')}`);
    const capture = analysis(`Capture of ${fmtDateTime(DATE, {}, 'auto', 'en-US')}`, DATE, 'device');
    expect(renameGeneratedNames([fr, capture], 'auto', 'ymd')).toBe(2);
    expect(fr.name).toBe('Enregistrement du 2026-10-12 18:00');
    expect(capture.name).toBe('Capture of 2026-10-12 18:00');
  });

  it('moves between two explicit formats', () => {
    const s = analysis('Recording of 12/10/2026 18:00');
    renameGeneratedNames([s], 'dmy', 'mdy');
    expect(s.name).toMatch(/^Recording of 10\/12\/2026 06:00\sPM$/u);
  });

  it('never touches a name someone edited, even by a character', () => {
    const edited = analysis('Recording of 12/10/2026 18:00 — Ennis');
    const other = analysis('Session at the Crane');
    expect(renameGeneratedNames([edited, other], 'dmy', 'ymd')).toBe(0);
    expect(edited.name).toBe('Recording of 12/10/2026 18:00 — Ennis');
    expect(other.name).toBe('Session at the Crane');
  });

  it('leaves undated analyses and a name written in another format alone', () => {
    const undated = analysis('Recording', null);
    // Generated in ymd, but the change is said to come from dmy: not a match.
    const elsewhere = analysis('Recording of 2026-10-12 18:00');
    expect(renameGeneratedNames([undated, elsewhere], 'dmy', 'mdy')).toBe(0);
    expect(undated.name).toBe('Recording');
    expect(elsewhere.name).toBe('Recording of 2026-10-12 18:00');
  });

  it('does nothing when the format does not change', () => {
    const s = analysis('Recording of 12/10/2026 18:00');
    expect(renameGeneratedNames([s], 'dmy', 'dmy')).toBe(0);
  });

  it('keeps the date from being printed twice once renamed', () => {
    const s = analysis(generatedSessionName('live', DATE));
    renameGeneratedNames([s], 'auto', 'dmy');
    setDateFormatPref('dmy');
    expect(dateBesideName(s.name, s.date)).toBe('');
  });
});
