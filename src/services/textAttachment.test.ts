import { describe, it, expect } from 'vitest';
import { detectTextFormat, suggestedTextName, textAttachment, TEXT_FORMATS } from './textAttachment';
import { decodeAbc, isAbcFile } from './abcService';
import type { FileEntry } from '../types';

const asEntry = (a: ReturnType<typeof textAttachment>): FileEntry => {
  if (a.type !== 'file') throw new Error('not a file');
  return a;
};

describe('what a pasted text is', () => {
  it('reads an ABC header, wherever in the paste it starts', () => {
    expect(detectTextFormat('X: 1\nT: The Silver Spear\nK: D\n')).toBe('abc');
    expect(detectTextFormat('Learnt from Bedou\n\nX:1\nT:A reel\nK:G')).toBe('abc');
  });

  it('calls everything else plain text', () => {
    expect(detectTextFormat('')).toBe('txt');
    expect(detectTextFormat('# Notes\n\nStart slowly.')).toBe('txt');
    // Not an X: line: the letter has to open the line and carry a number, the
    // same rule splitAbcTunes applies when it cuts a file into blocks.
    expect(detectTextFormat('the X: field is missing')).toBe('txt');
    expect(detectTextFormat('X: nothing')).toBe('txt');
  });
});

describe('the name a paste proposes', () => {
  it('is the ABC title, made safe for a filesystem', () => {
    expect(suggestedTextName('X:1\nT: Cooley\'s\nK:Edor', 'abc')).toBe("Cooley's");
    expect(suggestedTextName('X:1\nT: Cooley / The Wise Maid\nK:Edor', 'abc')).toBe('Cooley - The Wise Maid');
  });

  it('is empty when there is nothing to read it from', () => {
    expect(suggestedTextName('X:1\nK:D', 'abc')).toBe('');
    // A text file names nothing: only ABC carries a title of its own.
    expect(suggestedTextName('X:1\nT: A reel\nK:D', 'txt')).toBe('');
    expect(suggestedTextName('# A heading', 'md')).toBe('');
  });
});

describe('the attachment it builds', () => {
  it('carries the extension and mime type of its format', () => {
    for (const [format, { ext, mimeType }] of Object.entries(TEXT_FORMATS)) {
      const att = textAttachment('Notes', 'hello', format as keyof typeof TEXT_FORMATS);
      expect(att).toMatchObject({ type: 'file', name: `Notes${ext}`, mimeType });
    }
  });

  it('is recognised as a score by the viewer when it is one', () => {
    expect(isAbcFile(asEntry(textAttachment('A reel', 'X:1\nK:D', 'abc')))).toBe(true);
    expect(isAbcFile(asEntry(textAttachment('Notes', 'X:1\nK:D', 'txt')))).toBe(false);
  });

  it('normalises CRLF, which is what a paste on Windows brings', () => {
    const att = textAttachment('A reel', 'X:1\r\nT: A reel\r\nK:D', 'abc');
    expect(decodeAbc(asEntry(att))).toBe('X:1\nT: A reel\nK:D');
  });

  it('survives a non-ASCII paste and a long one', () => {
    const text = 'Réglé à l\'oreille — ça passe\n'.repeat(4000);
    expect(decodeAbc(asEntry(textAttachment('Notes', text, 'txt')))).toBe(text);
  });

  it('trims the name but leaves the text alone', () => {
    const att = textAttachment('  Notes  ', '  spaced  ', 'txt');
    expect(asEntry(att).name).toBe('Notes.txt');
    expect(decodeAbc(asEntry(att))).toBe('  spaced  ');
  });
});
