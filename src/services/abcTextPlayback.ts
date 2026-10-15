import { injectDefaultTempo, stripForRender } from './abcService';

// ── Playing the ABC face's text (2026-10-15) ────────────────────────────────
// The source face had no sound: editing a tune by ear meant switching to the
// stave to hear it (a TheSession user's request). Its player plays the text in
// the box as it stands — from the caret, or just the selection — and lights up
// each note in the text as it sounds. Nothing is drawn: the viewer's stave is
// the other face, and the live preview that once sat under the box was taken
// out at the user's request.
//
// Two problems are solved here, as pure functions, for the viewer to wire:
//  • abcjs is handed the text REWRITTEN (the version's `X:` line on top, `S:`
//    and `Z:` dropped, a `Q:` added — exactly what the stave is given), so a
//    position in what abcjs read is not a position in the box. `Segment`s map
//    one to the other.
//  • where to start and where to stop, from the caret or the selection, read
//    off abcjs's timing events (one per note per pass round the repeats).

/** A run of characters copied unchanged from the box into the source. Lines
 *  only, without their newline: the inserted `Q:` line goes right after the
 *  `K:` line's text, and a newline is never where a note is. */
interface Segment { src: number; body: number; len: number }

export interface PlayableSource {
  /** What abcjs is given — byte for byte what the stave would be given. */
  source: string;
  segments: Segment[];
}

/** The box's text as abcjs is to read it: under the version's `X:` line,
 *  without any other `X:` (see withXLine in the viewer), and through the two
 *  rewrites the stave's source goes through. */
export function playableSource(xLine: string, body: string): PlayableSource {
  const segments: Segment[] = [];
  const kept: string[] = [];
  let src = xLine ? xLine.length + 1 : 0;
  let off = 0;
  for (const line of body.split('\n')) {
    if (!/^X:/.test(line) && !/^[SZ]:/.test(line)) {
      segments.push({ src, body: off, len: line.length });
      kept.push(line);
      src += line.length + 1;
    }
    off += line.length + 1;
  }
  // `X:` cannot be an S: or Z: line, so stripping it as well is a no-op —
  // done all the same, through the same function the stave uses.
  const stripped = stripForRender((xLine ? `${xLine}\n` : '') + kept.join('\n'));
  const source = injectDefaultTempo(stripped);
  if (source.length !== stripped.length) {
    // A `Q:` went in, at the first difference: everything after it moves on.
    let at = 0;
    while (at < stripped.length && stripped[at] === source[at]) at++;
    const shift = source.length - stripped.length;
    for (const s of segments) if (s.src >= at) s.src += shift;
  }
  return { source, segments };
}

/** Where a position of the source is in the box, or null for what abcjs read
 *  that the box does not hold (the `X:` line, an added `Q:`). */
export function bodyIndex(ps: PlayableSource, srcIndex: number): number | null {
  for (const s of ps.segments) {
    if (srcIndex >= s.src && srcIndex <= s.src + s.len) return s.body + (srcIndex - s.src);
  }
  return null;
}

/** Where a position of the box is in the source. A position in a line abcjs
 *  never sees (an `S:` line) moves on to the next line it does. */
export function sourceIndex(ps: PlayableSource, index: number): number {
  for (const s of ps.segments) {
    if (index <= s.body + s.len) return index < s.body ? s.src : s.src + (index - s.body);
  }
  const last = ps.segments[ps.segments.length - 1];
  return last ? last.src + last.len : 0;
}

/** The fields of abcjs's timing events read here. */
export interface TimingEvent {
  type: string;
  milliseconds: number;
  startCharArray?: number[];
  endCharArray?: number[];
}

const isNote = (ev: TimingEvent): ev is TimingEvent & { startCharArray: number[]; endCharArray: number[] } =>
  ev.type === 'event' && Array.isArray(ev.startCharArray) && ev.startCharArray.length > 0
  && Array.isArray(ev.endCharArray);

/** Whether a note event has a character in [from, to). */
function touches(ev: TimingEvent, from: number, to: number): boolean {
  if (!isNote(ev)) return false;
  return ev.startCharArray.some((start, i) => start < to && (ev.endCharArray[i] ?? start + 1) > from);
}

/** What to play: the event to start on, and — for a selection — what says the
 *  music has left it.
 *
 *  From the caret: the note it is in or just before, the FIRST time round —
 *  a caret is in the text, which does not say which pass. Past the last note,
 *  from the start. To the end.
 *
 *  A selection: from its first note in time, as the music flows while it
 *  stays inside — a whole `|: … :|` selected goes round twice — and where it
 *  leaves, on to `resumeInside`. Null when it holds no note. */
export function playPlan(
  events: readonly TimingEvent[], from: number, to: number | null,
): { start: TimingEvent; inside: ((ev: TimingEvent) => boolean) | null } | null {
  const notes = events.filter(isNote);
  if (notes.length === 0) return null;
  if (to !== null && to > from) {
    const first = notes.find(ev => touches(ev, from, to));
    return first ? { start: first, inside: (ev) => touches(ev, from, to) } : null;
  }
  // The earliest character, in the text, of a note that ends after the caret.
  let target = Infinity;
  for (const ev of notes) {
    ev.startCharArray.forEach((start, i) => {
      if ((ev.endCharArray[i] ?? start + 1) > from && start < target) target = start;
    });
  }
  const start = target === Infinity ? notes[0]! : notes.find(ev => ev.startCharArray.includes(target))!;
  return { start, inside: null };
}

/** Where a selection goes on once the music has left it — or null, where it
 *  ends. The next note in time that is inside AND further on in the text
 *  than anything played so far (`playedTo`).
 *
 *  A selection across a `:|` was the case (reported 2026-10-15: it stopped at
 *  the repeat). The repeat sends the music back out of the selection; what
 *  the reader selected goes on past the sign, which the music only reaches on
 *  the second time round — so the second time through what was already
 *  played is skipped, and it carries on where the text does. The same rule
 *  takes a first ending to the second, and ends a selection that lies inside
 *  a repeat after one pass: its second time round is no further on. */
export function resumeInside(
  events: readonly TimingEvent[], afterMs: number, playedTo: number, from: number, to: number,
): TimingEvent | null {
  return events.find(ev => ev.milliseconds > afterMs && touches(ev, from, to)
    && isNote(ev) && Math.max(...ev.startCharArray) > playedTo) ?? null;
}

/** Which time round an event is, among the events of the same note. */
export function passOf(events: readonly TimingEvent[], ev: TimingEvent): number {
  if (!isNote(ev)) return 0;
  const char = ev.startCharArray[0];
  let pass = 0;
  for (const e of events) {
    if (e === ev) return pass;
    if (isNote(e) && e.startCharArray[0] === char) pass++;
  }
  return 0;
}

/** The event of the note at `char` on its `pass`-th time round, or its last
 *  pass if there are fewer now — for picking up at the same place in a
 *  performance rebuilt at another speed or with another feel. */
export function eventAt(events: readonly TimingEvent[], char: number, pass: number): TimingEvent | null {
  const same = events.filter(e => isNote(e) && e.startCharArray[0] === char);
  return same[Math.min(pass, same.length - 1)] ?? null;
}

// ── Before anything plays: where it will start ─────────────────────────────
// The stave shows where play will begin with its cursor; the source face
// shows it in the text (2026-10-15). Worked out from abcjs's PARSE alone —
// every caret move asks, and engraving at each one would be far too dear —
// in text order, which is time order for the first time round.

/** A note (or a rest) of the parsed tune, as positions in the source. */
export interface ParsedNote { start: number; end: number }

/** The notes and rests of what abcjs.parseOnly returned, in text order. */
export function notesOf(tune: unknown): ParsedNote[] {
  const out: ParsedNote[] = [];
  const lines = (tune as { lines?: unknown[] } | null)?.lines;
  if (!Array.isArray(lines)) return out;
  for (const line of lines) {
    const staves = (line as { staff?: unknown[] }).staff;
    if (!Array.isArray(staves)) continue;
    for (const staff of staves) {
      const voices = (staff as { voices?: unknown[][] }).voices;
      if (!Array.isArray(voices)) continue;
      for (const voice of voices) {
        if (!Array.isArray(voice)) continue;
        for (const el of voice as { el_type?: string; startChar?: number; endChar?: number }[]) {
          if (el.el_type === 'note' && typeof el.startChar === 'number' && typeof el.endChar === 'number') {
            out.push({ start: el.startChar, end: el.endChar });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The note play would start on — the same rule as playPlan's: the note the
 *  caret is in or before (past the last, the first), or the first note of
 *  the selection (none, if it holds none). */
export function startNoteAt(notes: readonly ParsedNote[], from: number, to: number | null): ParsedNote | null {
  if (notes.length === 0) return null;
  if (to !== null && to > from) return notes.find(n => n.start < to && n.end > from) ?? null;
  return notes.find(n => n.end > from) ?? notes[0]!;
}

/** A range of the source as a range of the box, or null where the box does
 *  not hold it. */
export function boxRange(ps: PlayableSource, start: number, end: number): [number, number] | null {
  const a = bodyIndex(ps, start);
  const b = bodyIndex(ps, end);
  return a !== null && b !== null && b > a ? [a, b] : null;
}

/** The text ranges, in the box, of the note an event plays — one per voice. */
export function noteRanges(ps: PlayableSource, ev: TimingEvent): [number, number][] {
  if (!isNote(ev)) return [];
  const out: [number, number][] = [];
  ev.startCharArray.forEach((start, i) => {
    const a = bodyIndex(ps, start);
    const b = bodyIndex(ps, ev.endCharArray[i] ?? start + 1);
    if (a !== null && b !== null && b > a) out.push([a, b]);
  });
  return out;
}
