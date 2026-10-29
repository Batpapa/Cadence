// ── Where the lines of an engraved score end ─────────────────────────────────
//
// The score FOLLOWS THE LINES OF THE ABC, since 2026-10-24, the way TheSession
// draws it: whoever transcribed the tune wrote four bars to a line, a part
// starting on a line of its own, and that layout is how the tune is read. A
// line is cut only when it does not fit the width at a readable spacing, and
// then into equal shares of its bars — four bars become two and two on a phone.
//
// It replaced abcjs's `wrap: { preferredMeasuresPerLine }`, which ignored the
// ABC's lines and counted bars with `i % n` over the whole tune. What it counts
// are the segments between two bar lines, and two of those hold no music: the
// one before a `|:` that opens a line, and the empty one between `:|` and `|:`
// across a line end. Measured on Muireann's (thesession.org/tunes/1902,
// 2026-10-24): "four bars a line" came out as 3 / 4 / 3 / 4 at a desktop
// width — the `|:` counted as the first of the four — and lines of a single bar
// on a phone. Adrien's report the day before, with TheSession beside it.
//
// So nothing here counts a segment without notes as a bar: it rides along
// with the line it is on, and is never what a line is cut after.
//
// abcjs numbers "measures" exactly that way, and that numbering is what its
// `lineBreaks` option takes: per section (a run of music lines between two
// lines of text), the zero-based index of the bar line that ends each line.

/** Per section, per line of the ABC, per bar line: whether the segment it
 *  closes holds any note or rest. */
export type SourceMeasures = boolean[][][];

/** What abcjs measures of a section before laying it out: where the music
 *  starts after the clef and key, and each segment's natural width — the
 *  same at any staff width, which is what lets it be measured once. */
export interface MeasuredSection {
  left: number;
  measureWidths: number[];
}

interface ParsedVoiceElement {
  el_type?: string;
  /** A note's, in whole notes: a quaver is 0.125. */
  duration?: unknown;
  tripletMultiplier?: number;
  endTriplet?: boolean;
}
interface ParsedTune {
  lines: { staff?: { voices?: ParsedVoiceElement[][] }[] }[];
}

/** Per section, flat as abcjs measures it: how many quavers of time each
 *  segment between two bar lines holds, rests included, a tuplet at its played
 *  length. Cut the same way as `sourceMeasures`. */
export function sourceQuavers(tune: ParsedTune): number[][] {
  const sections: number[][] = [];
  let current: number[] | null = null;
  let quavers = 0;
  for (const line of tune.lines) {
    const voice = line.staff?.[0]?.voices?.[0];
    if (!voice) { current = null; continue; }
    if (!current) { current = []; sections.push(current); quavers = 0; }
    let tuplet = 1;
    for (const el of voice) {
      if (el.el_type === 'note') {
        if (el.tripletMultiplier) tuplet = el.tripletMultiplier;
        quavers += (typeof el.duration === 'number' ? el.duration / 0.125 : 0) * tuplet;
        if (el.endTriplet) tuplet = 1;
      } else if (el.el_type === 'bar') { current.push(quavers); quavers = 0; }
    }
  }
  return sections;
}

/** The bar structure of a parsed tune, lines as written. Sections are split at
 *  any line without a staff — the same rule abcjs measures by. Notes after a
 *  line's last bar line belong to the segment the next line closes. */
export function sourceMeasures(tune: ParsedTune): SourceMeasures {
  const sections: SourceMeasures = [];
  let current: boolean[][] | null = null;
  let hasNotes = false;
  for (const line of tune.lines) {
    const voice = line.staff?.[0]?.voices?.[0];
    if (!voice) { current = null; continue; }
    if (!current) { current = []; sections.push(current); hasNotes = false; }
    const closes: boolean[] = [];
    for (const el of voice) {
      if (el.el_type === 'note') hasNotes = true;
      else if (el.el_type === 'bar') { closes.push(hasNotes); hasNotes = false; }
    }
    current.push(closes);
  }
  return sections;
}

/** abcjs's `lineBreaks`, or null when the measured widths do not line up with
 *  the structure — then the caller keeps abcjs's own wrapping rather than
 *  break lines in the wrong places. `minSpacing` is how much room a bar needs
 *  beyond its natural width to stay readable (abcjs's own `wrap.minSpacing`). */
export function scoreLineBreaks(
  structure: SourceMeasures,
  measured: MeasuredSection[],
  staffwidth: number,
  minSpacing: number,
): number[][] | null {
  if (structure.length !== measured.length) return null;
  const out: number[][] = [];
  for (let s = 0; s < structure.length; s++) {
    const breaks = sectionBreaks(structure[s]!, measured[s]!, (staffwidth - measured[s]!.left) / minSpacing);
    if (!breaks) return null;
    out.push(breaks);
  }
  return out;
}

function sectionBreaks(lines: boolean[][], m: MeasuredSection, maxWidth: number): number[] | null {
  const count = lines.reduce((n, l) => n + l.length, 0);
  if (count !== m.measureWidths.length) return null;
  const breaks: number[] = [];
  let start = 0; // first segment of the line being built
  let first = 0; // first segment of the ABC line being read
  for (const line of lines) {
    const last = first + line.length - 1;
    // A line with no music in it — a lone `|:` — joins the next one.
    if (line.some(Boolean)) {
      breaks.push(...splitLine(line, first, start, last, m.measureWidths, maxWidth));
      start = last + 1;
    }
    first = last + 1;
  }
  // The end of the section ends a line anyway; a break there would draw an
  // empty one after it.
  if (breaks[breaks.length - 1] === count - 1) breaks.pop();
  return breaks;
}

/** The ends of the lines one ABC line is drawn on: itself when it fits, else
 *  the fewest equal shares of its bars that do — the longer shares first, so
 *  a pickup or a second ending makes the first or the last one longer.
 *
 *  Never fewer than two bars to a share: two bars is the smallest phrase this
 *  music is made of, and a narrow phone that cannot fit even two at the
 *  readable spacing gets them squeezed, as abcjs did before, rather than one
 *  bar a line. Measured on Muireann's: at a 327 px box two bars fit, but the
 *  first line, which carries the time signature, misses by a few units on
 *  anything narrower — and fell to a bar a line.
 *
 *  `start` may lie before `first`: segments without music carried over from
 *  the line above. */
function splitLine(line: boolean[], first: number, start: number, last: number, widths: number[], maxWidth: number): number[] {
  const width = (a: number, b: number) => { let w = 0; for (let i = a; i <= b; i++) w += widths[i]!; return w; };
  if (width(start, last) <= maxWidth) return [last];
  const bars: number[] = [];
  line.forEach((has, i) => { if (has) bars.push(first + i); });
  const most = Math.ceil(bars.length / 2);
  for (let k = 2; k <= most; k++) {
    const ends = shareEnds(bars, k, last);
    let from = start;
    let fits = true;
    for (const end of ends) {
      if (width(from, end) > maxWidth) { fits = false; break; }
      from = end + 1;
    }
    if (fits) return ends;
  }
  return most >= 2 ? shareEnds(bars, most, last) : [last];
}

/** The widest staff worth drawing these lines on. abcjs spreads every line
 *  across the whole staff, so with the ABC's four bars to a line a wide box
 *  drew them unreadably far apart — measured 2026-10-28, a quaver 88 px wide
 *  on a 1900 px full screen. A line is given `maxQuaver` per quaver of time it
 *  holds — the QUAVER is what reads, the user said, not the room an ornament
 *  or a triplet takes — or, when that is too tight for what it carries, the
 *  `minSpacing` it was broken at. The widest line decides, so every line keeps
 *  the same width. In abcjs's units, which are layout pixels: the app's zoom
 *  scales the cap with everything else. */
export function cappedStaffWidth(
  measured: MeasuredSection[], quavers: number[][], lineBreaks: number[][],
  staffwidth: number, maxQuaver: number, minSpacing: number,
): number {
  let widest = 0;
  measured.forEach((m, s) => {
    let from = 0;
    // The section's end closes its last line (sectionBreaks leaves it out).
    for (const end of [...(lineBreaks[s] ?? []), m.measureWidths.length - 1]) {
      let w = 0, q = 0;
      for (let i = from; i <= end; i++) { w += m.measureWidths[i]!; q += quavers[s]?.[i] ?? 0; }
      widest = Math.max(widest, m.left + Math.max(q * maxQuaver, w * minSpacing));
      from = end + 1;
    }
  });
  return widest > 0 ? Math.min(staffwidth, Math.ceil(widest)) : staffwidth;
}

// ── Drawing ──────────────────────────────────────────────────────────────────
// Every full score of the app is drawn by `engraveScore`: the score viewer
// (fileViewer.ts) and the score that follows a recording (syncedScore.tsx).

/** How much room a bar is given beyond its natural width — abcjs's own unit,
 *  1 being notes as close as it will set them — before a line of the ABC is
 *  judged too long for the width. Today's phone layout, two bars to a line at
 *  a 348 px box, ran at about 1.45; 1.3 keeps a line of four jig bars whole
 *  from a ~520 px staff up, and two on a 360 px phone. */
const MIN_BAR_SPACING = 1.3;

/** The most room a quaver of time is given, in layout pixels. */
const MAX_QUAVER_WIDTH = 26;

/** abcjs's own wrapping: only what measures the bars now, and what draws a
 *  score whose bars could not be matched to its lines. */
const FALLBACK_WRAP = {
  minSpacing: 1.8, maxSpacing: 2.7,
  // Required by abcjs's types, and 0 is how its code reads "none"
  // (wrap_lines.js: a falsy value skips the fixed-count attempt).
  preferredMeasuresPerLine: 0,
};

/** A source's bar structure and abcjs's measurement of it. The widths do not
 *  depend on the staff width, so one measurement serves every redraw of the
 *  same source — a resize, the paper — at the cost of a single drawing. */
export interface ScoreMeasure {
  key: string;
  structure: SourceMeasures;
  quavers: number[][];
  sections: MeasuredSection[];
}

/** Draws a score with its lines where the ABC has them, on a staff no wider
 *  than they read well at (`cappedStaffWidth`; the box centres a narrower
 *  drawing, `.abc-score-paper svg`).
 *
 *  abcjs measures the natural width of each bar only on its way to wrapping a
 *  tune, so a source seen for the first time is drawn once WITH `wrap`, kept
 *  for its measurements (`tune.explanation`), then drawn again with the line
 *  breaks worked out from them. `cache` holds the last measurement. */
export function engraveScore(
  abcjs: typeof import('abcjs'), target: string | HTMLElement, source: string, options: Record<string, unknown>,
  cache: { measure: ScoreMeasure | null },
): ReturnType<typeof abcjs.renderAbc> {
  // The transposition is in the key: accidentals change how wide a bar is.
  const key = `${String(options.visualTranspose)}\n${source}`;
  let measure = cache.measure?.key === key ? cache.measure : null;
  if (!measure) {
    const drawn = abcjs.renderAbc(target, source, { ...options, wrap: FALLBACK_WRAP });
    const explanation = (drawn[0] as { explanation?: unknown } | undefined)?.explanation;
    // A string when abcjs gave up wrapping ("narrower than the margin").
    if (!Array.isArray(explanation)) { cache.measure = null; return drawn; }
    const parsed = abcjs.parseOnly(source)[0]!;
    measure = cache.measure = {
      key,
      structure: sourceMeasures(parsed),
      quavers: sourceQuavers(parsed),
      sections: (explanation as { widths: MeasuredSection }[]).map(e => ({ left: e.widths.left, measureWidths: e.widths.measureWidths })),
    };
  }
  const staffwidth = options.staffwidth as number;
  const lineBreaks = scoreLineBreaks(measure.structure, measure.sections, staffwidth, MIN_BAR_SPACING);
  if (!lineBreaks) return abcjs.renderAbc(target, source, { ...options, wrap: FALLBACK_WRAP });
  // One array PER SECTION, which is what abcjs's code reads (wrap_lines.js,
  // findLineBreaks) and what its own wrapping hands its parser; its type
  // declaration says a flat `number[]`, which it is not.
  return abcjs.renderAbc(target, source, {
    ...options,
    staffwidth: cappedStaffWidth(measure.sections, measure.quavers, lineBreaks, staffwidth, MAX_QUAVER_WIDTH, MIN_BAR_SPACING),
    lineBreaks: lineBreaks as unknown as number[],
  });
}

/** Cuts `bars` into `k` shares, the longer ones first, and returns where each
 *  line ends: after its last bar — so a segment without music that follows
 *  (the `|:` of the next part) opens the next line — except the last share,
 *  which takes everything to the end of the ABC line. */
function shareEnds(bars: number[], k: number, last: number): number[] {
  const ends: number[] = [];
  const base = Math.floor(bars.length / k);
  const longer = bars.length % k;
  let taken = 0;
  for (let i = 0; i < k - 1; i++) {
    taken += base + (i < longer ? 1 : 0);
    ends.push(bars[taken - 1]!);
  }
  ends.push(last);
  return ends;
}
