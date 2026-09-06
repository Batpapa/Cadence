import { describe, it, expect } from 'vitest';
import { settingIndexInScore, findSettingInScore } from './theSessionService';
import { encodeAbc } from './abcService';
import type { Card, FileEntry } from '../types';

// Reading a setting id back out of a card's own score is what lets the session
// summary star "the version you just played" without a network call. The whole
// mechanism rests on the `S:` line settingToAbcBlock writes, so these tests
// build blocks the way that function does — id in the URL fragment, nowhere else.

function block(x: number, tuneId: number, settingId: number, music = 'EBBA B2 EB|'): string {
  return [
    `X: ${x}`,
    'T: A Tune',
    'Z: Someone',
    `S: https://thesession.org/tunes/${tuneId}#setting${settingId}`,
    'R: reel',
    'M: 4/4',
    'L: 1/8',
    'K: Edor',
    music,
  ].join('\n');
}

function score(...blocks: string[]): FileEntry {
  return { name: 'A Tune.abc', mimeType: 'text/vnd.abc', data: encodeAbc(blocks.join('\n\n')) };
}

function card(attachments: Card['content']['attachments']): Card {
  return { id: 'c', guid: 'guid-c', name: 'A Tune', defaultImportance: 1, tags: [], type: 'tune', content: { notes: '', attachments } };
}

describe('settingIndexInScore', () => {
  it('finds the block a setting was written into', () => {
    const s = score(block(1, 7, 100), block(2, 7, 200), block(3, 7, 300));
    expect(settingIndexInScore(s, 100)).toBe(0);
    expect(settingIndexInScore(s, 200)).toBe(1);
    expect(settingIndexInScore(s, 300)).toBe(2);
  });

  it('answers null for a setting that is not in the file', () => {
    expect(settingIndexInScore(score(block(1, 7, 100)), 999)).toBeNull();
  });

  // The reason the match is anchored: "#setting3" is a prefix of "#setting31",
  // and a substring search would hand back the wrong version of the tune.
  it('does not let one id match a longer one that starts with it', () => {
    const s = score(block(1, 7, 31), block(2, 7, 3));
    expect(settingIndexInScore(s, 3)).toBe(1);
    expect(settingIndexInScore(s, 31)).toBe(0);
  });

  it('survives a file it cannot read rather than throwing', () => {
    expect(settingIndexInScore({ name: 'x.abc', mimeType: 'text/vnd.abc', data: '!!not base64!!' }, 1)).toBeNull();
  });
});

describe('findSettingInScore', () => {
  it('reports where the setting is and which version the card prefers', () => {
    const s = score(block(1, 7, 100), block(2, 7, 200));
    // The two differ: the viewer opens at blockIndex while the star stays on
    // preferredIndex. Equal means the card already prefers what was played.
    expect(findSettingInScore(card([{ type: 'file', ...s }]), 200))
      .toEqual({ attachmentIndex: 0, blockIndex: 1, preferredIndex: undefined });
    expect(findSettingInScore(card([{ type: 'file', ...s, preferredIndex: 1 }]), 200))
      .toEqual({ attachmentIndex: 0, blockIndex: 1, preferredIndex: 1 });
  });

  // Forwarded raw, NOT defaulted to 0. Every reader of the field treats absent
  // and 0 alike, but the star that offers to CLEAR a preference has to tell
  // "nothing stored" from "the first one was chosen" — there is nothing to
  // clear in the first case.
  it('forwards an absent preferred index as absent', () => {
    const s = score(block(1, 7, 100), block(2, 7, 200));
    expect(findSettingInScore(card([{ type: 'file', ...s }]), 100)?.preferredIndex).toBeUndefined();
    expect(findSettingInScore(card([{ type: 'file', ...s, preferredIndex: 0 }]), 100)?.preferredIndex).toBe(0);
  });

  it('answers null when there is nothing to star', () => {
    const s = score(block(1, 7, 100));
    expect(findSettingInScore(card([]), 100)).toBeNull();                                   // no attachment
    expect(findSettingInScore(card([{ type: 'card', id: 'x', guid: 'g', title: 'T' }]), 100)).toBeNull(); // not a file
    expect(findSettingInScore(card([{ type: 'file', name: 'notes.pdf', mimeType: 'application/pdf', data: '' }]), 100)).toBeNull();
    expect(findSettingInScore(card([{ type: 'file', ...s }]), 999)).toBeNull();              // setting not in it
  });

  // A PDF sitting before the score must not stop the search: the rule is "the
  // first ABC that carries it", not "the first attachment".
  it('skips non-ABC attachments and keeps looking', () => {
    const s = score(block(1, 7, 100), block(2, 7, 200));
    const c = card([
      { type: 'file', name: 'notes.pdf', mimeType: 'application/pdf', data: '' },
      { type: 'file', ...s },
    ]);
    expect(findSettingInScore(c, 200)).toEqual({ attachmentIndex: 1, blockIndex: 1, preferredIndex: undefined });
  });
});
