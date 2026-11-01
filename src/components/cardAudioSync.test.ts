import { describe, it, expect } from 'vitest';
import type { Attachment } from '../types';
import { cardRecordings, cardAudioSync } from './cardAudioSync';

const file = (name: string, mimeType: string): Attachment => ({ type: 'file', name, mimeType, data: '' } as Attachment);
const link = (url: string, mode: 'embed' | 'link' = 'embed'): Attachment => ({ type: 'embed', id: url, url, mode } as Attachment);

describe('cardRecordings', () => {
  it('offers attached audio and video, not MIDI or AVI', () => {
    const names = cardRecordings([
      file('a.mp3', 'audio/mpeg'), file('b.mp4', 'video/mp4'), file('c.mid', 'audio/midi'),
      file('d.avi', 'video/x-msvideo'), file('e.abc', 'text/vnd.abc'), file('f.pdf', 'application/pdf'),
    ]).map(r => (r.kind === 'file' ? r.att.name : ''));
    expect(names).toEqual(['a.mp3', 'b.mp4']);
  });

  it('offers a link to a file read in the app, audio or of no telling extension', () => {
    const urls = cardRecordings([
      link('https://host/tune.mp3'), link('https://host/set.m4a?x=1'), link('https://host/take.mp4'),
      link('https://host/play?id=12'),
      link('https://host/score.pdf'), link('https://host/tune.abc'), link('https://host/tune.mid'),
      link('https://www.youtube.com/watch?v=abc'), link('https://host/tune.mp3', 'link'),
    ]).map(r => (r.kind === 'link' ? r.entry.url : ''));
    expect(urls).toEqual(['https://host/tune.mp3', 'https://host/set.m4a?x=1', 'https://host/take.mp4', 'https://host/play?id=12']);
  });

  it('keeps the card order, files and links mixed', () => {
    const kinds = cardRecordings([link('https://host/a.mp3'), file('b.mp3', 'audio/mpeg')]).map(r => r.kind);
    expect(kinds).toEqual(['link', 'file']);
  });

  it('offers no audio sync without a recording', () => {
    expect(cardAudioSync([file('e.abc', 'text/vnd.abc'), link('https://host/tune.mp3', 'link')])).toBeUndefined();
    expect(cardAudioSync([link('https://host/tune.mp3')])).toBeDefined();
  });
});
