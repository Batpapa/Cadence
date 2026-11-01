// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Detection, DetectionAlternate } from '../session/model';
import { DetectionTracker } from '../session/detectionState';
import { RunStore, trackerOf, type SavedRun } from './runStore';

const KESH: DetectionAlternate = { tuneId: '1', settingId: '1', displayName: 'the kesh', dance: 'jig', meter: '6/8', meanScore: .8 };
const MORRISON: DetectionAlternate = { tuneId: '99', settingId: '99', displayName: 'morrison’s', dance: 'jig', meter: '6/8', meanScore: .4 };

function det(id: string, over: Partial<Detection> = {}): Detection {
  return {
    id, tuneId: KESH.tuneId, settingId: KESH.settingId, displayName: KESH.displayName, dance: KESH.dance, meter: KESH.meter,
    start: 10, end: 60, confidence: .8, bucket: 'high', meanScore: KESH.meanScore,
    evidence: [], alternates: [MORRISON], viterbiPick: KESH,
    userConfirmed: false, liked: false, finalized: true,
    ...over,
  };
}

/** What TuneFinder.saved() writes for one run. */
function savedOf(t: DetectionTracker, heardS: number): SavedRun {
  return { kind: 'mic', label: '', startedAt: 1000, heardS, decoder: t.decoderDetections(), confirmations: t.snapshot() };
}

describe('trackerOf — the list put back', () => {
  it('keeps a confirmation, and closes the tune still open where the decoder had got to', () => {
    const t = new DetectionTracker();
    t.apply([
      { type: 'close', detection: det('a') },
      { type: 'open', detection: det('b', { start: 70, end: null, finalized: false }) },
    ]);
    t.confirm('a', MORRISON);
    // Through JSON, as localStorage has it.
    const back = trackerOf(JSON.parse(JSON.stringify(savedOf(t, 95))) as SavedRun);
    const list = back.list();
    expect(list.map(d => d.tuneId)).toEqual(['99', '1']);
    expect(list[0]!.userConfirmed).toBe(true);
    expect(list[1]).toMatchObject({ start: 70, end: 95, finalized: true });
  });

  it('never ends an open tune before it started', () => {
    const t = new DetectionTracker();
    t.apply([{ type: 'open', detection: det('a', { start: 70, end: null, finalized: false }) }]);
    expect(trackerOf(savedOf(t, 0)).list()[0]!.end).toBe(70);
  });
});

// ── The store ──

/** Web Locks as a set of held names: a page's lock is held until `die`. */
function fakeLocks() {
  const held = new Set<string>();
  return {
    held,
    api: {
      request: (name: string, cb: () => Promise<void>) => { held.add(name); return cb(); },
      query: async () => ({ held: [...held].map(name => ({ name })) }),
    },
  };
}

const run = (startedAt: number): SavedRun => ({ kind: 'mic', label: '', startedAt, heardS: 30, decoder: [det(`d${startedAt}`)], confirmations: [] });
const keys = () => Object.keys(localStorage).filter(k => k.startsWith('cadence_finder_runs:'));

describe('RunStore', () => {
  let locks: ReturnType<typeof fakeLocks>;
  beforeEach(() => {
    localStorage.clear();
    locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { value: locks.api, configurable: true });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('saves a moment after a change, and once however many changes', () => {
    const store = new RunStore();
    const collect = vi.fn(() => [run(1)]);
    store.schedule(collect);
    store.schedule(collect);
    expect(keys()).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(keys()).toHaveLength(1);
  });

  it('takes the list away when the page is left, and keeps nothing after', () => {
    const store = new RunStore();
    store.schedule(() => [run(1)]);
    vi.advanceTimersByTime(1000);
    store.leave();
    store.schedule(() => [run(1)]);
    vi.advanceTimersByTime(1000);
    expect(keys()).toHaveLength(0);
    store.back();
    expect(keys()).toHaveLength(1);
  });

  /** A page that went to a tune's page in its own tab, its lock gone with it. */
  function leftByLink(startedAt: number): void {
    const page = new RunStore();
    page.schedule(() => [run(startedAt)]);
    page.leavingByLink();
    page.leave();
    locks.held.clear();
  }

  it('keeps the list of a page left by a tune link, for the back button only', async () => {
    leftByLink(4);
    expect(keys()).toHaveLength(1);
    vi.useRealTimers();
    expect((await new RunStore().takeOrphans(() => true, true)).map(r => r.startedAt)).toEqual([4]);
    expect(keys()).toHaveLength(0);
  });

  it('drops it on any other visit', async () => {
    leftByLink(4);
    vi.useRealTimers();
    expect(await new RunStore().takeOrphans(() => true, false)).toEqual([]);
    expect(keys()).toHaveLength(0);
  });

  it('a page back from the cache is in memory again, not left by a link', async () => {
    const page = new RunStore();
    page.schedule(() => [run(5)]);
    page.leavingByLink();
    page.leave();
    page.back();
    page.leave(); // then left normally
    expect(keys()).toHaveLength(0);
  });

  it('hands on the list of a page that died, not that of a page still open', async () => {
    const dead = new RunStore();
    dead.schedule(() => [run(2)]);
    const alive = new RunStore();
    alive.schedule(() => [run(3)]);
    vi.advanceTimersByTime(1000);
    // The dead page's lock went with its process.
    const deadLock = [...locks.held][0]!;
    locks.held.delete(deadLock);

    const next = new RunStore();
    vi.useRealTimers();
    const taken = await next.takeOrphans(() => true);
    expect(taken.map(r => r.startedAt)).toEqual([2]);
    expect(keys()).toHaveLength(1); // the live page's, untouched
  });

  it('leaves it for later when the page has already started something', async () => {
    const dead = new RunStore();
    dead.schedule(() => [run(2)]);
    vi.advanceTimersByTime(1000);
    locks.held.clear();
    const next = new RunStore();
    vi.useRealTimers();
    expect(await next.takeOrphans(() => false)).toEqual([]);
    expect(keys()).toHaveLength(1);
  });
});
