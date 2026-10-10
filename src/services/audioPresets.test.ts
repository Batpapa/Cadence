import { describe, it, expect } from 'vitest';
import {
  fitSettings, sameSettings, neutralSettings, suggestedPresetName, sanitizeAudioPresets,
  identityOf, locatePresetHolder,
} from './audioPresets';
import type { Attachment, FileAttachment } from '../types';

const preset = (over: Record<string, unknown> = {}) =>
  ({ id: 'p1', name: 'B part', start: 10, end: 20, tempo: 80, transpose: 0, pitch: 0, repeat: true, ...over });

describe('fitting a preset to the file', () => {
  it('leaves one that fits alone', () => {
    const s = { start: 10, end: 20, tempo: 80, transpose: -2, pitch: 15, repeat: false };
    expect(fitSettings(s, 60)).toEqual(s);
  });

  it('brings the end back inside a shorter file', () => {
    expect(fitSettings({ ...neutralSettings(60), start: 10, end: 90 }, 30)).toMatchObject({ start: 10, end: 30 });
  });

  it('falls back to the whole file when the region no longer fits at all', () => {
    expect(fitSettings({ ...neutralSettings(60), start: 40, end: 50 }, 30)).toMatchObject({ start: 0, end: 30 });
  });

  it('keeps the sliders inside their ranges', () => {
    expect(fitSettings({ ...neutralSettings(60), tempo: 500, transpose: -40, pitch: 101.4 }, 60))
      .toMatchObject({ tempo: 200, transpose: -12, pitch: 100 });
  });
});

describe('what counts as a change', () => {
  it('ignores a bound moved by less than a hundredth of a second', () => {
    const a = { ...neutralSettings(60), start: 10.0012 };
    expect(sameSettings(a, { ...a, start: 10.004 })).toBe(true);
    expect(sameSettings(a, { ...a, start: 10.02 })).toBe(false);
  });

  it('sees any slider or the loop', () => {
    const a = neutralSettings(60);
    expect(sameSettings(a, { ...a, tempo: 99 })).toBe(false);
    expect(sameSettings(a, { ...a, repeat: false })).toBe(false);
  });
});

it('suggests the region as a name', () => {
  expect(suggestedPresetName({ ...neutralSettings(60), start: 12.4, end: 75 })).toBe('0:12 → 1:15');
});

describe('presets from an imported file', () => {
  it('keeps good ones and fills what is missing', () => {
    const att: Record<string, unknown> = { audioPresets: [{ id: 'a', start: 1, end: 5 }], defaultAudioPreset: 'a' };
    sanitizeAudioPresets(att);
    expect(att['audioPresets']).toEqual([{ id: 'a', name: '0:01 → 0:05', start: 1, end: 5, tempo: 100, transpose: 0, pitch: 0, repeat: true }]);
    expect(att['defaultAudioPreset']).toBe('a');
  });

  it('drops what cannot be a preset, duplicates, and a default naming none', () => {
    const att: Record<string, unknown> = {
      audioPresets: [preset(), preset({ name: 'again' }), { id: 'x' }, 'nonsense', preset({ id: 'p2', end: 'soon' })],
      defaultAudioPreset: 'gone',
    };
    sanitizeAudioPresets(att);
    expect((att['audioPresets'] as { name: string }[]).map(p => p.name)).toEqual(['B part']);
    expect('defaultAudioPreset' in att).toBe(false);
  });

  it('removes the field when nothing usable is left', () => {
    const att: Record<string, unknown> = { audioPresets: 'oops', defaultAudioPreset: 'p1' };
    sanitizeAudioPresets(att);
    expect('audioPresets' in att).toBe(false);
    expect('defaultAudioPreset' in att).toBe(false);
  });

  it('leaves an attachment without presets untouched', () => {
    const att: Record<string, unknown> = { name: 'x.mp3' };
    sanitizeAudioPresets(att);
    expect(att).toEqual({ name: 'x.mp3' });
  });
});

describe('finding the attachment a save belongs to', () => {
  const audio = (name: string, data: string, extra: Partial<FileAttachment> = {}): FileAttachment =>
    ({ type: 'file', name, data, mimeType: 'audio/mpeg', ...extra });

  it('at its place', () => {
    const a = audio('a.mp3', 'AAAA');
    expect(locatePresetHolder([a], 0, identityOf(a))).toBe(a);
  });

  it('where it moved to, renamed or not', () => {
    const a = audio('a.mp3', 'AAAA');
    const id = identityOf(a);
    const moved: Attachment[] = [audio('b.mp3', 'BB'), { ...a, name: 'renamed.mp3' }];
    expect(locatePresetHolder(moved, 0, id)).toBe(moved[1]);
  });

  it('by its external id when its bytes are elsewhere', () => {
    const a = audio('a.mp3', '', { external: { id: 'ext-1', bytes: 9 } });
    const other = audio('b.mp3', '', { external: { id: 'ext-2', bytes: 9 } });
    expect(locatePresetHolder([other, a], 0, identityOf(a))).toBe(a);
  });

  it('nowhere, once it is gone', () => {
    const a = audio('a.mp3', 'AAAA');
    expect(locatePresetHolder([audio('b.mp3', 'BB')], 0, identityOf(a))).toBeNull();
  });

  it('a link to an audio file by its id, wherever it moved and whatever its URL became', () => {
    const link: Attachment = { type: 'embed', id: 'l1', url: 'https://example.org/a.mp3' };
    const other: Attachment = { type: 'embed', id: 'l2', url: 'https://example.org/a.mp3' };
    const edited: Attachment = { ...link, url: 'https://example.org/b.mp3' };
    expect(locatePresetHolder([other, audio('a.mp3', 'AAAA'), edited], 0, { embedId: 'l1' })).toBe(edited);
    expect(locatePresetHolder([other], 0, { embedId: 'l1' })).toBeNull();
  });

  it('never a file for a link, nor a link for a file', () => {
    const a = audio('a.mp3', 'AAAA');
    expect(locatePresetHolder([a], 0, { embedId: 'l1' })).toBeNull();
    expect(locatePresetHolder([{ type: 'embed', id: 'l1', url: 'x' }], 0, identityOf(a))).toBeNull();
  });
});
