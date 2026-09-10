// @vitest-environment jsdom
// Not for the DOM — nothing here touches it — but because importing this
// component reaches the store, which reaches driveService, which reads
// localStorage at import time. Same reason as storeHistory.test.ts.
import { describe, it, expect } from 'vitest';
import { staffWidthFor, showsIncipit } from './incipit';

// The width arithmetic is the part that was wrong on a real phone, so it is
// the part that gets pinned here. Everything around it — the drawing, the
// cropping, the CSS cap — needs a browser and was verified there.

describe('staffWidthFor', () => {
  it('caps a wide row, so a two-bar reminder never stretches across a desktop', () => {
    expect(staffWidthFor(1200)).toBe(420);
    expect(staffWidthFor(424)).toBe(420);
  });

  it('follows a narrow row instead of overflowing it — the phone report', () => {
    // 380 was the measured card column on the phone that reported the cut.
    expect(staffWidthFor(380)).toBeLessThan(380);
    expect(staffWidthFor(228)).toBeLessThan(228);
  });

  it('leaves a little slack, because abcjs overshoots by a pixel or two', () => {
    expect(staffWidthFor(300)).toBeLessThanOrEqual(296);
  });

  it('stops shrinking at the floor: below it, scrolling beats squinting', () => {
    expect(staffWidthFor(40)).toBe(120);
    expect(staffWidthFor(1)).toBe(120);
  });

  it('falls back to the full width when nothing has been measured yet', () => {
    // A flex item that has not been laid out reports 0, and drawing at 0 would
    // produce nothing at all.
    expect(staffWidthFor(0)).toBe(420);
    expect(staffWidthFor(-5)).toBe(420);
  });

  it('never returns a width that would not fit the room it was given', () => {
    for (const avail of [130, 200, 250, 300, 350, 400, 419, 420, 500]) {
      expect(staffWidthFor(avail)).toBeLessThanOrEqual(avail);
    }
  });
});

describe('showsIncipit', () => {
  it('defaults to the card alone', () => {
    expect(showsIncipit({}, 'card')).toBe(true);
    expect(showsIncipit({}, 'study')).toBe(false);
  });

  it('treats study as a superset of card, not a third place', () => {
    expect(showsIncipit({ incipitDisplay: 'study' }, 'card')).toBe(true);
    expect(showsIncipit({ incipitDisplay: 'study' }, 'study')).toBe(true);
  });

  it('says no everywhere when it is off', () => {
    expect(showsIncipit({ incipitDisplay: 'none' }, 'card')).toBe(false);
    expect(showsIncipit({ incipitDisplay: 'none' }, 'study')).toBe(false);
  });
});
