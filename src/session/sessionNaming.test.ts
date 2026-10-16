import { describe, it, expect, afterEach } from 'vitest';
import { generatedSessionName, parseNameTemplate, nameTemplateSetting, launchNameTemplate, defaultNameTemplate } from './sessionNaming';
import { setDateFormatPref } from '../services/dateFormat';

// Local components: the names are written in local time, as in the app.
const DATE = new Date(2026, 9, 12, 18, 0).toISOString();

describe('the usual name', () => {
  afterEach(() => setDateFormatPref(undefined));

  it('says what was recorded, and when', () => {
    expect(generatedSessionName('live', DATE)).toBe('Recording of 12/10/2026 18:00'); // English auto: day first, 24 h
    expect(generatedSessionName('device', DATE)).toBe('Capture of 12/10/2026 18:00');
    expect(generatedSessionName('live', null)).toBe('Recording');
  });

  it('writes the date in the format of the day it is generated', () => {
    setDateFormatPref('ymd');
    expect(generatedSessionName('live', DATE)).toBe('Recording of 2026-10-12 18:00');
  });
});

describe('name template', () => {
  afterEach(() => setDateFormatPref(undefined));

  it('fills the fields and keeps the rest as written', () => {
    expect(generatedSessionName('live', DATE, '{aa}{mm}{dd} {time} Celticime 26'))
      .toBe('261012 18:00 Celticime 26');
    expect(generatedSessionName('live', DATE, '{aaaa}-{mm}-{dd}')).toBe('2026-10-12');
    expect(generatedSessionName('device', DATE, '{Type} {date}')).toBe('Capture 12/10/2026');
  });

  it('capitalises {Type} and not {type}', () => {
    expect(generatedSessionName('live', DATE, '{aa}{mm}{dd} {type}')).toBe('261012 recording');
    expect(generatedSessionName('device', DATE, '{Type}, {type}')).toBe('Capture, capture');
  });

  it('is the usual name with the usual template', () => {
    expect(generatedSessionName('device', DATE, defaultNameTemplate())).toBe(generatedSessionName('device', DATE));
    expect(defaultNameTemplate()).toBe('{Type} of {date} {time}');
  });

  it('writes the time as the date format writes it, PM included', () => {
    setDateFormatPref('mdy');
    expect(generatedSessionName('live', DATE, '{time}')).toMatch(/^06:00\sPM$/u);
    setDateFormatPref('dmy');
    expect(generatedSessionName('live', DATE, '{time}')).toBe('18:00');
  });

  it('reads a field whatever its spaces but in its exact case, and doubled braces as one', () => {
    expect(generatedSessionName('live', DATE, '{ aaaa } {{dd}}')).toBe('2026 {dd}');
    expect(parseNameTemplate('{Date} {AA}').unknown).toEqual(['Date', 'AA']);
  });

  it('keeps what is no field as text, and says so', () => {
    const parsed = parseNameTemplate('{heure} {date');
    expect(parsed.unknown).toEqual(['heure']);
    expect(parsed.unclosed).toBe(true);
    expect(generatedSessionName('live', DATE, '{heure} {date')).toBe('{heure} {date');
  });

  it('falls back to the usual name when there is nothing left or no date', () => {
    expect(generatedSessionName('live', DATE, '   ')).toBe('Recording of 12/10/2026 18:00');
    expect(generatedSessionName('live', null, '{aa}')).toBe('Recording');
  });

  it('reads the setting only when it holds something', () => {
    const user = (nameTemplate: unknown, nameTemplateNoFolder?: unknown) =>
      ({ modules: { 'tune-analyser': { sessions: {}, nameTemplate, nameTemplateNoFolder } } });
    expect(nameTemplateSetting(user('{aa}'))).toEqual({ template: '{aa}', noFolder: null });
    expect(nameTemplateSetting(user('{folder} {aa}', '{aa}'))).toEqual({ template: '{folder} {aa}', noFolder: '{aa}' });
    expect(nameTemplateSetting(user('{aa}', '  '))).toEqual({ template: '{aa}', noFolder: null });
    // The second alone is nothing: it only ever stands in for the first.
    expect(nameTemplateSetting(user('  ', '{aa}'))).toBeNull();
    expect(nameTemplateSetting(user(42))).toBeNull();
    expect(nameTemplateSetting({})).toBeNull();
  });
});

describe('{folder}', () => {
  const name = (template: string | null) => generatedSessionName('live', DATE, template);

  it('writes the folder the recording starts in', () => {
    const t = launchNameTemplate({ template: '{folder} - {aa}{mm}{dd}', noFolder: null }, 'Celticime 2026');
    expect(name(t)).toBe('Celticime 2026 - 261012');
  });

  it('uses the second template outside any folder', () => {
    const t = launchNameTemplate({ template: '{folder} - {aa}{mm}{dd}', noFolder: 'Session {aa}{mm}{dd}' }, null);
    expect(name(t)).toBe('Session 261012');
  });

  it('leaves the folder out when there is no second template', () => {
    const t = launchNameTemplate({ template: '{aa}{mm}{dd} {folder}', noFolder: null }, null);
    expect(name(t)).toBe('261012');
  });

  it('ignores the second template when the first has no {folder}', () => {
    const t = launchNameTemplate({ template: '{aa}{mm}{dd}', noFolder: 'Session' }, null);
    expect(name(t)).toBe('261012');
  });

  it('leaves {folder} empty in the second template, where it has no value', () => {
    const t = launchNameTemplate({ template: '{folder} {aa}', noFolder: '{folder}x{aa}' }, null);
    expect(name(t)).toBe('x26');
  });

  it('takes the folder name as text, braces and all', () => {
    const t = launchNameTemplate({ template: '{folder} {aa}', noFolder: null }, 'Le {date} {{x}');
    expect(name(t)).toBe('Le {date} {{x} 26');
  });

  it('keeps what is not a field as it was', () => {
    const t = launchNameTemplate({ template: '{folder} {heure} {aa', noFolder: null }, 'Ennis');
    expect(name(t)).toBe('Ennis {heure} {aa');
  });

  it('is the usual name without a template', () => {
    expect(name(launchNameTemplate(null, 'Ennis'))).toBe('Recording of 12/10/2026 18:00');
  });
});
