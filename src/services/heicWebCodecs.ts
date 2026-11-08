import { parseHeif, type HeifColour, type HeifPicture } from './heifContainer';

/** A HEIC decoded by the device's own video decoder (WebCodecs).
 *
 *  Chrome has no HEVC decoder of its own (so no HEIC in an <img>), but it does
 *  hand HEVC to the hardware's, and the tablets and phones this is for all
 *  have one. Each tile of the photo goes through it as a video frame, drawn in
 *  place as it comes out.
 *
 *  Measured 2026-11-08, a 12-megapixel iPhone photo (48 tiles), Chromium on
 *  Windows: 0.2 s from the bytes to the JPEG, against 2.3 to 3 s for libheif
 *  in WebAssembly (which stays the fallback, heic.ts).
 *
 *  Throws whenever it cannot: no WebCodecs, no hardware HEVC, a file the
 *  container reader refuses, a decoder error, a decoder that stalls. */

/** A decoder that stops answering is given this long, all tiles included. */
const DECODE_TIMEOUT_MS = 10_000;

// The nclx codes (ISO/IEC 23091-2) WebCodecs has a name for. Plain strings:
// TypeScript's DOM types lag the spec (no smpte432, the iPhone's P3).
const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
const TRANSFERS: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
const MATRICES: Record<number, string> = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };

/** The decoder's colour space, every member stated: left out, Chrome assumes
 *  BT.709 limited range whatever the file says (measured 2026-11-08 on an
 *  iPhone photo: up to 20/255 off). "Unspecified" resolves as libheif
 *  resolves it (nclx.cc: set_sRGB_defaults, get_Kr_Kb): BT.709 primaries,
 *  sRGB transfer, BT.601 matrix. A code WebCodecs has no name for throws, and
 *  libheif takes the file. */
function colorSpaceOf(colour: HeifColour): VideoColorSpaceInit {
  const UNSPECIFIED = 2;
  const name = (table: Record<number, string>, code: number, fallback: string): string => {
    if (code === UNSPECIFIED) return fallback;
    const n = table[code];
    if (!n) throw new Error(`HEIF: colour code ${code} has no WebCodecs name`);
    return n;
  };
  return {
    primaries: name(PRIMARIES, colour.primaries, 'bt709'),
    transfer: name(TRANSFERS, colour.transfer, 'iec61966-2-1'),
    matrix: name(MATRICES, colour.matrix, 'smpte170m'),
    fullRange: colour.fullRange,
  } as unknown as VideoColorSpaceInit;
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;
function makeCanvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}
const context = (c: Canvas) => c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

async function decodeTiles(picture: HeifPicture): Promise<Canvas> {
  const config: VideoDecoderConfig = {
    codec: picture.codec,
    description: picture.hvcC,
    codedWidth: picture.tileWidth,
    codedHeight: picture.tileHeight,
    // Software HEVC is exactly what Chrome does not have: asking for it would
    // only ever say no.
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
    colorSpace: colorSpaceOf(picture.colour),
  };
  // A browser that knows fewer colour names than these throws here, and
  // libheif takes the file: without the colour space Chrome would assume
  // BT.709 limited range, which is wrong for an iPhone's photo.
  if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`HEIF: ${picture.codec} not supported`);

  const canvas = makeCanvas(picture.width, picture.height);
  const ctx = context(canvas);
  let failure: unknown = null;
  let drawn = 0;
  // Each frame drawn and CLOSED the moment it comes out: a hardware decoder
  // has a few buffers, not 48, and stops dead once they are all held
  // (measured: 18 frames out, then nothing, until a timeout).
  const decoder = new VideoDecoder({
    output: (frame) => {
      const tile = picture.tiles[frame.timestamp];
      if (tile) { ctx.drawImage(frame, tile.x, tile.y); drawn++; }
      frame.close();
    },
    error: (e) => { failure = e; },
  });
  try {
    decoder.configure(config);
    picture.tiles.forEach((tile, i) => decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data: tile.data })));
    let timer = 0;
    await Promise.race([
      decoder.flush(),
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('HEIF: decoder stalled')), DECODE_TIMEOUT_MS); }),
    ]).finally(() => window.clearTimeout(timer));
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failure) throw failure;
  if (drawn !== picture.tiles.length) throw new Error(`HEIF: ${drawn} of ${picture.tiles.length} tiles decoded`);
  return canvas;
}

/** The transformations applied one after the other, each onto a new canvas. */
function transform(source: Canvas, picture: HeifPicture): Canvas {
  let current = source;
  for (const t of picture.transforms) {
    const w = current.width, h = current.height;
    let next: Canvas;
    if (t.type === 'crop') {
      next = makeCanvas(t.width, t.height);
      context(next).drawImage(current, t.x, t.y, t.width, t.height, 0, 0, t.width, t.height);
    } else if (t.type === 'rotate') {
      const quarter = t.angle !== 180;
      next = makeCanvas(quarter ? h : w, quarter ? w : h);
      const ctx = context(next);
      // Anti-clockwise: a canvas turns clockwise for a positive angle.
      ctx.translate(next.width / 2, next.height / 2);
      ctx.rotate((-t.angle * Math.PI) / 180);
      ctx.drawImage(current, -w / 2, -h / 2);
    } else {
      next = makeCanvas(w, h);
      const ctx = context(next);
      if (t.flip === 'left-right') { ctx.translate(w, 0); ctx.scale(-1, 1); }
      else { ctx.translate(0, h); ctx.scale(1, -1); }
      ctx.drawImage(current, 0, 0);
    }
    current = next;
  }
  return current;
}

function toJpeg(canvas: Canvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', 0.92));
}

/** Whether this browser could try at all — the hardware is asked later. */
export function webCodecsAvailable(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

export async function heifToJpegWebCodecs(bytes: Uint8Array): Promise<Blob> {
  const picture = parseHeif(bytes);
  return toJpeg(transform(await decodeTiles(picture), picture));
}
