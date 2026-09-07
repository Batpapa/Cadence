import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDeviceAudio, NoCapturedAudioError, DisplayCaptureUnsupportedError } from './capture';

// ── Tab / screen audio acquisition ────────────────────────────────────────────
// getDisplayMedia itself is browser-only, so what is exercised here is the
// contract around it — the part that is ours and that a browser check would
// never cover exhaustively:
//
//  - video is REQUESTED (the spec rejects `video: false` with a TypeError) but
//    DROPPED immediately, because Cadence has no use for a single frame;
//  - a stream with no audio track is a first-class outcome, not a crash: the
//    user forgot the "share audio" checkbox, or the browser is Firefox/Safari,
//    which ignore the audio request entirely and report nothing;
//  - nothing is ever left running behind a rejection.

class FakeTrack {
  stopped = false;
  constructor(readonly kind: 'audio' | 'video') {}
  stop(): void { this.stopped = true; }
  addEventListener(): void {}
  getSettings(): Record<string, never> { return {}; }
}

class FakeStream {
  removed: FakeTrack[] = [];
  constructor(private tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] { return this.tracks; }
  getAudioTracks(): FakeTrack[] { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks(): FakeTrack[] { return this.tracks.filter(t => t.kind === 'video'); }
  removeTrack(t: FakeTrack): void {
    this.removed.push(t);
    this.tracks = this.tracks.filter(x => x !== t);
  }
}

/** Installs a fake navigator.mediaDevices and returns the options array that
 *  every call appends to — recorded by hand rather than through vi.fn, whose
 *  inferred call signature would carry no arguments to read back. */
function stubDisplayMedia(impl: () => Promise<unknown>): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  const getDisplayMedia = (opts: Record<string, unknown>) => { calls.push(opts); return impl(); };
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  return calls;
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('openDeviceAudio', () => {
  it('rejects with a typed error when the browser has no getDisplayMedia (iOS, Android)', async () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    await expect(openDeviceAudio()).rejects.toBeInstanceOf(DisplayCaptureUnsupportedError);
  });

  it('never requests `video: false` — the spec rejects that with a TypeError', async () => {
    const calls = stubDisplayMedia(async () => new FakeStream([new FakeTrack('audio')]));
    await openDeviceAudio();
    expect(calls[0]!.video).toBeTruthy();
    expect(calls[0]!.video).not.toBe(false);
  });

  it('asks for music-grade audio: no echo cancellation, no AGC, no noise suppression', async () => {
    const calls = stubDisplayMedia(async () => new FakeStream([new FakeTrack('audio')]));
    await openDeviceAudio();
    const audio = calls[0]!.audio as Record<string, unknown>;
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
  });

  it('leaves the captured tab audible — suppressLocalAudioPlayback stays off', async () => {
    const calls = stubDisplayMedia(async () => new FakeStream([new FakeTrack('audio')]));
    await openDeviceAudio();
    const audio = calls[0]!.audio as Record<string, unknown>;
    expect(audio.suppressLocalAudioPlayback).toBe(false);
  });

  it('offers whole screens with system audio, and never Cadence itself', async () => {
    const calls = stubDisplayMedia(async () => new FakeStream([new FakeTrack('audio')]));
    await openDeviceAudio();
    expect(calls[0]!.systemAudio).toBe('include');
    expect(calls[0]!.monitorTypeSurfaces).toBe('include');
    expect(calls[0]!.selfBrowserSurface).toBe('exclude');
  });

  it('stops and removes the video track, keeping the audio one', async () => {
    const audio = new FakeTrack('audio');
    const video = new FakeTrack('video');
    stubDisplayMedia(async () => new FakeStream([video, audio]));

    const stream = (await openDeviceAudio()) as unknown as FakeStream;

    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(false);
    expect(stream.getVideoTracks()).toHaveLength(0);
    expect(stream.getAudioTracks()).toEqual([audio]);
  });

  it('rejects with NoCapturedAudioError when the user did not share audio', async () => {
    stubDisplayMedia(async () => new FakeStream([new FakeTrack('video')]));
    await expect(openDeviceAudio()).rejects.toBeInstanceOf(NoCapturedAudioError);
  });

  it('leaves nothing capturing when it rejects for lack of audio', async () => {
    const video = new FakeTrack('video');
    stubDisplayMedia(async () => new FakeStream([video]));
    await expect(openDeviceAudio()).rejects.toThrow();
    expect(video.stopped).toBe(true);
  });

  it('propagates a dismissed picker untouched, for the caller to read as a cancel', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    stubDisplayMedia(() => Promise.reject(denied));
    await expect(openDeviceAudio()).rejects.toBe(denied);
  });
});
