// ── ABC → recognition contour, the way FolkFriend's index is built ────────────
// The tune index Cadence downloads (indexStore.ts) is built weekly by
// TomWyllie/folkfriend-app-data/build/: each setting's ABC goes through
// abc2midi 4.84 ("4.84 January 20 2023", the version its build.sh insists on)
// and the MIDI is quantised to one symbol per quaver by midi.py's
// `to_midi_contour`. This file is that chain, so that ABC from anywhere else (a
// user's own cards, other tune sources) gets contours of the very same kind as
// the index it is searched alongside.
//
// Measured 2026-11-15 against the live index (55 715 settings, abc2midi built
// to WebAssembly and run through this file's code path): 54 263 contours
// identical character for character. The other 1 452 are settings edited on
// TheSession after the index first converted them: the builder keeps one MIDI
// file per setting and never makes it again (`if not
// os.path.exists(midi_out_path)`), so the index holds the contour of an older
// ABC. Checked for 1 251 of them — the ABC of the 2024-10-14 index, or of a
// later quarterly one, gives exactly today's contour; the 201 left were
// created after October 2024 and would need the weekly snapshots. What the
// builder does with the current ABC is what this file does. ~1.2 ms a setting.
//
// vendor/abc2midi/abc2midi.wasm is abcMIDI (github.com/sshlien/abcmidi, tag
// 2023.01.21 = 4.84; GPL-2.0-or-later, compatible with Cadence's AGPL),
// compiled unchanged with wasi-sdk 34:
//   clang --target=wasm32-wasip1 --sysroot=<wasi-sdk>/share/wasi-sysroot \
//     -DANSILIBS -DHAVE_CONFIG_H -I. -O2 parseabc.c store.c genmidi.c \
//     midifile.c queues.c parser2.c stresspat.c music_utils.c -lm
// (MD5 4805bcab5f92efca3f8f70f47a17b05a). A native Windows build of the same
// source differs on the 5 settings ending a line on a decoration (`~`, `.`):
// abc2midi reads memory it never set there, and the WebAssembly build — like
// the Linux one the index comes from — reads what the index has.

import { WASI, File, OpenFile, PreopenDirectory, ConsoleStdout } from '@bjorn3/browser_wasi_shim';

/** string.ascii_letters[:48], midi.py's MIDI_MAP: MIDI 48 = 'a'. */
const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const MIDI_LOW = 48;
const MIDI_HIGH = 95;
/** abc2midi writes 480 ticks a crotchet; midi.py reads ticks as milliseconds at
 *  its 125 bpm (`ms_scale_factor` 1), so a quaver is 240 of them. */
const QUAVER_TICKS = 240;

/** One ABC text through abc2midi (the compiled vendor module, instantiated
 *  anew here), as the builder runs it (`-quiet -silent
 *  -NGUI`: no chord accompaniment), files in memory. Null when it wrote no
 *  MIDI. A fresh instance every call: abc2midi keeps its state in globals and
 *  ends on exit(). It reads a file here where the builder pipes stdin — the
 *  same contours either way (checked natively, 2 000 settings). */
export function abcToMidi(abc2midi: WebAssembly.Module, abc: string): Uint8Array | null {
  const dir = new PreopenDirectory('/w', new Map([['in.abc', new File(new TextEncoder().encode(abc))]]));
  const discard = new ConsoleStdout(() => {});
  // debug: false — the shim's default traces every call to the console.
  const wasi = new WASI(['abc2midi', '/w/in.abc', '-quiet', '-silent', '-NGUI', '-o', '/w/out.mid'], [],
    [new OpenFile(new File([])), discard, discard, dir], { debug: false });
  const instance = new WebAssembly.Instance(abc2midi, { wasi_snapshot_preview1: wasi.wasiImport });
  wasi.start(instance as WebAssembly.Instance & { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  const out = dir.dir.contents.get('out.mid');
  return out instanceof File ? out.data : null;
}

/** The ABC the builder hands abc2midi for an index-style setting: a header
 *  made up from its meter and mode, then its body without backslashes or CRs
 *  (`generate_midi_contour`). `L:1/8` since 2024-10-07 — TheSession writes
 *  every tune in quavers, and without it abc2midi takes 2/4 tunes in
 *  semiquavers, every polka twice too short. */
export function builderAbc(setting: { abc: string; meter: string; mode: string }): string {
  const header = ['X:1', 'T:', `M:${setting.meter.trim()}`, 'L:1/8', `K:${setting.mode.trim()}`];
  return header.concat(setting.abc.replace(/\\/g, '').replace(/\r/g, '').split('\n')).join('\n');
}

interface NoteEvent { type: 'on' | 'off'; time: number; note: number }

/** Note events of a standard MIDI file, track after track, each in order —
 *  the order py_midicsv lists them in, which is all midi.py reads. A note-on
 *  of velocity 0 stays a note-on, as py_midicsv names it `Note_on_c`. */
function noteEvents(midi: Uint8Array): NoteEvent[] {
  const view = new DataView(midi.buffer, midi.byteOffset, midi.byteLength);
  const tag = (at: number) => String.fromCharCode(midi[at]!, midi[at + 1]!, midi[at + 2]!, midi[at + 3]!);
  if (midi.length < 14 || tag(0) !== 'MThd') return [];
  const tracks = view.getUint16(10);
  let p = 8 + view.getUint32(4);
  const events: NoteEvent[] = [];
  for (let t = 0; t < tracks && p + 8 <= midi.length; t++) {
    const id = tag(p);
    const end = Math.min(midi.length, p + 8 + view.getUint32(p + 4));
    p += 8;
    if (id !== 'MTrk') { p = end; continue; }
    const vlq = () => { let v = 0, b: number; do { b = midi[p++]!; v = v * 128 + (b & 0x7f); } while (b & 0x80 && p < end); return v; };
    let time = 0, status = 0;
    while (p < end) {
      time += vlq();
      const b = midi[p]!;
      // The length read first: `p += vlq()` would add it to p as it was
      // before vlq moved it past the length bytes.
      if (b === 0xff) { p += 2; const len = vlq(); p += len; continue; }
      if (b === 0xf0 || b === 0xf7) { p++; const len = vlq(); p += len; continue; }
      if (b & 0x80) { status = b; p++; }
      const kind = status & 0xf0;
      const note = midi[p]!;
      p += kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      if (kind === 0x90) events.push({ type: 'on', time, note });
      else if (kind === 0x80) events.push({ type: 'off', time, note });
    }
    p = end;
  }
  return events;
}

/** midi.py's `rel_pitch`: folded into range with STRICT bounds, so the
 *  contour only ever uses 'b' to 'U'. */
function relPitch(pitch: number): number {
  while (pitch <= MIDI_LOW) pitch += 12;
  while (pitch >= MIDI_HIGH) pitch -= 12;
  return pitch - MIDI_LOW;
}

/** midi.py's `to_notes` then `to_midi_contour(tempo=125)`, line for line —
 *  quirks included, since the index has them: notes are taken at their
 *  note-off, a pitch already sounding is not restarted, a note shorter than a
 *  quaver still gets one and the notes after it are skipped until the music
 *  catches up, and a longer note that is not a whole number of quavers is
 *  rounded up when behind, down when ahead. */
export function midiContour(midi: Uint8Array): string {
  const sounding = new Map<number, number>();
  const notes: { start: number; end: number; pitch: number }[] = [];
  for (const e of noteEvents(midi)) {
    if (e.type === 'on') { if (!sounding.has(e.note)) sounding.set(e.note, e.time); continue; }
    const start = sounding.get(e.note);
    if (start === undefined) continue;
    sounding.delete(e.note);
    notes.push({ start, end: e.time, pitch: e.note });
  }
  let out = '';
  let music = 0, output = 0;
  const emit = (pitch: number, times: number) => { out += CONTOUR_CHARS[relPitch(pitch)]!.repeat(times); };
  for (const n of notes) {
    const duration = n.end - n.start;
    music += duration;
    if (music <= output) continue;
    const quavers = duration / QUAVER_TICKS;
    if (Number.isInteger(quavers)) { output += duration; emit(n.pitch, quavers); }
    else if (quavers < 1) { output += QUAVER_TICKS; emit(n.pitch, 1); }
    else {
      const k = music > output ? Math.ceil(quavers) : Math.floor(quavers);
      output += k * QUAVER_TICKS;
      emit(n.pitch, k);
    }
  }
  return out;
}

/** The contour of one ABC tune, null when abc2midi makes nothing of it. */
export function abcContour(abc2midi: WebAssembly.Module, abc: string): string | null {
  const midi = abcToMidi(abc2midi, abc);
  return midi ? midiContour(midi) : null;
}
