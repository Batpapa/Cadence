import { describe, it, expect } from 'vitest';
import { selectionIsHidden, toggleSpoiler, type SpoilerEdit } from './spoilerToggle';

/** Applies an edit, and shows the selection it leaves with [brackets]. */
function apply(text: string, edit: SpoilerEdit | null): string {
  if (!edit) return 'no edit';
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return out.slice(0, edit.selStart) + '[' + out.slice(edit.selStart, edit.selEnd) + ']' + out.slice(edit.selEnd);
}

/** Runs the toggle on `text` where the selection is written [like this]. */
function toggle(marked: string): string {
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  const text = marked.replace('[', '').replace(']', '');
  return apply(text, toggleSpoiler(text, start, end));
}

describe('hiding', () => {
  it('wraps the selection', () => {
    expect(toggle('The answer is [42].')).toBe('The answer is [||42||].');
  });

  it('leaves blanks at the edges outside the markers', () => {
    expect(toggle('Answer:[ 42 ]end')).toBe('Answer:[ ||42|| ]end');
  });

  it('hides each line of a selection over several lines', () => {
    expect(toggle('[one\ntwo\n\nthree]')).toBe('[||one||\n||two||\n\n||three||]');
  });

  it('does nothing for an empty selection or one of blanks only', () => {
    expect(toggleSpoiler('abc', 1, 1)).toBeNull();
    expect(toggle('a[   ]b')).toBe('no edit');
  });
});

describe('showing', () => {
  it('unwraps when the selection is the hidden text', () => {
    expect(toggle('The answer is ||[42]||.')).toBe('The answer is [42].');
  });

  it('unwraps when the selection includes the markers', () => {
    expect(toggle('The answer is [||42||].')).toBe('The answer is [42].');
  });

  it('unwraps a passage the selection only partly covers, and keeps the rest selected', () => {
    expect(toggle('Say [hi ||the|| ans]wer||')).toBe('Say [hi the ans]wer||');
    expect(toggle('a ||b[c|| d] e')).toBe('a [bc d] e');
  });

  it('unwraps every hidden passage the selection touches', () => {
    expect(toggle('[||a|| and ||b||]')).toBe('[a and b]');
  });

  it('round-trips', () => {
    const text = 'Q: capital?\nA: Paris';
    const hidden = toggleSpoiler(text, 15, 20)!;
    const once = text.slice(0, hidden.from) + hidden.insert + text.slice(hidden.to);
    expect(once).toBe('Q: capital?\nA: ||Paris||');
    const back = toggleSpoiler(once, hidden.selStart, hidden.selEnd)!;
    expect(once.slice(0, back.from) + back.insert + once.slice(back.to)).toBe(text);
  });
});

describe('which way the button goes', () => {
  it('reads a selection touching hidden text as hidden', () => {
    expect(selectionIsHidden('x ||secret|| y', 4, 6)).toBe(true);
    expect(selectionIsHidden('x ||secret|| y', 0, 3)).toBe(true); // reaches the first marker
  });

  it('reads anything else as not hidden', () => {
    expect(selectionIsHidden('x ||secret|| y', 12, 14)).toBe(false); // right after the closing marker
    expect(selectionIsHidden('no markers', 0, 5)).toBe(false);
    expect(selectionIsHidden('x ||secret|| y', 5, 5)).toBe(false); // nothing selected
  });
});
