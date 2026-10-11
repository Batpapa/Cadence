// ── Hiding a selection in the notes editor (2026-10-11) ──────────────────────
// The notes' hidden text is `||like this||` (markdown.ts's spoiler extension),
// which nobody guesses: a button over the selection writes it instead. One
// button that goes both ways — a selection touching hidden text shows it,
// anything else hides it — so no one has to know which state they are in.
//
// Pure text in, one edit out: the caller applies it as a single replacement,
// which is what lets the browser's undo take it back in one step.

/** The same shape markdown.ts recognises: one line, non-greedy. */
const SPOILER = /\|\|([^\n]+?)\|\|/g;

/** One replacement of `text.slice(from, to)` by `insert`, and the selection to
 *  leave afterwards, in the NEW text's positions. */
export interface SpoilerEdit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

interface Span { start: number; end: number } // markers included

/** Hidden passages the selection touches — overlapping it by at least one
 *  character, markers included, so selecting just the inner text or the
 *  whole `||…||` both count. */
function touched(text: string, start: number, end: number): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(SPOILER)) {
    const s = m.index;
    const e = s + m[0].length;
    if (s < end && start < e) out.push({ start: s, end: e });
  }
  return out;
}

/** Whether the button would SHOW (true) or HIDE (false) this selection. */
export function selectionIsHidden(text: string, start: number, end: number): boolean {
  return start < end && touched(text, start, end).length > 0;
}

/** The edit the button makes, or null when there is nothing to do (an empty
 *  selection, or one of blanks only). */
export function toggleSpoiler(text: string, start: number, end: number): SpoilerEdit | null {
  if (start >= end) return null;
  const spans = touched(text, start, end);
  return spans.length > 0 ? reveal(text, start, end, spans) : hide(text, start, end);
}

/** Takes the markers off every hidden passage the selection touches. The
 *  selection ends up over what they held (and whatever else it covered). */
function reveal(text: string, start: number, end: number, spans: Span[]): SpoilerEdit {
  const from = Math.min(start, spans[0]!.start);
  const to = Math.max(end, spans[spans.length - 1]!.end);
  let insert = '';
  let at = from;
  for (const sp of spans) {
    insert += text.slice(at, sp.start) + text.slice(sp.start + 2, sp.end - 2);
    at = sp.end;
  }
  insert += text.slice(at, to);
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

/** Wraps the selection, line by line — the syntax holds on one line only, so a
 *  selection over three lines becomes three hidden passages. Blanks at either
 *  edge stay outside the markers (`|| answer ||` would show its spaces), and a
 *  line with nothing but blanks is left alone. */
function hide(text: string, start: number, end: number): SpoilerEdit | null {
  const lines = text.slice(start, end).split('\n');
  let any = false;
  const insert = lines.map(line => {
    const core = line.trim();
    if (!core) return line;
    any = true;
    const lead = line.slice(0, line.length - line.trimStart().length);
    const trail = line.slice(line.trimEnd().length);
    return `${lead}||${core}||${trail}`;
  }).join('\n');
  if (!any) return null;
  return { from: start, to: end, insert, selStart: start, selEnd: start + insert.length };
}
