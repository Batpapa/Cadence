import { describe, it, expect } from 'vitest';
import { needsAudioSniff, mayHoldAudio, sniffAudioMime, migrateAudioMimeTypes } from './audioSniff';

// ── Synthetic containers ─────────────────────────────────────────────────────
// Real files would mean fixtures; what is under test is the head, and a head
// can be written out by hand. Sizes stay under 127 so a one-byte vint says
// them, except where an unknown size (0xff) is the point.

const ID_EBML = [0x1a, 0x45, 0xdf, 0xa3];
const ID_DOCTYPE = [0x42, 0x82];
const ID_SEGMENT = [0x18, 0x53, 0x80, 0x67];
const ID_TRACKS = [0x16, 0x54, 0xae, 0x6b];
const ID_TRACK_ENTRY = [0xae];
const ID_TRACK_TYPE = [0x83];

const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0));
const el = (id: number[], payload: number[]): number[] => [...id, 0x80 | payload.length, ...payload];
const bytes = (...parts: number[][]): Uint8Array => new Uint8Array(parts.flat());

/** `trackTypes` as TrackEntry elements — 1 is video, 2 audio. `openSegment`
 *  leaves the Segment's size undeclared, which is what MediaRecorder writes. */
function ebml(docType: string, trackTypes: number[], openSegment = true): Uint8Array {
  const tracks = el(ID_TRACKS, trackTypes.flatMap(t => el(ID_TRACK_ENTRY, el(ID_TRACK_TYPE, [t]))));
  const segment = openSegment ? [...ID_SEGMENT, 0xff, ...tracks] : el(ID_SEGMENT, tracks);
  return bytes(el(ID_EBML, el(ID_DOCTYPE, ascii(docType))), segment);
}

function oggPage(codecId: number[], bos = true): number[] {
  const header = [...ascii('OggS'), 0, bos ? 0x02 : 0x00, ...Array(8).fill(0), ...Array(4).fill(0),
    ...Array(4).fill(0), ...Array(4).fill(0), 1, codecId.length];
  return [...header, ...codecId];
}

describe('needsAudioSniff', () => {
  it('second-guesses only the labels that came from an extension', () => {
    expect(needsAudioSniff('video/webm')).toBe(true);
    expect(needsAudioSniff('')).toBe(true);
    expect(needsAudioSniff(undefined)).toBe(true);
    expect(needsAudioSniff('application/octet-stream')).toBe(true);
    expect(needsAudioSniff('application/ogg')).toBe(true);
  });

  it('leaves alone what is already right, or has nothing to gain', () => {
    expect(needsAudioSniff('audio/webm;codecs=opus')).toBe(false);
    expect(needsAudioSniff('image/png')).toBe(false);
    expect(needsAudioSniff('application/pdf')).toBe(false);
    expect(needsAudioSniff('text/vnd.abc')).toBe(false);
  });
});

describe('mayHoldAudio', () => {
  // The session library's drop target: `.webm` is the whole point, and a file
  // the browser could not type must stay welcome.
  it('lets through anything that could carry audio', () => {
    expect(mayHoldAudio('audio/mpeg')).toBe(true);
    expect(mayHoldAudio('video/webm')).toBe(true);
    expect(mayHoldAudio('video/x-matroska')).toBe(true);
    expect(mayHoldAudio('')).toBe(true);
    expect(mayHoldAudio('application/octet-stream')).toBe(true);
  });

  it('keeps out what plainly cannot', () => {
    expect(mayHoldAudio('application/pdf')).toBe(false);
    expect(mayHoldAudio('image/jpeg')).toBe(false);
    expect(mayHoldAudio('text/plain')).toBe(false);
  });
});

describe('sniffAudioMime — EBML', () => {
  it('calls an audio-only webm what it is', () => {
    expect(sniffAudioMime(ebml('webm', [2]))).toBe('audio/webm');
  });

  it('reads a Segment whose size was never declared', () => {
    expect(sniffAudioMime(ebml('webm', [2], false))).toBe('audio/webm');
  });

  it('keeps a real video a video', () => {
    expect(sniffAudioMime(ebml('webm', [1, 2]))).toBeNull();
  });

  it('distinguishes matroska from webm by DocType', () => {
    expect(sniffAudioMime(ebml('matroska', [2]))).toBe('audio/x-matroska');
  });

  // The trap: a head that stops before Tracks says nothing about video tracks,
  // and "nothing" must not be read as "none".
  it('refuses to answer when Tracks was cut off', () => {
    const full = ebml('webm', [2], false);
    expect(sniffAudioMime(full.slice(0, full.length - 3))).toBeNull();
  });

  it('ignores a subtitle-only file, which has no audio to play', () => {
    expect(sniffAudioMime(ebml('webm', [0x11]))).toBeNull();
  });
});

describe('sniffAudioMime — Ogg', () => {
  it('recognises opus, vorbis and flac streams', () => {
    expect(sniffAudioMime(bytes(oggPage(ascii('OpusHead'))))).toBe('audio/ogg');
    expect(sniffAudioMime(bytes(oggPage([0x01, ...ascii('vorbis')])))).toBe('audio/ogg');
    expect(sniffAudioMime(bytes(oggPage([0x7f, ...ascii('FLAC')])))).toBe('audio/ogg');
  });

  it('keeps theora and VP8 videos as videos', () => {
    expect(sniffAudioMime(bytes(oggPage([0x80, ...ascii('theora')])))).toBeNull();
    expect(sniffAudioMime(bytes(oggPage(ascii('OVP80'))))).toBeNull();
  });

  it('rejects a file whose audio is multiplexed with a picture', () => {
    expect(sniffAudioMime(bytes(oggPage(ascii('OpusHead')), oggPage([0x80, ...ascii('theora')])))).toBeNull();
  });
});

describe('sniffAudioMime — formats that cannot hold a picture', () => {
  it('reads the plain magics', () => {
    expect(sniffAudioMime(bytes(ascii('RIFF'), [0, 0, 0, 0], ascii('WAVE')))).toBe('audio/wav');
    expect(sniffAudioMime(bytes(ascii('fLaC')))).toBe('audio/flac');
    expect(sniffAudioMime(bytes(ascii('ID3'), [3, 0]))).toBe('audio/mpeg');
    expect(sniffAudioMime(bytes([0xff, 0xfb, 0x90, 0x00]))).toBe('audio/mpeg');
    expect(sniffAudioMime(bytes([0, 0, 0, 0x20], ascii('ftyp'), ascii('M4A ')))).toBe('audio/mp4');
  });

  it('says nothing about an MP4 that could be a video', () => {
    expect(sniffAudioMime(bytes([0, 0, 0, 0x20], ascii('ftyp'), ascii('isom')))).toBeNull();
  });

  it('says nothing about what it does not know', () => {
    expect(sniffAudioMime(bytes(ascii('%PDF-1.7')))).toBeNull();
    expect(sniffAudioMime(new Uint8Array())).toBeNull();
    expect(sniffAudioMime(bytes(ascii('OggS')))).toBeNull(); // magic, then nothing
  });
});

describe('migrateAudioMimeTypes', () => {
  const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
  const cardWith = (...attachments: Array<Record<string, unknown>>) =>
    ({ content: { notes: '', attachments } }) as Record<string, unknown>;

  it('relabels a webm recording attached by hand', () => {
    const card = cardWith({ type: 'file', name: 'session.webm', mimeType: 'video/webm', data: b64(ebml('webm', [2])) });
    migrateAudioMimeTypes(card);
    expect((card['content'] as any).attachments[0].mimeType).toBe('audio/webm');
  });

  it('gives a type to a file the browser could not type at all', () => {
    const card = cardWith({ type: 'file', name: 'tune.opus', mimeType: '', data: b64(bytes(oggPage(ascii('OpusHead')))) });
    migrateAudioMimeTypes(card);
    expect((card['content'] as any).attachments[0].mimeType).toBe('audio/ogg');
  });

  it('leaves a real video, an unknown file and an already-good label alone', () => {
    const card = cardWith(
      { type: 'file', name: 'lesson.webm', mimeType: 'video/webm', data: b64(ebml('webm', [1, 2])) },
      { type: 'file', name: 'notes.pdf', mimeType: 'application/pdf', data: b64(bytes(ascii('%PDF-1.7'))) },
      { type: 'file', name: 'clip.webm', mimeType: 'audio/webm', data: b64(ebml('webm', [2])) },
      { type: 'embed', url: 'https://example.com' },
    );
    migrateAudioMimeTypes(card);
    const atts = (card['content'] as any).attachments;
    expect(atts.map((a: any) => a.mimeType)).toEqual(['video/webm', 'application/pdf', 'audio/webm', undefined]);
  });

  it('is idempotent, and survives junk data', () => {
    const card = cardWith(
      { type: 'file', name: 'a.webm', mimeType: 'video/webm', data: b64(ebml('webm', [2])) },
      { type: 'file', name: 'b.webm', mimeType: 'video/webm', data: 'not base64 at all !!' },
    );
    expect(() => { migrateAudioMimeTypes(card); migrateAudioMimeTypes(card); }).not.toThrow();
    const atts = (card['content'] as any).attachments;
    expect(atts[0].mimeType).toBe('audio/webm');
    expect(atts[1].mimeType).toBe('video/webm');
  });

  it('does nothing to a card with no attachments array', () => {
    const card = { content: { notes: '' } } as Record<string, unknown>;
    expect(() => migrateAudioMimeTypes(card)).not.toThrow();
  });
});
