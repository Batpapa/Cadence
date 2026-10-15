import { describe, it, expect } from 'vitest';
import { playableSource, bodyIndex, sourceIndex, playPlan, noteRanges, resumeInside, passOf, eventAt, notesOf, startNoteAt, type TimingEvent } from './abcTextPlayback';
import { injectDefaultTempo, stripForRender } from './abcService';

const BODY = [
  'T:The Kesh',
  'S:https://thesession.org/tunes/55',
  'R:jig',
  'M:6/8',
  'K:Gmaj',
  '|:GAG GAB|ABA ABd:|',
].join('\n');

/** What the viewer hands the stave for the same text. */
const staveSource = (xLine: string, body: string) =>
  injectDefaultTempo(stripForRender((xLine ? `${xLine}\n` : '') + body.split('\n').filter(l => !/^X:/.test(l)).join('\n')));

describe('the source abcjs reads', () => {
  it('is exactly what the stave is given', () => {
    expect(playableSource('X: 1', BODY).source).toBe(staveSource('X: 1', BODY));
    expect(playableSource('', BODY).source).toBe(staveSource('', BODY));
    const withQ = BODY.replace('K:Gmaj', 'Q:3/8=100\nK:Gmaj');
    expect(playableSource('X: 1', withQ).source).toBe(staveSource('X: 1', withQ));
  });

  it('drops a pasted X: line, as the viewer does', () => {
    expect(playableSource('X: 1', `X: 7\n${BODY}`).source).toBe(staveSource('X: 1', BODY));
  });

  it('maps every note of the music back to the box, across the added Q:', () => {
    const ps = playableSource('X: 1', BODY);
    expect(ps.source).toContain('Q: 3/8=120');
    const music = '|:GAG GAB|ABA ABd:|';
    const inSource = ps.source.indexOf(music);
    const inBody = BODY.indexOf(music);
    for (let i = 0; i < music.length; i++) expect(bodyIndex(ps, inSource + i)).toBe(inBody + i);
    expect(sourceIndex(ps, inBody + 3)).toBe(inSource + 3);
  });

  it('maps nothing the box does not hold', () => {
    const ps = playableSource('X: 1', BODY);
    expect(bodyIndex(ps, 1)).toBeNull(); // in "X: 1"
    expect(bodyIndex(ps, ps.source.indexOf('Q: 3/8') + 2)).toBeNull();
  });

  it('moves a position in a dropped line on to the next line read', () => {
    const ps = playableSource('X: 1', BODY);
    const inS = BODY.indexOf('thesession');
    expect(sourceIndex(ps, inS)).toBe(ps.source.indexOf('R:jig'));
  });
});

// Two bars repeated: A B C D, then A B C D again.
const ev = (ms: number, start: number): TimingEvent =>
  ({ type: 'event', milliseconds: ms, startCharArray: [start], endCharArray: [start + 1] });
const EVENTS: TimingEvent[] = [
  ev(0, 10), ev(100, 11), ev(200, 12), ev(300, 13),
  ev(400, 10), ev(500, 11), ev(600, 12), ev(700, 13),
  { type: 'end', milliseconds: 800 },
];

describe('what is played', () => {
  it('from the caret: the note it is in or before, first time round', () => {
    expect(playPlan(EVENTS, 12, null)?.start.milliseconds).toBe(200);
    expect(playPlan(EVENTS, 11.5 as number, null)?.start.milliseconds).toBe(100); // inside B
    expect(playPlan(EVENTS, 0, null)?.start.milliseconds).toBe(0); // in the header
    expect(playPlan(EVENTS, 12, null)?.inside).toBeNull();
  });

  it('past the last note: from the start', () => {
    expect(playPlan(EVENTS, 50, null)?.start.milliseconds).toBe(0);
  });

  it('a selection: from its first note, until the music leaves it', () => {
    const plan = playPlan(EVENTS, 11, 13)!;
    expect(plan.start.milliseconds).toBe(100);
    expect(plan.inside!(EVENTS[2]!)).toBe(true);
    expect(plan.inside!(EVENTS[3]!)).toBe(false); // D: stop there
  });

  it('a selection holding no note plays nothing', () => {
    expect(playPlan(EVENTS, 30, 40)).toBeNull();
  });

  it('lights the note in the box, not in what abcjs read', () => {
    const ps = playableSource('X: 1', BODY);
    const g = ps.source.indexOf('|:G') + 2;
    expect(noteRanges(ps, { type: 'event', milliseconds: 0, startCharArray: [g], endCharArray: [g + 1] }))
      .toEqual([[BODY.indexOf('|:G') + 2, BODY.indexOf('|:G') + 3]]);
  });
});

// "|:A B:|C D|" — A at 2, B at 4, C at 7, D at 9; the repeat played twice.
const R: TimingEvent[] = [ev(0, 2), ev(100, 4), ev(200, 2), ev(300, 4), ev(400, 7), ev(500, 9), { type: 'end', milliseconds: 600 }];

describe('a selection and the repeats', () => {
  it('across a :| goes on past the sign, the second time round', () => {
    const plan = playPlan(R, 4, 8)!;
    expect(plan.start.milliseconds).toBe(100); // B
    expect(plan.inside!(R[2]!)).toBe(false); // back to A: left it
    expect(resumeInside(R, 200, 4, 4, 8)?.milliseconds).toBe(400); // C, skipping B again
    expect(resumeInside(R, 500, 7, 4, 8)).toBeNull(); // D: the end
  });

  it('a whole |: … :| selected goes round twice, then ends', () => {
    const plan = playPlan(R, 0, 7)!;
    expect([R[1], R[2], R[3]].every(e => plan.inside!(e!))).toBe(true);
    expect(resumeInside(R, 400, 4, 0, 7)).toBeNull();
  });

  it('inside a repeat: once', () => {
    expect(resumeInside(R, 100, 2, 2, 3)).toBeNull();
  });
});

describe('the same place after a rebuild', () => {
  it('finds the note on the same pass', () => {
    expect(passOf(R, R[3]!)).toBe(1);
    expect(eventAt(R, 4, 1)?.milliseconds).toBe(300);
    expect(eventAt(R, 4, 5)?.milliseconds).toBe(300); // fewer passes now: the last
    expect(eventAt(R, 99, 0)).toBeNull();
  });
});

describe('where play will start, from the parse', () => {
  const tune = { lines: [
    { staff: [{ voices: [[
      { el_type: 'bar', startChar: 0, endChar: 2 },
      { el_type: 'note', startChar: 2, endChar: 4 },
      { el_type: 'note', startChar: 5, endChar: 6 },
    ]] }] },
    { staff: [{ voices: [[{ el_type: 'note', startChar: 9, endChar: 10 }]] }] },
    { subtitle: 'no staff here' },
  ] };

  it('reads the notes, in text order, bars left out', () => {
    expect(notesOf(tune)).toEqual([{ start: 2, end: 4 }, { start: 5, end: 6 }, { start: 9, end: 10 }]);
    expect(notesOf(null)).toEqual([]);
  });

  it('starts as playPlan does', () => {
    const notes = notesOf(tune);
    expect(startNoteAt(notes, 3, null)).toEqual({ start: 2, end: 4 }); // inside the first
    expect(startNoteAt(notes, 4, null)).toEqual({ start: 5, end: 6 }); // right after it
    expect(startNoteAt(notes, 50, null)).toEqual({ start: 2, end: 4 }); // past the end
    expect(startNoteAt(notes, 6, 10)).toEqual({ start: 9, end: 10 }); // a selection
    expect(startNoteAt(notes, 6, 8)).toBeNull(); // a selection with no note
  });
});
