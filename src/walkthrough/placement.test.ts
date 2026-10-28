import { describe, it, expect } from 'vitest';
import { bubbleTop, type Rect } from './placement';

// A 390 × 800 phone; the bubble is 300 × 160.
const view = { width: 390, height: 800, insetTop: 0, insetBottom: 0 };
const rect = (top: number, bottom: number, left = 0, right = 390): Rect => ({ top, bottom, left, right });
/** Where driver.js puts it when no side has room: bottom, 10 px up. */
const fallback = rect(630, 790, 45, 345);

describe('bubbleTop', () => {
  it('leaves a bubble that covers nothing where driver.js put it', () => {
    expect(bubbleTop(rect(400, 560, 45, 345), [rect(100, 140)], view)).toBeNull();
  });

  it('moves it off a dialog button at the bottom, staying as close as it can', () => {
    // The « Créer » row of a dialog filling the screen: just above it.
    expect(bubbleTop(fallback, [rect(740, 780)], view)).toBe(570);
  });

  it('finds the free band between a field at the top and buttons at the bottom', () => {
    const keep = [rect(20, 200), rect(720, 780)];
    const top = bubbleTop(fallback, keep, view)!;
    expect(top).toBeGreaterThanOrEqual(210);
    expect(top + 160).toBeLessThanOrEqual(710);
  });

  it('keeps clear of the status bar and the gesture bar', () => {
    // Everything from 210 down is to stay in reach: only the top is left.
    expect(bubbleTop(fallback, [rect(210, 780)], { ...view, insetTop: 40, insetBottom: 24 })).toBe(50);
  });

  it('covers the least when nothing is clear', () => {
    // Controls everywhere but a sliver: the bubble goes where it hides least.
    const keep = [rect(0, 380), rect(420, 800)];
    const top = bubbleTop(fallback, keep, view)!;
    expect(top).toBeGreaterThan(220);
    expect(top).toBeLessThan(420);
  });

  it('gives up rather than guess when the bubble is taller than the screen', () => {
    expect(bubbleTop(rect(0, 900, 45, 345), [rect(100, 140)], view)).toBeNull();
  });
});
