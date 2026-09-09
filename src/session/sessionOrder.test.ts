import { describe, it, expect } from 'vitest';
import { compareSessionsForLibrary } from './db';
import type { Analysis } from './model';

// The library's order is the whole answer to "which of these thirty recordings
// is the one I want" — the default name no longer carries a date, so the list's
// order and its date column are all there is to go on.

function session(name: string, date: string | null): Analysis {
  return {
    id: name, name, date, duration: 60, mimeType: 'audio/webm', source: 'live', annotations: [],
  };
}

const order = (list: Analysis[]) =>
  [...list].sort(compareSessionsForLibrary).map(s => s.name);

describe('library order', () => {
  it('puts the most recent dated session first', () => {
    const list = [
      session('older', '2026-09-05T20:00:00.000Z'),
      session('newest', '2026-09-07T09:00:00.000Z'),
      session('middle', '2026-09-06T21:30:00.000Z'),
    ];
    expect(order(list)).toEqual(['newest', 'middle', 'older']);
  });

  it('separates two sessions recorded on the same day by their time', () => {
    // The case the whole change exists for: a festival day produces several
    // recordings, and the date alone cannot tell them apart.
    const list = [
      session('afternoon', '2026-09-05T14:10:00.000Z'),
      session('night', '2026-09-05T23:45:00.000Z'),
      session('morning', '2026-09-05T09:00:00.000Z'),
    ];
    expect(order(list)).toEqual(['night', 'afternoon', 'morning']);
  });

  it('sorts undated sessions last, alphabetically', () => {
    const list = [
      session('zebra', null),
      session('dated', '2026-09-05T20:00:00.000Z'),
      session('apple', null),
    ];
    expect(order(list)).toEqual(['dated', 'apple', 'zebra']);
  });

  it('keeps undated last however the input happens to be ordered', () => {
    // Undated used to sort FIRST; this is the reversal, and it must not depend
    // on the order Object.values() happened to hand back.
    const undatedFirst = [session('import', null), session('rec', '2026-09-05T20:00:00.000Z')];
    const datedFirst = [session('rec', '2026-09-05T20:00:00.000Z'), session('import', null)];
    expect(order(undatedFirst)).toEqual(['rec', 'import']);
    expect(order(datedFirst)).toEqual(['rec', 'import']);
  });
});
