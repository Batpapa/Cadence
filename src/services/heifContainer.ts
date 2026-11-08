/** What a HEIC holds, read out of its container — no pixels decoded.
 *
 *  For heicWebCodecs.ts, which hands the HEVC tiles to the browser's video
 *  decoder. A photo is not one HEVC picture: an iPhone's is a GRID of 512 ×
 *  512 tiles (48 for 12 megapixels), each an HEVC frame of its own, laid out
 *  by a derived `grid` item and then turned or mirrored by the properties of
 *  that item (ISO/IEC 23008-12, "HEIF").
 *
 *  Anything this does not know how to show faithfully throws: the caller then
 *  hands the file to libheif, which knows the whole format. A wrong picture
 *  quickly is worse than the right one slowly. */

export interface HeifTile {
  /** Where its top-left corner goes in the grid. */
  x: number;
  y: number;
  /** The HEVC frame, as the file stores it: length-prefixed NAL units. */
  data: Uint8Array;
}

/** One transformation of the decoded picture, in the order the file lists
 *  them — the order the format says to apply them in. */
export type HeifTransform =
  | { type: 'crop'; x: number; y: number; width: number; height: number }
  /** Degrees ANTI-clockwise, as `irot` counts. */
  | { type: 'rotate'; angle: 90 | 180 | 270 }
  /** `imir`. Its `axis` 0 swaps TOP and BOTTOM, 1 left and right: the
   *  2022 edition of the standard, libheif (heif_properties.h:
   *  `heif_transform_mirror_direction_vertical = 0 // flip image
   *  vertically`) and Apple. The 2017 wording read the other way, and
   *  decoders that kept it turn an iPhone selfie upside down. */
  | { type: 'mirror'; flip: 'top-bottom' | 'left-right' };

export interface HeifColour {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export interface HeifPicture {
  /** The grid's size, before any transformation. */
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tiles: HeifTile[];
  /** The HEVC decoder configuration record (`hvcC` without its box header):
   *  WebCodecs' `description`. */
  hvcC: Uint8Array;
  /** The WebCodecs codec string, from the same record. */
  codec: string;
  transforms: HeifTransform[];
  /** How to turn the samples into colours: the container's `colr` nclx
   *  first, the bitstream's VUI otherwise, the standard's defaults last —
   *  libheif's and Google's CrabbyAvif's order. Codes may be 2,
   *  "unspecified", which the decoder side resolves. */
  colour: HeifColour;
}

interface Box { type: string; body: number; end: number }

interface Item {
  id: number;
  type: string;
  method: number;
  extents: Array<[number, number]>;
  /** Properties in association order. */
  props: Box[];
  refs: Map<string, number[]>;
}

/** The alpha planes' URNs (`auxC`): an image with one of these needs it to be
 *  shown right, which this path does not do. Depth maps and Apple's HDR gain
 *  maps, which a portrait-mode iPhone photo carries, change nothing to the
 *  picture itself and are ignored. */
const ALPHA_URNS = new Set(['urn:mpeg:hevc:2015:auxid:1', 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha']);

export function parseHeif(buf: Uint8Array): HeifPicture {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fail = (why: string): never => { throw new Error('HEIF: ' + why); };
  const need = (end: number) => { if (end > buf.length) fail('truncated'); };
  const u8 = (o: number) => { need(o + 1); return buf[o]!; };
  const u16 = (o: number) => { need(o + 2); return dv.getUint16(o); };
  const u32 = (o: number) => { need(o + 4); return dv.getUint32(o); };
  const i32 = (o: number) => { need(o + 4); return dv.getInt32(o); };
  const fourcc = (o: number) => { need(o + 4); return String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!); };
  /** Big-endian unsigned integer of 0 to 8 bytes; 0 bytes reads as 0. */
  const uint = (o: number, n: number) => {
    need(o + n);
    let x = 0;
    for (let i = 0; i < n; i++) x = x * 256 + buf[o + i]!;
    return x;
  };

  const boxes = (start: number, end: number): Box[] => {
    const out: Box[] = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(o);
      const type = fourcc(o + 4);
      let header = 8;
      if (size === 1) { size = uint(o + 8, 8); header = 16; }
      else if (size === 0) size = end - o;
      if (size < header || o + size > end) fail(`bad box ${type}`);
      out.push({ type, body: o + header, end: o + size });
      o += size;
    }
    return out;
  };
  const child = (parent: { body: number; end: number }, type: string): Box | undefined =>
    boxes(parent.body, parent.end).find((b) => b.type === type);

  const metaBox = boxes(0, buf.length).find((b) => b.type === 'meta') ?? fail('no meta');
  const meta = { body: metaBox.body + 4, end: metaBox.end }; // a full box

  const pitm = child(meta, 'pitm') ?? fail('no primary item');
  const primaryId = u8(pitm.body) === 0 ? u16(pitm.body + 4) : u32(pitm.body + 4);

  // ── Items ──
  const items = new Map<number, Item>();
  const iinf = child(meta, 'iinf') ?? fail('no iinf');
  const iinfFirst = iinf.body + 4 + (u8(iinf.body) === 0 ? 2 : 4);
  for (const infe of boxes(iinfFirst, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = u8(infe.body);
    if (v < 2) continue; // versions 0 and 1 name no item type
    let o = infe.body + 4;
    const id = v === 2 ? u16(o) : u32(o);
    o += (v === 2 ? 2 : 4) + 2; // + protection index
    items.set(id, { id, type: fourcc(o), method: 0, extents: [], props: [], refs: new Map() });
  }

  const iloc = child(meta, 'iloc') ?? fail('no iloc');
  {
    const v = u8(iloc.body);
    let o = iloc.body + 4;
    const offSize = u8(o) >> 4, lenSize = u8(o) & 15;
    const baseSize = u8(o + 1) >> 4, idxSize = v >= 1 ? u8(o + 1) & 15 : 0;
    o += 2;
    const read = (n: number) => { const x = uint(o, n); o += n; return x; };
    const count = v < 2 ? read(2) : read(4);
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? read(2) : read(4);
      const method = v >= 1 ? read(2) & 15 : 0;
      read(2); // data reference index
      const base = read(baseSize);
      const n = read(2);
      const extents: Array<[number, number]> = [];
      for (let j = 0; j < n; j++) {
        read(idxSize);
        const off = read(offSize);
        extents.push([base + off, read(lenSize)]);
      }
      const item = items.get(id);
      if (item) { item.method = method; item.extents = extents; }
    }
  }

  const iref = child(meta, 'iref');
  if (iref) {
    const w = u8(iref.body) === 0 ? 2 : 4;
    for (const ref of boxes(iref.body + 4, iref.end)) {
      let o = ref.body;
      const read = () => { const x = w === 2 ? u16(o) : u32(o); o += w; return x; };
      const from = read();
      const n = u16(o); o += 2;
      const to: number[] = [];
      for (let i = 0; i < n; i++) to.push(read());
      items.get(from)?.refs.set(ref.type, to);
    }
  }

  const iprp = child(meta, 'iprp') ?? fail('no iprp');
  const ipco = child(iprp, 'ipco') ?? fail('no ipco');
  const props = boxes(ipco.body, ipco.end);
  for (const ipma of boxes(iprp.body, iprp.end)) {
    if (ipma.type !== 'ipma') continue;
    const v = u8(ipma.body), wide = (u8(ipma.body + 3) & 1) === 1;
    let o = ipma.body + 4;
    const n = u32(o); o += 4;
    for (let i = 0; i < n; i++) {
      const id = v < 1 ? u16(o) : u32(o);
      o += v < 1 ? 2 : 4;
      const k = u8(o++);
      for (let j = 0; j < k; j++) {
        let index: number;
        if (wide) { index = u16(o) & 0x7fff; o += 2; } else { index = u8(o) & 0x7f; o += 1; }
        const prop = props[index - 1];
        if (index > 0 && prop) items.get(id)?.props.push(prop);
      }
    }
  }

  const prop = (item: Item, type: string) => item.props.find((p) => p.type === type);
  const idat = child(meta, 'idat');
  const dataOf = (item: Item): Uint8Array => {
    if (item.method !== 0 && item.method !== 1) fail('item stored by reference');
    const parts = item.extents.map(([off, len]) => {
      const at = item.method === 1 ? (idat ?? fail('no idat')).body + off : off;
      need(at + len);
      return buf.subarray(at, at + len);
    });
    if (parts.length === 1) return parts[0]!;
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return all;
  };
  const sizeOf = (item: Item): [number, number] => {
    const ispe = prop(item, 'ispe') ?? fail('no ispe');
    return [u32(ispe.body + 4), u32(ispe.body + 8)];
  };

  // ── The picture ──
  const primary = items.get(primaryId) ?? fail('primary item missing');
  // An `iden` item is its one source, transformed again: the source's own
  // properties first, then its own.
  const image = primary.type === 'iden'
    ? items.get((primary.refs.get('dimg') ?? fail('iden without source'))[0]!) ?? fail('iden source missing')
    : primary;
  const layers = image === primary ? [primary] : [image, primary];
  for (const item of items.values()) {
    const auxl = item.refs.get('auxl');
    const auxC = prop(item, 'auxC');
    if (auxl && layers.some((l) => auxl.includes(l.id)) && auxC) {
      let o = auxC.body + 4, urn = '';
      while (o < auxC.end && buf[o] !== 0) urn += String.fromCharCode(buf[o++]!);
      if (ALPHA_URNS.has(urn)) fail('alpha plane');
    }
  }

  let tileItems: Item[];
  let width: number, height: number, columns = 1;
  if (image.type === 'grid') {
    const g = dataOf(image);
    const gv = new DataView(g.buffer, g.byteOffset, g.byteLength);
    const big = (g[1]! & 1) === 1;
    const rows = g[2]! + 1;
    columns = g[3]! + 1;
    width = big ? gv.getUint32(4) : gv.getUint16(4);
    height = big ? gv.getUint32(8) : gv.getUint16(6);
    tileItems = (image.refs.get('dimg') ?? fail('grid without tiles')).map((id) => items.get(id) ?? fail('tile missing'));
    if (tileItems.length !== rows * columns) fail('grid and tiles disagree');
  } else if (image.type === 'hvc1') {
    tileItems = [image];
    [width, height] = sizeOf(image);
  } else {
    fail(`primary item is ${image.type}`);
  }

  const first = tileItems![0]!;
  if (tileItems!.some((t) => t.type !== 'hvc1')) fail('tile not HEVC');
  // Coded against another item (a burst's later frames): not a picture of
  // its own, and not a key frame to the decoder.
  if (tileItems!.some((t) => t.refs.has('pred'))) fail('predicted image');
  const hvcCBox = prop(first, 'hvcC') ?? fail('no hvcC');
  const hvcC = buf.subarray(hvcCBox.body, hvcCBox.end);
  // 4:2:0 only, what every phone takes and every hardware decoder reads.
  // Measured 2026-11-08: 4:2:2 and monochrome made Chrome's decoder fail,
  // and 4:4:4 decoded with wrong colours (39/255 off) — libheif is right on
  // all three.
  if (hvcC.length < 17 || (hvcC[16]! & 3) !== 1) fail('chroma not 4:2:0');
  // One decoder configuration for the whole grid: a tile with another one
  // (never seen) would need a decoder of its own.
  for (const t of tileItems!) {
    const other = prop(t, 'hvcC');
    if (!other || other.end - other.body !== hvcC.length || buf.subarray(other.body, other.end).some((b, i) => b !== hvcC[i])) fail('tiles differ');
  }
  const [tileWidth, tileHeight] = sizeOf(first);
  const tiles = tileItems!.map((t, i) => ({ x: (i % columns) * tileWidth, y: Math.floor(i / columns) * tileHeight, data: dataOf(t) }));

  // ── Transformations, in association order ──
  const transforms: HeifTransform[] = [];
  let curW = width!, curH = height!;
  for (const p of layers.flatMap((l) => l.props)) {
    if (p.type === 'clap') {
      const frac = (o: number, signed: boolean) => (signed ? i32(o) : u32(o)) / u32(o + 4);
      const w = Math.round(frac(p.body, false)), h = Math.round(frac(p.body + 8, false));
      const x = Math.round((curW - w) / 2 + frac(p.body + 16, true));
      const y = Math.round((curH - h) / 2 + frac(p.body + 24, true));
      if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > curW || y + h > curH) fail('crop outside the picture');
      transforms.push({ type: 'crop', x, y, width: w, height: h });
      curW = w; curH = h;
    } else if (p.type === 'irot') {
      const angle = ((u8(p.body) & 3) * 90) as 0 | 90 | 180 | 270;
      if (angle) transforms.push({ type: 'rotate', angle });
      if (angle === 90 || angle === 270) [curW, curH] = [curH, curW];
    } else if (p.type === 'imir') {
      transforms.push({ type: 'mirror', flip: (u8(p.body) & 1) === 0 ? 'top-bottom' : 'left-right' });
    }
  }

  let colour: HeifColour | null = null;
  const colrs = [...primary.props, ...image.props, ...first.props].filter((p) => p.type === 'colr');
  for (const colr of colrs) {
    if (fourcc(colr.body) !== 'nclx') continue;
    colour = { primaries: u16(colr.body + 4), transfer: u16(colr.body + 6), matrix: u16(colr.body + 8), fullRange: (u8(colr.body + 10) & 0x80) !== 0 };
    break;
  }

  // No VUI, or one past what hevcVuiColour walks: limited range and nothing
  // specified, as H.265 E.3.1 defines an absent video_signal_type.
  colour ??= hevcVuiColour(hvcC) ?? { primaries: 2, transfer: 2, matrix: 2, fullRange: false };

  return { width: width!, height: height!, tileWidth, tileHeight, tiles, hvcC, codec: hevcCodecString(hvcC), transforms, colour };
}

/** The colour description of the HEVC bitstream itself: the `vui_parameters`
 *  of the sequence parameter set inside `hvcC` (ITU-T H.265 7.3.2.2, E.2.1).
 *
 *  Chrome's decoder does not apply it (measured 2026-11-08: an iPhone's tiles
 *  say BT.601 full range, Chrome drew them as BT.709 limited range, every
 *  value up to 20/255 off; given explicitly, they match libheif to 0.08 on
 *  average). So it is read here and handed over in the decoder's config.
 *
 *  Walked as CrabbyAvif walks it (webmproject/CrabbyAvif, src/parser/hevc.rs,
 *  compared element by element on 2026-11-08).
 *
 *  `matrix`/`primaries`/`transfer` are 2 ("unspecified") when the stream has
 *  no colour description. Null when there is no SPS, no VUI, or a structure
 *  this reader refuses (it gives up rather than guess). */
export function hevcVuiColour(hvcC: Uint8Array): HeifColour | null {
  // hvcC: 22 bytes of header, then arrays of NAL units.
  if (hvcC.length < 23) return null;
  let o = 22;
  const arrays = hvcC[o++]!;
  let sps: Uint8Array | null = null;
  for (let a = 0; a < arrays && o + 3 <= hvcC.length; a++) {
    const type = hvcC[o]! & 0x3f;
    const n = (hvcC[o + 1]! << 8) | hvcC[o + 2]!;
    o += 3;
    for (let k = 0; k < n && o + 2 <= hvcC.length; k++) {
      const len = (hvcC[o]! << 8) | hvcC[o + 1]!;
      o += 2;
      if (type === 33 && !sps) sps = hvcC.subarray(o, o + len);
      o += len;
    }
  }
  if (!sps || sps.length < 4) return null;

  // The RBSP: the 2-byte NAL header off, emulation prevention bytes out.
  const rbsp: number[] = [];
  for (let i = 2; i < sps.length; i++) {
    if (i >= 4 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    rbsp.push(sps[i]!);
  }
  let bit = 0;
  const u = (n: number): number => {
    let x = 0;
    for (let i = 0; i < n; i++, bit++) {
      const byte = rbsp[bit >> 3];
      if (byte === undefined) throw new RangeError('SPS truncated');
      x = x * 2 + ((byte >> (7 - (bit & 7))) & 1);
    }
    return x;
  };
  const ue = (): number => {
    let zeros = 0;
    while (u(1) === 0) if (++zeros > 31) throw new RangeError('bad ue');
    return zeros ? (2 ** zeros - 1) + u(zeros) : 0;
  };

  try {
    u(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = u(3);
    u(1);
    // profile_tier_level(1, maxSubLayersMinus1)
    u(96);
    const subProfile: boolean[] = [], subLevel: boolean[] = [];
    for (let i = 0; i < maxSubLayersMinus1; i++) { subProfile.push(u(1) === 1); subLevel.push(u(1) === 1); }
    if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) u(2);
    for (let i = 0; i < maxSubLayersMinus1; i++) { if (subProfile[i]) u(88); if (subLevel[i]) u(8); }
    ue(); // sps_seq_parameter_set_id
    if (ue() === 3) u(1); // chroma_format_idc, separate_colour_plane_flag
    ue(); ue(); // pic width, height
    if (u(1)) { ue(); ue(); ue(); ue(); } // conformance window
    ue(); ue(); // bit depths
    const log2MaxPocLsb = ue() + 4;
    const orderingAll = u(1);
    for (let i = orderingAll ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) { ue(); ue(); ue(); }
    ue(); ue(); ue(); ue(); ue(); ue(); // block sizes, transform depths
    if (u(1) && u(1)) { // scaling_list_enabled_flag, sps_scaling_list_data_present_flag
      for (let size = 0; size < 4; size++) {
        for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
          if (!u(1)) { ue(); continue; } // pred mode: delta
          const coefs = Math.min(64, 1 << (4 + (size << 1)));
          if (size > 1) ue(); // dc coef (se, same length)
          for (let i = 0; i < coefs; i++) ue(); // deltas (se)
        }
      }
    }
    u(1); u(1); // amp, sample adaptive offset
    if (u(1)) { u(4); u(4); ue(); ue(); u(1); } // pcm
    // st_ref_pic_set(i) (7.3.7): a still has no use for them, but encoders
    // write them anyway (an iPhone's SPS has one).
    const sets = ue();
    if (sets > 64) return null;
    const deltaPocs: number[] = [];
    for (let i = 0; i < sets; i++) {
      if (i > 0 && u(1)) { // inter_ref_pic_set_prediction_flag: from set i - 1
        u(1); ue(); // delta_rps_sign, abs_delta_rps_minus1
        let count = 0;
        for (let j = 0; j <= deltaPocs[i - 1]!; j++) {
          const used = u(1) === 1;
          if (used || u(1) === 1) count++; // use_delta_flag, inferred 1 when used
        }
        deltaPocs.push(count);
      } else {
        const negative = ue(), positive = ue();
        if (negative + positive > 32) return null;
        for (let j = 0; j < negative + positive; j++) { ue(); u(1); }
        deltaPocs.push(negative + positive);
      }
    }
    if (u(1)) { // long_term_ref_pics_present_flag
      const n = ue();
      for (let i = 0; i < n; i++) { u(log2MaxPocLsb); u(1); }
    }
    u(1); u(1); // temporal mvp, strong intra smoothing
    if (!u(1)) return null; // vui_parameters_present_flag
    if (u(1) && u(8) === 255) u(32); // aspect ratio, extended SAR
    if (u(1)) u(1); // overscan
    // No video_signal_type: the standard's defaults (E.3.1).
    if (!u(1)) return { primaries: 2, transfer: 2, matrix: 2, fullRange: false };
    u(3); // video_format
    const fullRange = u(1) === 1;
    if (!u(1)) return { primaries: 2, transfer: 2, matrix: 2, fullRange };
    return { primaries: u(8), transfer: u(8), matrix: u(8), fullRange };
  } catch {
    return null;
  }
}

/** `hvc1.<profile>.<compatibility>.<tier><level>.<constraints>`, as WebCodecs
 *  (and ISO/IEC 14496-15 annex E) spell it from an `hvcC` record. */
export function hevcCodecString(hvcC: Uint8Array): string {
  if (hvcC.length < 13) throw new Error('HEIF: hvcC too short');
  const b = hvcC[1]!;
  const space = ['', 'A', 'B', 'C'][b >> 6]!;
  const tier = (b >> 5) & 1 ? 'H' : 'L';
  const profile = b & 31;
  let flags = ((hvcC[2]! << 24) | (hvcC[3]! << 16) | (hvcC[4]! << 8) | hvcC[5]!) >>> 0;
  let reversed = 0;
  for (let i = 0; i < 32; i++) { reversed = ((reversed << 1) | (flags & 1)) >>> 0; flags >>>= 1; }
  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  return `hvc1.${space}${profile}.${reversed.toString(16).toUpperCase()}.${tier}${hvcC[12]}`
    + constraints.map((c) => '.' + c.toString(16).toUpperCase()).join('');
}
