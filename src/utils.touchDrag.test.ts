// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { addTouchDragSupport } from './utils';

// The touch polyfill against the case that broke it in the field (2026-10-14):
// Chrome on Android starting its own drag of a `draggable` element on a long
// press, and cancelling the touch to do so. jsdom has neither DragEvent nor
// Touch nor elementFromPoint, so all three are stood in for.

class FakeDragEvent extends MouseEvent {}

function touch(type: string, el: Element, x = 10, y = 10, fingers = 1): void {
  const point = { clientX: x, clientY: y };
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    touches: type === 'touchend' || type === 'touchcancel' ? [] : Array(fingers).fill(point),
    changedTouches: [point],
  });
  el.dispatchEvent(e);
}

let source: HTMLElement;
let target: HTMLElement;
let seen: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('DragEvent', FakeDragEvent);
  source = document.createElement('div');
  target = document.createElement('div');
  document.body.append(source, target);
  document.elementFromPoint = () => target;
  source.draggable = true;
  addTouchDragSupport(source);
  seen = [];
  for (const type of ['dragstart', 'dragend']) source.addEventListener(type, () => seen.push(type));
  target.addEventListener('drop', () => seen.push('drop'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('addTouchDragSupport', () => {
  it('is not natively draggable while a finger is on it, and is again after', () => {
    touch('touchstart', source);
    expect(source.draggable).toBe(false);
    touch('touchend', source);
    expect(source.draggable).toBe(true);
  });

  it('keeps the text unselectable while draggable is off', () => {
    expect(source.hasAttribute('data-touch-drag')).toBe(true);
  });

  it('drops where the finger lifts', () => {
    touch('touchstart', source);
    vi.advanceTimersByTime(300);
    touch('touchmove', source, 10, 60);
    touch('touchend', source, 10, 60);
    expect(seen).toEqual(['dragstart', 'drop', 'dragend']);
  });

  it('drops nothing when the system takes the touch over', () => {
    touch('touchstart', source);
    vi.advanceTimersByTime(300);
    touch('touchcancel', source);
    expect(seen).toEqual(['dragstart', 'dragend']);
    expect(source.draggable).toBe(true);
  });

  it('never makes draggable what a caller had turned off', () => {
    source.draggable = false; // the attachment row, while its name is edited
    touch('touchstart', source);
    touch('touchend', source);
    expect(source.draggable).toBe(false);
  });
});
