import { describe, it, expect, vi } from 'vitest';

// The recorder's stop leaves the chunks where they are (2026-11-15): until the
// caller has written the file it returns, they are the only copy of the
// recording. An iPhone lost the sound of evenings of several hours to a stop
// that cleared them first and then failed to save.

const { store, cleared } = vi.hoisted(() => ({
  store: [] as Array<{ recordingId: string; seq: number; blob: Blob }>,
  cleared: { count: 0 },
}));

vi.mock('../db', () => ({
  appendChunk: async (recordingId: string, seq: number, blob: Blob) => { store.push({ recordingId, seq, blob }); },
  collectChunks: async (recordingId: string) => store.filter(c => c.recordingId === recordingId).map(c => c.blob),
  clearChunks: async () => { cleared.count++; },
}));
vi.mock('../../services/saveHealth', () => ({ reportSaveFailure: () => {} }));

/** Just enough MediaRecorder: one chunk per requestData/stop, `stop` fired after. */
class FakeMediaRecorder {
  static isTypeSupported(mime: string) { return mime === 'audio/mp4'; }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  readonly mimeType = 'audio/mp4';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.state = 'recording'; }
  requestData() { this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) }); }
  stop() {
    this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])]) });
    this.state = 'inactive';
    setTimeout(() => this.onstop?.(), 0);
  }
}

describe('SessionFileRecorder.stop', () => {
  it('returns the whole recording and leaves its chunks in the database', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' });
    const { SessionFileRecorder } = await import('./recorder');

    const rec = new SessionFileRecorder({} as MediaStream, 'rec-1');
    rec.start();
    (rec as unknown as { recorder: FakeMediaRecorder }).recorder.requestData();
    const { blob, mimeType } = await rec.stop();

    expect(mimeType).toBe('audio/mp4');
    expect(blob.size).toBe(5);
    expect(cleared.count).toBe(0);
    expect(store.filter(c => c.recordingId === 'rec-1')).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
