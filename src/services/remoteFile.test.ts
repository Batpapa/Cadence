import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  probeRemoteFile, fetchRemoteFile, remoteDisplayName, typeFromUrl,
  RemoteFileError, MAX_REMOTE_FILE_BYTES, type RemoteRefusal,
} from './remoteFile';
import { checkEmbed, checkLink, isFileEmbed } from './embedService';

// A Uint8Array body on purpose: a string one makes Node label the response
// text/plain by itself, which is exactly the header these tests vary.
function serve(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}, status = 200) {
  const fetchMock = vi.fn(async () => new Response(bytes, { status, headers }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const MP3_HEAD = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]); // "ID3"
const PDF_HEAD = new TextEncoder().encode('%PDF-1.7\n');

async function refusal(p: Promise<unknown>): Promise<RemoteRefusal> {
  try { await p; } catch (e) {
    if (e instanceof RemoteFileError) return e.refusal;
    throw e;
  }
  throw new Error('expected a refusal');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('probeRemoteFile', () => {
  it('takes a labelled audio file at its word', async () => {
    serve(MP3_HEAD, { 'content-type': 'audio/mpeg' });
    const head = await probeRemoteFile('https://box.tail.ts.net/sets/silver-spear.mp3');
    expect(head).toEqual({ name: 'silver-spear.mp3', mimeType: 'audio/mpeg' });
  });

  it('refuses a web page even when it passes CORS', async () => {
    serve(new TextEncoder().encode('<!doctype html>'), { 'content-type': 'text/html; charset=utf-8' });
    expect(await refusal(probeRemoteFile('https://thesession.org/discussions/1'))).toEqual({ why: 'unsupported' });
  });

  it('reads the extension when the server labels everything as binary', async () => {
    serve(MP3_HEAD, { 'content-type': 'application/octet-stream' });
    expect((await probeRemoteFile('https://x.org/a.mp3')).mimeType).toBe('audio/mpeg');
  });

  it('turns an ABC or markdown file served as plain text into what the viewers pick out', async () => {
    serve(new TextEncoder().encode('X:1'), { 'content-type': 'text/plain; charset=utf-8' });
    expect((await probeRemoteFile('https://x.org/reel.abc')).mimeType).toBe('text/vnd.abc');
    serve(new TextEncoder().encode('# hi'), { 'content-type': 'text/plain' });
    expect((await probeRemoteFile('https://x.org/notes.md')).mimeType).toBe('text/markdown');
  });

  it('recognises a file by its first bytes when neither label nor name says anything', async () => {
    serve(PDF_HEAD, { 'content-type': 'application/octet-stream' });
    expect((await probeRemoteFile('https://dl.example.org/s/abc123')).mimeType).toBe('application/pdf');
  });

  it('refuses an unlabelled file whose bytes are nothing a viewer opens', async () => {
    serve(new Uint8Array([1, 2, 3, 4, 5, 6]), {});
    expect(await refusal(probeRemoteFile('https://dl.example.org/s/abc123'))).toEqual({ why: 'unsupported' });
  });

  it('calls a fetch that nothing answers "nowhere"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await refusal(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'nowhere' });
  });

  it('calls a CORS refusal from a server that DID answer "cors" — told apart by a no-cors request', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    // Whether a file is there stays unknown — the message says "inaccessible",
    // not "refused", for that reason.
    expect(await refusal(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'cors' });
    expect(fetchMock.mock.calls.map(c => c[1]?.mode ?? 'cors')).toEqual(['cors', 'no-cors']);
  });

  it('reads 404 as "nowhere" and 401/403 as "forbidden"', async () => {
    serve(new Uint8Array(0), { 'content-type': 'text/html' }, 404);
    expect(await refusal(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'nowhere' });
    serve(new Uint8Array(0), { 'content-type': 'text/html' }, 403);
    expect(await refusal(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'forbidden' });
    serve(new Uint8Array(0), { 'content-type': 'text/html' }, 401);
    expect(await refusal(probeRemoteFile('https://x.org/a.mp3'))).toEqual({ why: 'forbidden' });
  });

  it('refuses a file announced as too large, before reading it', async () => {
    serve(MP3_HEAD, { 'content-type': 'audio/mpeg', 'content-length': String(MAX_REMOTE_FILE_BYTES + 1) });
    expect(await refusal(probeRemoteFile('https://x.org/a.mp3')))
      .toEqual({ why: 'too-big', bytes: MAX_REMOTE_FILE_BYTES + 1 });
  });

  it('takes the name the server gives when it lets the page read it', async () => {
    serve(MP3_HEAD, {
      'content-type': 'audio/mpeg',
      'content-disposition': "attachment; filename*=UTF-8''Le%20Bal%20%C3%A0%20Jo.mp3",
    });
    expect((await probeRemoteFile('https://x.org/dl?id=7')).name).toBe('Le Bal à Jo.mp3');
  });
});

describe('fetchRemoteFile', () => {
  it('returns the bytes as a FileEntry, with progress along the way', async () => {
    serve(MP3_HEAD, { 'content-type': 'audio/mpeg', 'content-length': String(MP3_HEAD.length) });
    const seen: Array<[number, number | null]> = [];
    const entry = await fetchRemoteFile('https://x.org/a.mp3', 'Silver Spear.mp3', {
      onProgress: (r, t) => seen.push([r, t]),
    });
    expect(entry.name).toBe('Silver Spear.mp3');
    expect(entry.mimeType).toBe('audio/mpeg');
    expect(Uint8Array.from(atob(entry.data), c => c.charCodeAt(0))).toEqual(MP3_HEAD);
    expect(seen.at(-1)).toEqual([MP3_HEAD.length, MP3_HEAD.length]);
  });

  it('lets a cancel through as a cancel, not as a refusal', async () => {
    serve(MP3_HEAD, { 'content-type': 'audio/mpeg' });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fetchRemoteFile('https://x.org/a.mp3', 'a.mp3', { signal: ctrl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('names and guesses', () => {
  it('adds the file extension to a label that has none', () => {
    expect(remoteDisplayName('Silver Spear', 'https://x.org/sets/s1.mp3')).toBe('Silver Spear.mp3');
    expect(remoteDisplayName('Silver Spear.mp3', 'https://x.org/sets/s1.mp3')).toBe('Silver Spear.mp3');
    expect(remoteDisplayName(undefined, 'https://x.org/sets/s%201.mp3')).toBe('s 1.mp3');
  });

  it('reads a type off the extension alone, for the row icon', () => {
    expect(typeFromUrl('https://x.org/a.MP3?x=1')).toBe('audio/mpeg');
    expect(typeFromUrl('https://x.org/a.pdf')).toBe('application/pdf');
    expect(typeFromUrl('https://thesession.org/tunes/2')).toBe('');
    expect(typeFromUrl('https://x.org/page.html')).toBe('');
  });
});

describe('checkEmbed and isFileEmbed', () => {
  it('probes a URL no platform claims, and stores the file URL as its own iframe src', async () => {
    serve(MP3_HEAD, { 'content-type': 'audio/mpeg' });
    const url = 'https://box.tail.ts.net/a.mp3';
    expect(await checkEmbed(url)).toEqual({ ok: true, title: 'a.mp3', embedUrl: url });
  });

  it('passes the refusal on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await checkEmbed('https://x.org/a.mp3')).toEqual({ ok: false, refusal: { why: 'nowhere' } });
  });

  it('refuses a scheme that is not http(s), on both sides, without fetching', async () => {
    const fetchMock = serve(MP3_HEAD, { 'content-type': 'audio/mpeg' });
    expect(await checkEmbed('javascript:alert(1)')).toEqual({ ok: false, refusal: { why: 'scheme' } });
    expect(await checkLink('ftp://x.org/a.mp3')).toEqual({ ok: false, refusal: { why: 'scheme' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks a platform through oEmbed, and reads its refusals the same way', async () => {
    serve(new Uint8Array(0), {}, 404);
    expect(await checkEmbed('https://youtu.be/nope')).toEqual({ ok: false, refusal: { why: 'nowhere' } });
    serve(new Uint8Array(0), {}, 401);
    expect(await checkEmbed('https://youtu.be/private')).toEqual({ ok: false, refusal: { why: 'forbidden' } });
    serve(new TextEncoder().encode(JSON.stringify({ title: 'A profile' })), { 'content-type': 'application/json' });
    expect(await checkEmbed('https://open.spotify.com/user/x')).toEqual({ ok: false, refusal: { why: 'unsupported' } });
    serve(new TextEncoder().encode(JSON.stringify({ title: 'Nightride', html: '<iframe src="https://www.youtube.com/embed/x">' })),
      { 'content-type': 'application/json' });
    expect(await checkEmbed('https://youtu.be/x')).toEqual({ ok: true, title: 'Nightride', embedUrl: 'https://www.youtube.com/embed/x' });
  });

  it('asks an external link only whether anything answers', async () => {
    serve(new Uint8Array(0), { 'content-type': 'text/html' });
    expect(await checkLink('https://thesession.org/discussions/1')).toEqual({ ok: true, title: '', embedUrl: '' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await checkLink('https://no-such-host.invalid/')).toEqual({ ok: false, refusal: { why: 'nowhere' } });
  });

  it('reads a 404 when the server lets it be read, and lets a login page through', async () => {
    serve(new Uint8Array(0), { 'content-type': 'text/html' }, 404);
    expect(await checkLink('https://x.org/typo')).toEqual({ ok: false, refusal: { why: 'nowhere' } });
    serve(new Uint8Array(0), { 'content-type': 'text/html' }, 403);
    expect(await checkLink('https://x.org/members')).toEqual({ ok: true, title: '', embedUrl: '' });
  });

  it('without CORS, a tab only needs something to answer — its 404 cannot be seen', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    }));
    expect(await checkLink('https://www.google.com/sdgsegergqtsbsb')).toEqual({ ok: true, title: '', embedUrl: '' });
  });

  it('tells a file from a platform by the URL, whatever embedUrl holds', () => {
    expect(isFileEmbed({ id: 'e', url: 'https://x.org/a.mp3', embedUrl: 'https://x.org/a.mp3', mode: 'embed' })).toBe(true);
    expect(isFileEmbed({ id: 'e', url: 'https://youtu.be/x', embedUrl: 'https://www.youtube.com/embed/x' })).toBe(false);
    expect(isFileEmbed({ id: 'e', url: 'https://x.org/a.mp3', mode: 'link' })).toBe(false);
  });
});
