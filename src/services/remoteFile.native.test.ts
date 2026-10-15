import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NativeGetResult } from '../native/nativeHttp';

// The app's path (2026-10-09): remote files read through Android's own HTTP,
// where CORS does not apply. Its own file because `isNative` is mocked for
// the whole module — the web path's tests live in remoteFile.test.ts.

vi.mock('../native/platform', () => ({ isNative: () => true }));
const nativeGet = vi.fn<(url: string, opts: { headers?: Record<string, string>; timeoutMs: number }) => Promise<NativeGetResult>>();
vi.mock('../native/nativeHttp', () => ({ nativeGet: (...a: Parameters<typeof nativeGet>) => nativeGet(...a) }));

const { probeRemoteFile, fetchRemoteFile, checkLinkTarget, RemoteFileError, MAX_REMOTE_FILE_BYTES } = await import('./remoteFile');

const MP3_HEAD = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]); // "ID3"
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
/** A fetched file's bytes, as base64, to compare with what was served. */
const blobB64 = async (p: Promise<{ blob: Blob }>) => b64(new Uint8Array(await (await p).blob.arrayBuffer()));

function answer(status: number, headers: Record<string, string>, body: Uint8Array = new Uint8Array(0), url = 'https://box.tail.ts.net/a.mp3'): NativeGetResult {
  return { status, url, headers: new Map(Object.entries(headers)), base64: b64(body) };
}

async function refusalOf(p: Promise<unknown>) {
  try { await p; } catch (e) { if (e instanceof RemoteFileError) return e.refusal; throw e; }
  throw new Error('expected a refusal');
}

beforeEach(() => { nativeGet.mockReset(); });

describe('remote files in the app (native HTTP)', () => {
  it('probes with a Range request and recognises the file by its first bytes', async () => {
    const url = 'https://box.tail.ts.net/sets/silver-spear.mp3';
    nativeGet.mockResolvedValue(answer(206, { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-9/5000000' }, MP3_HEAD, url));
    const head = await probeRemoteFile(url);
    expect(head).toEqual({ name: 'silver-spear.mp3', mimeType: 'audio/mpeg' });
    expect(nativeGet.mock.calls[0]![1].headers?.['Range']).toMatch(/^bytes=0-\d+$/);
  });

  it('never answers "cors": a server that answers is read', async () => {
    nativeGet.mockResolvedValue(answer(200, { 'content-type': 'audio/mpeg', 'last-modified': 'Mon, 13 Oct 2026 20:41:00 GMT' }, MP3_HEAD, 'https://example.org/reel.mp3'));
    const file = await fetchRemoteFile('https://example.org/reel.mp3');
    expect(file.name).toBe('reel.mp3');
    expect(file.blob.type).toBe('audio/mpeg');
    expect(file.lastModified).toBe(Date.UTC(2026, 9, 13, 20, 41));
    expect(b64(new Uint8Array(await file.blob.arrayBuffer()))).toBe(b64(MP3_HEAD));
  });

  it('turns an HTTP refusal and a dead host into the same refusals as the web', async () => {
    nativeGet.mockResolvedValue(answer(403, {}));
    expect(await refusalOf(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'forbidden' });
    nativeGet.mockResolvedValue(answer(404, {}));
    expect(await refusalOf(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'nowhere' });
    nativeGet.mockRejectedValue(new Error('UnknownHostException'));
    expect(await refusalOf(fetchRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'nowhere' });
  });

  it('checks a tab link by its status: a bot check passes, a 404 or a dead host does not', async () => {
    nativeGet.mockResolvedValue(answer(403, { 'cf-mitigated': 'challenge' }));
    expect(await checkLinkTarget('https://www.folktunefinder.com/tunes/63035')).toBeNull();
    expect(nativeGet.mock.calls[0]![1].headers?.['Range']).toBe('bytes=0-0');
    nativeGet.mockResolvedValue(answer(404, {}));
    expect(await checkLinkTarget('https://x.org/typo')).toEqual({ why: 'nowhere' });
    nativeGet.mockRejectedValue(new Error('UnknownHostException'));
    expect(await checkLinkTarget('https://no-such-host.invalid/')).toEqual({ why: 'nowhere' });
  });

  it('reads the whole size from Content-Range, not the partial length', async () => {
    const total = MAX_REMOTE_FILE_BYTES + 1;
    nativeGet.mockResolvedValue(answer(206, { 'content-type': 'audio/mpeg', 'content-length': '10', 'content-range': `bytes 0-9/${total}` }, MP3_HEAD));
    expect(await refusalOf(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'too-big', bytes: total });
  });

  it('refuses a web page', async () => {
    nativeGet.mockResolvedValue(answer(200, { 'content-type': 'text/html; charset=utf-8' }, new TextEncoder().encode('<!doctype html>')));
    expect(await refusalOf(fetchRemoteFile('https://thesession.org/discussions/1'))).toEqual({ why: 'unsupported' });
  });

  /** A server honouring Range over `file`, optionally sending shorter pieces
   *  than asked, or a `/*` total. */
  function rangeServer(file: Uint8Array, opts: { maxPiece?: number; hideTotal?: boolean } = {}) {
    nativeGet.mockImplementation(async (_url, o) => {
      const m = /bytes=(\d+)-(\d+)/.exec(o.headers?.['Range'] ?? '');
      if (!m) return answer(200, { 'content-type': 'audio/mpeg', 'content-length': String(file.length) }, file);
      const from = Number(m[1]);
      const to = Math.min(Number(m[2]) + 1, file.length, from + (opts.maxPiece ?? Infinity));
      const piece = file.subarray(from, to);
      return answer(206, {
        'content-type': 'audio/mpeg',
        'content-length': String(piece.length),
        'content-range': `bytes ${from}-${to - 1}/${opts.hideTotal ? '*' : file.length}`,
      }, piece);
    });
  }
  const bigFile = () => {
    const f = new Uint8Array(2_000_003);
    f.set(MP3_HEAD);
    for (let i = MP3_HEAD.length; i < f.length; i++) f[i] = (i * 7) & 0xff;
    return f;
  };

  it('opens a file piece by piece, with progress, into the same bytes as the whole', async () => {
    const file = bigFile();
    rangeServer(file);
    const progress: Array<[number, number | null]> = [];
    expect(await blobB64(fetchRemoteFile('https://x.org/big.mp3', { onProgress: (r, t) => progress.push([r, t]) }))).toBe(b64(file));
    expect(nativeGet.mock.calls.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toEqual([file.length, file.length]);
    expect(progress.length).toBe(nativeGet.mock.calls.length);
  });

  it('keeps going without a total until a short piece', async () => {
    const file = bigFile();
    rangeServer(file, { hideTotal: true });
    expect(await blobB64(fetchRemoteFile('https://x.org/big.mp3'))).toBe(b64(file));
  });

  it('keeps every byte when the server sends shorter pieces than asked', async () => {
    const file = bigFile();
    rangeServer(file, { maxPiece: 100_001 });
    expect(await blobB64(fetchRemoteFile('https://x.org/big.mp3'))).toBe(b64(file));
  });

  it('takes the whole file at once from a server that ignores Range', async () => {
    const file = bigFile();
    nativeGet.mockResolvedValue(answer(200, { 'content-type': 'audio/mpeg' }, file));
    expect(await blobB64(fetchRemoteFile('https://x.org/big.mp3'))).toBe(b64(file));
    expect(nativeGet).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when cancelled', async () => {
    nativeGet.mockReturnValue(new Promise(() => {}));
    const ctrl = new AbortController();
    const p = fetchRemoteFile('https://x.org/a.mp3', { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
