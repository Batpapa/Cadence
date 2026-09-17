// ── What an attachment really is ─────────────────────────────────────────────
// A file picked from disk is typed by the browser from its EXTENSION alone,
// and `.webm` maps to video/webm in Chromium whatever the file contains —
// there is no audio/webm extension mapping anywhere. A recording attached by
// hand therefore arrived labelled as a video and opened in a bare <video>
// element instead of the custom player (waveform, speed, loop), even though
// the player itself never looks at the mime type: it decodes the bytes.
//
// So the bytes are what decide here. This reads just enough of a file's head
// to answer one question — "is this a container with audio and NO video?" —
// and is deliberately conservative: anything it cannot prove stays as the
// browser labelled it. Used at two moments, which is why it is a plain
// function over a byte array rather than something async:
//   • fileToEntry(), so a newly attached file is stored correctly;
//   • the V8 → V9 migration, for everything attached before this existed.
//
// Note the asymmetry with clipExtract.ts's containerOf(): that one labels
// files Cadence itself writes, where the audio-only property is known by
// construction. Here it has to be read out of someone else's file.

/** How much of a file's head is enough. The Matroska Tracks element and every
 *  Ogg stream-identification page live near the start; 128 KB leaves room for
 *  a fat SeekHead or attached cover art without reading a whole recording. */
export const SNIFF_BYTES = 128 * 1024;

/** Whether `mime` is a label worth second-guessing.
 *
 *  Only the ones that come from an extension lookup rather than from the
 *  content: empty (no mapping at all — `.mka`, `.opus` on many systems),
 *  the generic binary fallback, and the `video/` family, whose members are
 *  containers that hold audio-only files just as happily. An `audio/*` label
 *  is already what the rest of the app wants, and an image or a PDF has
 *  nothing to gain. */
export function needsAudioSniff(mime: string | undefined): boolean {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return base === '' || base === 'application/octet-stream' ||
    base === 'application/ogg' || base.startsWith('video/');
}

/** Whether a file with this label could be audio — for deciding what to let
 *  through, rather than what to relabel.
 *
 *  The same reasoning one step wider: everything `needsAudioSniff` distrusts,
 *  plus the files already labelled as audio. The session library's drop target
 *  asked for `audio/` alone, which silently ignored a dropped `.webm` — while
 *  the SAME file picked through its own button imported fine, since that input
 *  has no filter at all. What a file really holds is for the decoder to say;
 *  this only keeps a dropped PDF or photo from starting an analysis. */
export function mayHoldAudio(mime: string | undefined): boolean {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return base.startsWith('audio/') || needsAudioSniff(base);
}

/** The `audio/*` type `head` proves, or null to keep the declared one.
 *
 *  Null covers three different "no": not a container read here, a container
 *  carrying video, and a head too short to be sure — all of which must leave
 *  the file exactly as it was. */
export function sniffAudioMime(head: Uint8Array): string | null {
  return sniffEbml(head) ?? sniffOgg(head) ?? sniffPlainAudio(head);
}

// ── EBML (WebM and Matroska) ─────────────────────────────────────────────────
// Both are the same format under two DocTypes. The tree is walked properly
// rather than scanned for codec strings: a TrackType of 1 buried in Tracks is
// the only statement that a video track exists, and a substring search would
// trip over the same bytes appearing inside a cluster's payload.

const ID_EBML        = 0x1a45dfa3;
const ID_DOCTYPE     = 0x4282;
const ID_SEGMENT     = 0x18538067;
const ID_TRACKS      = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE  = 0x83;

/** The elements worth descending into. Everything else is skipped by its
 *  declared size, which is what keeps this from walking a whole recording. */
const EBML_MASTERS = new Set([ID_EBML, ID_SEGMENT, ID_TRACKS, ID_TRACK_ENTRY]);

/** TrackType values. 3 is "complex" — a track that may carry a picture, so it
 *  counts as video here. */
const TRACK_VIDEO = 1;
const TRACK_AUDIO = 2;
const TRACK_COMPLEX = 3;

/** An element's size when the writer did not know it yet: every value bit set.
 *  Routine in a stream written live (MediaRecorder leaves Segment and its
 *  clusters open like this), so it means "to the end of what we have", not
 *  "broken". */
const SIZE_UNKNOWN = -1;

interface Vint { value: number; length: number }

/** An element id, kept in its on-the-wire form (marker bits included) — the
 *  form every EBML spec writes, so the constants above read as documented. */
function readId(b: Uint8Array, at: number): Vint | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 4 || at + length > b.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + b[at + i]!;
  return { value, length };
}

function readSize(b: Uint8Array, at: number): Vint | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > b.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    const byte = b[at + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value: allOnes ? SIZE_UNKNOWN : value, length };
}

function readUint(b: Uint8Array, start: number, end: number): number | null {
  if (end <= start || end > b.length || end - start > 8) return null;
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + b[i]!;
  return value;
}

function readAscii(b: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < Math.min(end, b.length); i++) {
    const c = b[i]!;
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

interface EbmlScan {
  docType: string;
  trackTypes: number[];
  /** Whether a Tracks element was read whole. False means the answer is "we
   *  do not know yet", never "there are no video tracks". */
  tracksComplete: boolean;
}

function walkEbml(b: Uint8Array, start: number, end: number, depth: number, out: EbmlScan): void {
  let pos = start;
  while (pos < end) {
    const id = readId(b, pos);
    if (!id) return;
    const size = readSize(b, pos + id.length);
    if (!size) return;
    const contentStart = pos + id.length + size.length;
    // An element that runs past what we read, or that never declared its
    // length, is taken as reaching the end of the buffer — enough to descend
    // into, not enough to call complete.
    const open = size.value === SIZE_UNKNOWN || contentStart + size.value > end;
    const contentEnd = open ? end : contentStart + size.value;

    if (id.value === ID_DOCTYPE) {
      out.docType = readAscii(b, contentStart, contentEnd);
    } else if (id.value === ID_TRACK_TYPE) {
      const type = readUint(b, contentStart, contentEnd);
      if (type !== null) out.trackTypes.push(type);
    } else if (EBML_MASTERS.has(id.value) && depth < 4) {
      if (id.value === ID_TRACKS && !open) out.tracksComplete = true;
      walkEbml(b, contentStart, contentEnd, depth + 1, out);
    }

    if (contentEnd <= pos) return; // a zero-length step would spin forever
    pos = contentEnd;
  }
}

function sniffEbml(b: Uint8Array): string | null {
  if (b.length < 4 || b[0] !== 0x1a || b[1] !== 0x45 || b[2] !== 0xdf || b[3] !== 0xa3) return null;
  const scan: EbmlScan = { docType: '', trackTypes: [], tracksComplete: false };
  walkEbml(b, 0, b.length, 0, scan);
  if (!scan.tracksComplete) return null;
  if (scan.trackTypes.some(t => t === TRACK_VIDEO || t === TRACK_COMPLEX)) return null;
  if (!scan.trackTypes.includes(TRACK_AUDIO)) return null;
  // Same naming as clipExtract.ts's containerOf, so a clip cut out of a file
  // and the file itself end up labelled identically.
  return scan.docType === 'webm' ? 'audio/webm' : 'audio/x-matroska';
}

// ── Ogg ──────────────────────────────────────────────────────────────────────
// Every logical stream opens with a "beginning of stream" page whose first
// bytes name the codec, and those pages all come first. Reading them is the
// whole job: one video codec among them and the file is a video.

const OGG_AUDIO = [
  [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64],       // OpusHead
  [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73],             // \x01vorbis
  [0x7f, 0x46, 0x4c, 0x41, 0x43],                         // \x7fFLAC
  [0x53, 0x70, 0x65, 0x65, 0x78, 0x20, 0x20, 0x20],       // "Speex   "
];
const OGG_VIDEO = [
  [0x80, 0x74, 0x68, 0x65, 0x6f, 0x72, 0x61],             // \x80theora
  [0x4f, 0x56, 0x50, 0x38, 0x30],                         // OVP80
  [0x42, 0x42, 0x43, 0x44],                               // BBCD (Dirac)
  [0x80, 0x64, 0x61, 0x61, 0x6c, 0x61],                   // \x80daala
];

function matches(b: Uint8Array, at: number, sig: number[]): boolean {
  if (at + sig.length > b.length) return false;
  return sig.every((byte, i) => b[at + i] === byte);
}

function sniffOgg(b: Uint8Array): string | null {
  if (!matches(b, 0, [0x4f, 0x67, 0x67, 0x53])) return null; // OggS
  let pos = 0;
  let sawAudio = false;
  // A handful of logical streams is already more than any real file has;
  // the bound is there so a corrupt head cannot become a long loop.
  for (let page = 0; page < 8; page++) {
    if (!matches(b, pos, [0x4f, 0x67, 0x67, 0x53])) break;
    const headerType = b[pos + 5];
    const segCount = b[pos + 26];
    if (headerType === undefined || segCount === undefined) break;
    const dataStart = pos + 27 + segCount;
    if (dataStart > b.length) break;
    if (!(headerType & 0x02)) break; // past the stream-identification pages
    if (OGG_VIDEO.some(sig => matches(b, dataStart, sig))) return null;
    if (OGG_AUDIO.some(sig => matches(b, dataStart, sig))) sawAudio = true;
    else return null; // an unknown codec is not an audio one until proven
    let dataLen = 0;
    for (let i = 0; i < segCount; i++) dataLen += b[pos + 27 + i]!;
    pos = dataStart + dataLen;
  }
  return sawAudio ? 'audio/ogg' : null;
}

// ── Formats that cannot hold a picture ───────────────────────────────────────
// Nothing to decide for these: the magic alone settles it. They are here for
// the files the browser typed as nothing at all, which until now had no
// preview whatsoever.

function sniffPlainAudio(b: Uint8Array): string | null {
  if (matches(b, 0, [0x52, 0x49, 0x46, 0x46]) && matches(b, 8, [0x57, 0x41, 0x56, 0x45])) return 'audio/wav';
  if (matches(b, 0, [0x66, 0x4c, 0x61, 0x43])) return 'audio/flac';                 // fLaC
  if (matches(b, 0, [0x49, 0x44, 0x33])) return 'audio/mpeg';                       // ID3
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'audio/mpeg'; // MPEG frame sync
  // M4A/M4B are the audio-only brands of the MP4 family. Every other brand is
  // left alone: an .mp4 really can be a video, and its moov may not even be
  // in the head.
  if (matches(b, 4, [0x66, 0x74, 0x79, 0x70]) &&
      (matches(b, 8, [0x4d, 0x34, 0x41, 0x20]) || matches(b, 8, [0x4d, 0x34, 0x42, 0x20]))) return 'audio/mp4';
  return null;
}

// ── V8 → V9 ──────────────────────────────────────────────────────────────────

/** Base64 characters covering SNIFF_BYTES, rounded up to a whole 4-char group
 *  so the slice decodes on its own. */
const SNIFF_B64_CHARS = Math.ceil(SNIFF_BYTES / 3) * 4;

/** The head of a stored attachment, decoded from its base64 without
 *  materialising the whole file — an hour-long recording is not worth 100 MB
 *  of string to read 128 KB of it. */
function storedHead(data: string): Uint8Array | null {
  try {
    const bin = atob(data.slice(0, SNIFF_B64_CHARS));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null; // not decodable base64: leave the attachment untouched
  }
}

/** Schema V8 → V9 for one raw card: attachments the browser mislabelled from
 *  their extension get the type their content proves.
 *
 *  Shared by the whole-state migration and the card-package import, like
 *  migrateClipTags, so a .cdc exported before this cannot bring video/webm
 *  audio back onto a device that has already been fixed. Idempotent: a second
 *  run sees `audio/*` and skips. */
export function migrateAudioMimeTypes(card: Record<string, unknown>): void {
  const content = card['content'] as Record<string, unknown> | undefined;
  const attachments = content?.['attachments'];
  if (!Array.isArray(attachments)) return;
  for (const raw of attachments) {
    if (!raw || typeof raw !== 'object') continue;
    const att = raw as Record<string, unknown>;
    if (att['type'] !== 'file' || typeof att['data'] !== 'string') continue;
    const mime = att['mimeType'];
    if (typeof mime !== 'string' || !needsAudioSniff(mime)) continue;
    const head = storedHead(att['data']);
    if (!head) continue;
    const sniffed = sniffAudioMime(head);
    if (sniffed) att['mimeType'] = sniffed;
  }
}
