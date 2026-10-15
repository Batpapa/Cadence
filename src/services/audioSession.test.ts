import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Android app's audio focus: who holds it, who gets paused, and never
// during a live. The native side is mocked — what is tested is the page's
// bookkeeping, which decides which player a loss of focus stops.

// Shared with the mock factories, which vitest hoists above everything else.
const { requests, abandons, env } = vi.hoisted(() => ({
  requests: [] as Array<() => void>,
  abandons: { count: 0 },
  env: { native: true },
}));

vi.mock('../native/platform', () => ({ isNative: () => env.native }));
vi.mock('../native/audioFocus', () => ({
  requestAudioFocus: (onLost: () => void) => { requests.push(onLost); return Promise.resolve(); },
  abandonAudioFocus: () => { abandons.count++; return Promise.resolve(); },
}));

const flush = () => new Promise(r => setTimeout(r, 0));

describe('audio focus (Android app)', () => {
  beforeEach(async () => {
    vi.resetModules();
    env.native = true;
    requests.length = 0;
    abandons.count = 0;
  });

  it('pauses the player that claimed it when the focus is lost', async () => {
    const { claimAudioFocus } = await import('./audioSession');
    const pause = vi.fn();
    claimAudioFocus(pause);
    await flush();
    expect(requests).toHaveLength(1);
    requests[0]!();
    expect(pause).toHaveBeenCalledOnce();
    // Already handed back: a second loss pauses nobody.
    requests[0]!();
    expect(pause).toHaveBeenCalledOnce();
  });

  it('pauses only the latest player, and ignores a release by one that no longer holds it', async () => {
    const { claimAudioFocus, releaseAudioFocus } = await import('./audioSession');
    const first = vi.fn();
    const second = vi.fn();
    claimAudioFocus(first);
    claimAudioFocus(second);
    releaseAudioFocus(first);
    await flush();
    expect(abandons.count).toBe(0);
    requests.at(-1)!();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('gives the focus back when the holder stops', async () => {
    const { claimAudioFocus, releaseAudioFocus } = await import('./audioSession');
    const pause = vi.fn();
    claimAudioFocus(pause);
    releaseAudioFocus(pause);
    await flush();
    expect(abandons.count).toBe(1);
    requests[0]!();
    expect(pause).not.toHaveBeenCalled();
  });

  it('never claims it during a capture (a live may be recording that very music)', async () => {
    const { claimAudioFocus, beginCaptureSession, endCaptureSession } = await import('./audioSession');
    beginCaptureSession();
    claimAudioFocus(vi.fn());
    await flush();
    expect(requests).toHaveLength(0);
    endCaptureSession();
    claimAudioFocus(vi.fn());
    await flush();
    expect(requests).toHaveLength(1);
  });

  it('does nothing in a browser', async () => {
    env.native = false;
    const { claimAudioFocus } = await import('./audioSession');
    claimAudioFocus(vi.fn());
    await flush();
    expect(requests).toHaveLength(0);
  });
});
