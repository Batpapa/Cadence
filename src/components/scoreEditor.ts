// ── The score viewer's text box under the audio sync (N3b, 2026-11-23) ──────
// Apart from syncedScore.tsx, which the viewer does not load until a score is
// followed: the viewer marks its own box with these, and seeks from it.

/** Characters [from, to) of the ABC text. */
export type CharRange = [number, number];

/** What the text face marks — the note heard, the region's first and last
 *  notes — in `text`, the version as drawn (bareScore). */
export interface TextMarks { text: string; cur: CharRange | null; in: CharRange | null; out: CharRange | null }

/** The score viewer's text box, lent to the "both" face (N3b): written in
 *  there, and marked by its owner — its text is the version's own, not the
 *  one drawn (`rangeInSource`). `bind` hands it, while it is lent, the way to
 *  send the recording to a character of the drawn text — a click in the
 *  text, as a note pressed on the stave (2026-11-23, the user); null once
 *  it is taken back. */
export interface ScoreEditor {
  box: HTMLElement;
  mark: (marks: TextMarks) => void;
  bind: (seekAt: ((drawnAt: number) => void) | null) => void;
}

/** Each line of `drawn` against the line of `source` just like it — the next
 *  one, `drawn` being `source` with whole lines taken out (bareScore and
 *  stripForRender take out lines, nothing else; the viewer's box holds the
 *  version but its `X:` line, which matches nothing). Lines' starts on both
 *  sides. */
function matchLines(drawn: string, source: string) {
  const src = source.split('\n');
  const srcStart: number[] = [];
  for (let i = 0, at = 0; i < src.length; i++) { srcStart.push(at); at += src[i]!.length + 1; }
  const lines = drawn.split('\n');
  const starts: number[] = [];
  /** Each drawn line's start in `source`, or null. */
  const to: (number | null)[] = [];
  let i = 0;
  for (let j = 0, at = 0; j < lines.length; j++) {
    starts.push(at);
    at += lines[j]!.length + 1;
    let k = i;
    while (k < src.length && src[k] !== lines[j]) k++;
    if (k < src.length) { to.push(srcStart[k]!); i = k + 1; } else to.push(null);
  }
  return { starts, to, lengths: lines.map(l => l.length) };
}

/** Where a range of `drawn` falls in `source` (matchLines); a range on a line
 *  with no match maps nowhere. */
export function rangeInSource(drawn: string, source: string): (r: CharRange | null) => CharRange | null {
  const { starts, to } = matchLines(drawn, source);
  const at = (p: number): number | null => {
    let j = starts.length - 1;
    while (j > 0 && starts[j]! > p) j--;
    const base = to[j];
    return base === null || base === undefined ? null : base + p - starts[j]!;
  };
  return (r) => {
    if (!r) return null;
    const a = at(r[0]), b = at(r[1]);
    return a === null || b === null || b <= a ? null : [a, b];
  };
}

/** Where character `p` of `source` is in `drawn` — null on a line `drawn`
 *  does not have (a header line taken out, or one typed since). */
export function posInDrawn(drawn: string, source: string, p: number): number | null {
  const { starts, to, lengths } = matchLines(drawn, source);
  for (let j = 0; j < to.length; j++) {
    const base = to[j];
    if (base === null || base === undefined) continue;
    if (p >= base && p <= base + lengths[j]!) return starts[j]! + p - base;
  }
  return null;
}
