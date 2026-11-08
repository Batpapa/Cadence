import libheifFactory from 'libheif-js/libheif-wasm/libheif-bundle.mjs';

// ── A HEIC picture decoded off the page (heic.ts) ────────────────────────────
// libheif compiled to WASM, the binary inside the bundle (libheif-js's
// "wasm-bundle"). heic-to, tried first, ships it as asm.js: 10.8 s for a
// 12-megapixel iPhone photo in Chromium, its worker's start included, where
// this decodes the same in 0.7 s (both measured 2026-11-08) — on a tablet,
// the difference between a picture and a wait nobody sits through.
//
// The JPEG is made here too when the worker can draw (OffscreenCanvas):
// otherwise the pixels go back and the page encodes them.

export type HeicRequest = { id: number; bytes: ArrayBuffer };
export type HeicResponse =
  | { id: number; jpeg: Blob }
  | { id: number; pixels: ImageData }
  | { id: number; error: string };

interface WorkerScope {
  postMessage(msg: HeicResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<HeicRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let decoder: HeifDecoder | null = null;

async function decode(bytes: ArrayBuffer): Promise<ImageData> {
  // One decoder for the worker's life: it frees the file it held at the
  // next decode, which is all the memory there is to give back.
  decoder ??= new (libheifFactory().HeifDecoder)();
  const images = decoder.decode(new Uint8Array(bytes));
  try {
    const image = images.find((i) => i.is_primary()) ?? images[0];
    if (!image) throw new Error('no image in the file');
    const width = image.get_width();
    const height = image.get_height();
    const pixels = new ImageData(width, height);
    await new Promise<void>((resolve, reject) => {
      image.display(pixels, (done) => (done ? resolve() : reject(new Error('decoding failed'))));
    });
    return pixels;
  } finally {
    for (const image of images) image.free();
  }
}

ctx.onmessage = (e) => {
  const { id, bytes } = e.data;
  decode(bytes)
    .then(async (pixels) => {
      if (typeof OffscreenCanvas === 'undefined') {
        ctx.postMessage({ id, pixels }, [pixels.data.buffer]);
        return;
      }
      const canvas = new OffscreenCanvas(pixels.width, pixels.height);
      canvas.getContext('2d')!.putImageData(pixels, 0, 0);
      ctx.postMessage({ id, jpeg: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 }) });
    })
    .catch((err: unknown) => ctx.postMessage({ id, error: String(err) }));
};
