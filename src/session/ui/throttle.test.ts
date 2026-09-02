import { describe, it, expect, vi } from 'vitest';
import { createThrottle } from './throttle';

/** Fake clock: `now` is read by the throttle, and vitest's timers drive the
 *  trailing setTimeout — both have to advance together, hence the helper. */
function harness(intervalMs = 250) {
  vi.useFakeTimers();
  let clock = 1000;
  const calls: number[] = [];
  const th = createThrottle<[number]>(v => calls.push(v), intervalMs, () => clock);
  const advance = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); };
  return { calls, th, advance, done: () => vi.useRealTimers() };
}

describe('createThrottle', () => {
  it('fires the first call immediately — a burst is never delayed at its start', () => {
    const h = harness();
    h.th.call(1);
    expect(h.calls).toEqual([1]);
    h.done();
  });

  it('drops intermediate values but ALWAYS delivers the last one', () => {
    const h = harness(250);
    h.th.call(1);            // leading edge, immediate
    h.advance(10); h.th.call(2);
    h.advance(10); h.th.call(3);
    h.advance(10); h.th.call(4);
    expect(h.calls).toEqual([1]);   // 2 and 3 coalesced away
    h.advance(300);
    // The freshest value reaches the callback — this is the property the UI
    // depends on: the screen can never be stranded on an intermediate state.
    expect(h.calls).toEqual([1, 4]);
    h.done();
  });

  it('holds the promised rate under a sustained flood', () => {
    const h = harness(250);
    // 200 calls spread over 2s of fake time — 4fps must let ~8 through, not 200.
    for (let i = 0; i < 200; i++) { h.th.call(i); h.advance(10); }
    h.advance(500);
    expect(h.calls.length).toBeLessThanOrEqual(10);
    expect(h.calls.length).toBeGreaterThanOrEqual(7);
    expect(h.calls[0]).toBe(0);              // leading edge
    expect(h.calls[h.calls.length - 1]).toBe(199); // last value always lands
    h.done();
  });

  it('a call after a long idle goes straight through, no trailing delay', () => {
    const h = harness(250);
    h.th.call(1);
    h.advance(5000);
    h.th.call(2);
    expect(h.calls).toEqual([1, 2]);
    h.done();
  });

  it('cancel() drops the pending trailing call (unmount path)', () => {
    const h = harness(250);
    h.th.call(1);
    h.advance(10); h.th.call(2);
    h.th.cancel();
    h.advance(1000);
    expect(h.calls).toEqual([1]);
    h.done();
  });

  it('cancel() is idempotent and leaves the throttle usable afterwards', () => {
    const h = harness(250);
    h.th.call(1);
    h.th.cancel();
    h.th.cancel();
    h.advance(1000);
    h.th.call(2);
    expect(h.calls).toEqual([1, 2]);
    h.done();
  });
});
