import { useEffect, useRef, useState } from 'preact/hooks';
import type { AudioEngine } from './audioEngine';
import { positionAt, slotNotes, alignContour, quaverToMs, msToQuaver, type FollowResult } from '../session/scoreFollow';
import { abcPaper, ABC_PAPERS } from '../services/abcService';
import { engraveScore, type ScoreMeasure } from '../services/abcLineBreaks';
import { ENGRAVE_HYSTERESIS, engraveOptions, engraveWidthOf, cropToInk } from './scoreEngraving';
import { getZoom } from '../services/zoomService';
import { appState } from '../store';
import { WakeLockManager } from '../session/audio/capture';

// ── A score that follows a recording ─────────────────────────────────────────
// Drawn above the audio player's waveform when the player is given a score
// and an alignment of it (audioPlayer.tsx, `score`). Knows nothing of where
// either came from: an analysis's detection today (ScoreFollowView.tsx), an
// audio attachment aligned with an ABC tomorrow (the user's plan, 2026-10-28).
//
// The alignment (session/scoreFollow.ts) says which quaver of the score is
// heard at each instant of the player's time; `alignContour` says where that
// quaver is drawn, matching the score's pitches to the drawn notes' — one to
// one since the score aligned is read off this very drawing (scoreContour,
// 2026-10-29); kept for any score that is not. Positions are in the recording's time, so a tempo change
// costs nothing; the player's transposition is passed in and the score is
// drawn in that key. The player's region is drawn too, in the score viewer's
// colours for a passage's bounds. abcjs's own timer is never started.

interface NoteEvent {
  milliseconds: number; millisecondsPerMeasure: number;
  left: number; top: number; height: number; elements?: Element[][];
  midiPitches?: { pitch: number }[];
  /** Where the note is in the ABC text — every note of a chord. */
  startCharArray?: number[]; endCharArray?: number[];
}
interface Timeline {
  events: NoteEvent[]; lastMoment: number;
  /** The drawing's quaver slots, with their pitches (slotNotes). */
  notes: { ms: number[]; pitch: (number | undefined)[] };
  /** The moment of each quaver of the alignment's score, for `slotsFor`. */
  slots: number[]; slotsFor: FollowResult | null;
}

/** The moment of each quaver of `f`'s score on the drawing: its pitches
 *  matched to the drawn notes, else the slots stretched (quaverToMs). Kept
 *  until the alignment or the drawing changes. */
function slotsOf(tl: Timeline, f: FollowResult): number[] {
  if (tl.slotsFor !== f) {
    tl.slots = alignContour(f.pitches, tl.notes) ?? tl.notes.ms;
    tl.slotsFor = f;
  }
  return tl.slots;
}

/** The drawn notes of an engraved tune on abcjs's timeline: its events, and
 *  the quaver slots they fill with the pitch drawn there (slotNotes). What the
 *  cursor walks — and what the alignment reads (scoreContour). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function timelineOf(abcjs: typeof import('abcjs'), visual: any, meter: string): Timeline {
  // What gives the timeline's events their pitches (`midiPitches`). No sound
  // is made: it only builds the note sequence.
  try { visual.setUpAudio(); } catch { /* no pitches: the slots are then stretched */ }
  const timer = new abcjs.TimingCallbacks(visual, {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = (timer.noteTimings as any[]).filter(e => e.type === 'event') as NoteEvent[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastMoment = (timer as any).lastMoment as number;
  const isNote = (ev: NoteEvent) => (ev.elements ?? []).some(g => g.some(el => el.classList?.contains('abcjs-note')));
  const notes = slotNotes(events.map(ev => ({
    milliseconds: ev.milliseconds, millisecondsPerMeasure: ev.millisecondsPerMeasure, isNote: isNote(ev),
    pitch: ev.midiPitches?.length ? Math.min(...ev.midiPitches.map(p => p.pitch)) : undefined,
  })), lastMoment, meter);
  return { events, lastMoment, notes, slots: notes.ms, slotsFor: null };
}

/** The score to align a recording on, from the ABC that is drawn: one MIDI
 *  pitch per quaver, repeats played out as abcjs plays them (2026-10-29). It
 *  was the recognition index's contour alone, which the index builder unfolds
 *  its own way — setting 16960 of Mick O'Connor's came out A A B for a tune
 *  played A A B B, and the cursor lost a part every pass (the user). The two
 *  now compete, the better fit kept (scoreFollowWorker.ts); with this one any
 *  version can be followed, in the index or not, and its quavers are the
 *  cursor's slots one to one. A tied note's continuation carries no pitch: it
 *  keeps the one before. Null when there are no notes. */
export async function scoreContour(abc: string, meter: string): Promise<number[] | null> {
  const abcjs = await import('abcjs');
  // Engraved out of sight ("*"): the timeline needs a drawing, not a screen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visual: any = abcjs.renderAbc('*', abc, { add_classes: true })[0];
  if (!visual) return null;
  const { pitch } = timelineOf(abcjs, visual, meter).notes;
  const first = pitch.find(p => p !== undefined);
  if (first === undefined || pitch.length < 2) return null;
  let last = first;
  return pitch.map(p => (last = p ?? last));
}

/** Characters [from, to) of the ABC text. */
type CharRange = [number, number];

/** Where an event's notes are in the text — all of a chord, first to last. */
function charRange(ev: NoteEvent | null): CharRange | null {
  const starts = ev?.startCharArray ?? [], ends = ev?.endCharArray ?? [];
  if (!starts.length || !ends.length) return null;
  const r: CharRange = [Math.min(...starts), Math.max(...ends)];
  return r[1] > r[0] ? r : null;
}

/** abcjs ends a note after the spaces that follow it: marked, "A3 " reads as
 *  a note and a gap (the viewer's trimNote). */
function trimmed(text: string, r: CharRange | null): CharRange | null {
  if (!r) return null;
  let b = r[1];
  while (b > r[0] && /\s/.test(text[b - 1]!)) b--;
  return b > r[0] ? [r[0], b] : null;
}

/** ← / → step. */
const SKIP_S = 5;

/** A line drawn on the score's SVG, made if it is not there yet. */
function svgLine(svg: SVGSVGElement, cls: string): SVGLineElement {
  let line = svg.querySelector(`.${cls}`) as SVGLineElement | null;
  if (!line) {
    line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', cls);
    svg.appendChild(line);
  }
  return line;
}

/** A small square with a number, drawn as the waveform draws a pass's
 *  number: against the top of its line, on its right — on its left with
 *  `left`, an end's, so it sits inside what it closes. Made if it is not
 *  there yet; `place` puts it and writes its number, null hides it. */
function svgBadge(svg: SVGSVGElement, cls: string): (at: { x: number; top: number; label: string; left?: boolean } | null) => void {
  const NS = 'http://www.w3.org/2000/svg';
  let g = svg.querySelector(`.${cls}`) as SVGGElement | null;
  if (!g) {
    g = document.createElementNS(NS, 'g');
    g.setAttribute('class', cls);
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('rx', '2');
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    g.append(rect, text);
    svg.appendChild(g);
  }
  const rect = g.querySelector('rect')!, text = g.querySelector('text')!;
  return (at) => {
    if (!at) { g!.setAttribute('visibility', 'hidden'); return; }
    const w = 8 + 7 * at.label.length, h = 15;
    g!.setAttribute('visibility', 'visible');
    const x = at.left ? at.x - 1 - w : at.x + 1;
    rect.setAttribute('x', String(x)); rect.setAttribute('y', String(at.top));
    rect.setAttribute('width', String(w)); rect.setAttribute('height', String(h));
    text.setAttribute('x', String(x + w / 2)); text.setAttribute('y', String(at.top + h / 2));
    text.textContent = at.label;
  };
}

export interface SyncedScoreProps {
  /** A whole ABC tune. */
  abc: string;
  /** Its meter as the recognition index gives it ("6/8"). */
  meter: string;
  /** Null until the alignment is in: the score shows, the cursor waits. */
  follow: FollowResult | null;
  engine: AudioEngine | null;
  region: { start: number; end: number } | null;
  /** Semitones the score is drawn up or down — the player's transposition. */
  transpose: number;
  playing: boolean;
  /** The score box's height cap (CSS). */
  maxHeight: string;
  /** The stave, or the ABC text it is drawn from, read-only, the note heard
   *  lit in it (the user, 2026-10-28) — the score viewer's two faces. */
  face?: 'sheet' | 'text';
  /** Buttons over the paper's top right corner, as the score viewer has its
   *  full page there; the paper leaves them their room. */
  tools?: preact.ComponentChildren;
}

export function SyncedScore({ abc, meter, follow, engine, region, transpose, playing, maxHeight, face = 'sheet', tools }: SyncedScoreProps) {
  const paperRef = useRef<HTMLDivElement>(null);
  /** What abcjs draws into, inside the paper — never the paper itself: abcjs
   *  writes `overflow: hidden` and a height on its target, and the score,
   *  drawn into the box that scrolls, could no longer be scrolled by hand —
   *  only by the cursor, which scrolls from code (2026-10-29, the user). */
  const drawingRef = useRef<HTMLDivElement>(null);
  // The text face: the ABC with the score viewer's own marks on its source
  // face (fileViewer.ts's paintText) — the cursor's bar against the note
  // heard, the region as [ … ] in the bounds' colours (2026-10-29, the user:
  // not a tint of its own). Rewritten only when a mark moves. Plain DOM,
  // never Preact's: it moves at the animation frame's pace.
  const textRef = useRef<HTMLPreElement>(null);
  /** The marks last drawn, as a key; and the region's notes in the text. */
  const textDrawn = useRef<string>('');
  const textBounds = useRef<{ in: CharRange | null; out: CharRange | null }>({ in: null, out: null });
  const faceRef = useRef(face);
  faceRef.current = face;
  // The frame loop is made once: it reads the text through this.
  const abcRef = useRef(abc);
  abcRef.current = abc;
  const timeline = useRef<Timeline | null>(null);
  /** The bars' natural widths, measured once per source and key. */
  const measure = useRef<{ measure: ScoreMeasure | null }>({ measure: null });
  const lit = useRef<Element[]>([]);
  const lastTop = useRef<number | null>(null);
  // What the animation frame reads: never a render's copy.
  const live = useRef({ follow, engine, region });
  live.current = { follow, engine, region };
  /** Forces the next frame to redraw everything. */
  const dirty = useRef(true);
  const colours = ABC_PAPERS[abcPaper(appState.value)];
  const shift = Math.round(transpose);

  useEffect(() => { dirty.current = true; }, [follow, region?.start, region?.end, face]);

  // The text face: the whole text, nothing marked, until the frame marks it.
  useEffect(() => {
    const pre = textRef.current;
    if (!pre) return;
    pre.replaceChildren(document.createTextNode(abc));
    textDrawn.current = '';
    dirty.current = true;
  }, [abc, face]);

  // The score box's width, for engraving: the dialog is resizable (full page,
  // a phone turned). Only real changes count — a scrollbar coming and going is
  // a few pixels, and re-engraving for it could chase its own tail.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    // Read at the next frame, not in the observer: a width set there redraws
    // the score inside the observation, and the browser reported it as a
    // loop on every resize of the window (2026-10-29, the user).
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Hidden behind the text face: kept as it was drawn, the text's
        // cursor reads its timeline.
        if (paper.clientWidth === 0) return;
        const w = engraveWidthOf(paper);
        setWidth(prev => (Math.abs(w - prev) >= ENGRAVE_HYSTERESIS ? w : prev));
      });
    });
    ro.observe(paper);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // Engraving: at the box's width, in the paper's ink, in the key the sound is
  // transposed to — again whenever one of those changes.
  useEffect(() => {
    if (!width) return;
    let cancelled = false;
    void import('abcjs').then((abcjs) => {
      const drawing = drawingRef.current;
      if (cancelled || !drawing) return;
      lit.current = [];
      lastTop.current = null;
      // Drawn as the score viewer draws it — its options, its lines of the
      // ABC at a readable spacing (engraveScore), its crop to the ink. Its
      // own sizes once cut the last line: abcjs's svg, wider than the box,
      // was shrunk by the paper's `max-width: 100%` and, with no viewBox to
      // scale it, clipped instead — 52 px of the bottom staff gone on a
      // 360 px phone (2026-10-30, the user). cropToInk writes the viewBox.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const visual: any = engraveScore(abcjs, drawing, abc, {
        ...engraveOptions({ width, ink: colours.ink, transpose: shift }),
        // Notes are pressed to seek (onPaperClick); abcjs's own selection
        // would paint the pressed note red and leave it so.
        selectTypes: false,
      }, measure.current)[0];
      cropToInk(drawing);
      // The alignment's quavers are matched to these drawn notes by pitch.
      timeline.current = timelineOf(abcjs, visual, meter);      dirty.current = true;
    });
    return () => { cancelled = true; };
  }, [abc, meter, width, colours.ink, shift]);

  /** A note pressed: the recording jumps to where that note is played — the
   *  occurrence nearest to what is being heard. A note inside a repeat is
   *  played once per time round it, so it appears in several events of the
   *  timeline; each is a different quaver of the unfolded score. */
  const onPaperClick = (e: MouseEvent) => {
    const { follow: f, engine: eng } = live.current;
    const tl = timeline.current;
    const note = (e.target as Element | null)?.closest('.abcjs-note');
    if (!f || !tl || !eng || !note) return;
    const wanted = new Set(tl.events
      .filter(ev => (ev.elements ?? []).some(group => group.some(el => el === note || el.contains(note) || note.contains(el))))
      .map(ev => msToQuaver(ev.milliseconds, f.quavers, slotsOf(tl, f), tl.lastMoment)));
    if (wanted.size === 0) return;
    const now = eng.position();
    let best = -1;
    f.indices.forEach((i, k) => {
      if (!wanted.has(i)) return;
      if (best < 0 || Math.abs(f.times[k]! - now) < Math.abs(f.times[best]! - now)) best = k;
    });
    // A hair inside the note, so the cursor lands on it and not on its edge.
    if (best >= 0) { eng.seek(f.times[best]! + 0.02); dirty.current = true; }
  };

  // The moving parts, every frame for as long as the score is shown: the
  // cursor, and the region's two bounds. Cheap when nothing moves — the
  // player is seekable from its waveform while paused, so a loop that only
  // ran while playing would miss those.
  useEffect(() => {
    let raf = 0, lastPos = -1;
    /** The note drawn for an instant of the recording, and where along it. */
    const noteAt = (tl: Timeline, f: FollowResult, t: number) => {
      const pos = positionAt(f, t);
      if (!pos) return null;
      const ms = quaverToMs(pos.quaver, f.quavers, slotsOf(tl, f), tl.lastMoment);
      let lo = 0;
      for (let k = 0; k < tl.events.length; k++) { if (tl.events[k]!.milliseconds <= ms + 0.5) lo = k; else break; }
      const ev = tl.events[lo];
      if (!ev) return null;
      // Glides towards the next note on the same staff rather than jumping.
      const next = tl.events[lo + 1];
      let x = ev.left;
      if (next && next.top === ev.top && next.milliseconds > ev.milliseconds) {
        x += (next.left - ev.left) * Math.min(1, Math.max(0, (ms - ev.milliseconds) / (next.milliseconds - ev.milliseconds)));
      }
      return { ev, x, pass: pos.pass };
    };
    /** The text face: the cursor's bar against the note heard — all of a
     *  chord — kept in sight, centred when it leaves the box; and the
     *  region's first and last notes bracketed. */
    const markText = (ev: NoteEvent | null) => {
      const pre = textRef.current;
      if (!pre) return;
      const abc = abcRef.current;
      const cur = trimmed(abc, charRange(ev));
      const { in: inR, out: outR } = textBounds.current;
      const key = `${cur}|${inR}|${outR}`;
      if (key === textDrawn.current) return;
      textDrawn.current = key;
      const cuts = new Set<number>([0, abc.length]);
      for (const r of [cur, inR, outR]) if (r) { cuts.add(r[0]); cuts.add(r[1]); }
      const points = [...cuts].sort((a, b) => a - b);
      const parts: Node[] = [];
      let cursorEl: HTMLElement | null = null;
      for (let i = 0; i + 1 < points.length; i++) {
        const p = points[i]!, q = points[i + 1]!;
        const classes: string[] = [];
        if (cur && p === cur[0]) classes.push('abc-text-start');
        if (inR && p === inR[0]) classes.push('abc-text-in');
        if (outR && q === outR[1]) classes.push('abc-text-out');
        if (!classes.length) { parts.push(document.createTextNode(abc.slice(p, q))); continue; }
        const span = document.createElement('span');
        span.className = classes.join(' ');
        span.textContent = abc.slice(p, q);
        if (cur && p === cur[0]) cursorEl = span;
        parts.push(span);
      }
      pre.replaceChildren(...parts);
      if (cursorEl) {
        const top = cursorEl.offsetTop, h = cursorEl.offsetHeight;
        if (top < pre.scrollTop || top + h > pre.scrollTop + pre.clientHeight) {
          pre.scrollTo({ top: top + h / 2 - pre.clientHeight / 2, behavior: 'smooth' });
        }
      }
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const { follow: f, engine: eng, region: r } = live.current;
      const tl = timeline.current, paper = paperRef.current;
      // No alignment any more — no longer forced, another version on its
      // way: what the last one drew goes, once, rather than standing there.
      if (!f && dirty.current && paper) {
        dirty.current = false;
        for (const el of lit.current) el.classList.remove('abcjs-highlight');
        lit.current = [];
        paper.querySelectorAll('.abcjs-cursor, [class^="score-follow-bound"]').forEach(el => el.setAttribute('visibility', 'hidden'));
        textBounds.current = { in: null, out: null };
        if (faceRef.current === 'text') markText(null);
        return;
      }
      if (!eng || !f || !tl || !paper) return;
      const now = eng.position();
      if (now === lastPos && !dirty.current) return;
      lastPos = now;
      const svg = paper.querySelector('svg');
      if (!svg) return;
      for (const el of lit.current) el.classList.remove('abcjs-highlight');
      lit.current = [];
      const at = noteAt(tl, f, now);
      if (dirty.current) {
        // The region's notes in the text, for the text face's brackets.
        const bound = (t: number) => trimmed(abcRef.current, charRange(noteAt(tl, f, t)?.ev ?? null));
        textBounds.current = r ? { in: bound(r.start + 0.001), out: bound(r.end - 0.001) } : { in: null, out: null };
        textDrawn.current = '';
      }
      if (faceRef.current === 'text') markText(at?.ev ?? null);
      const cursor = svgLine(svg, 'abcjs-cursor');
      if (at) {
        cursor.setAttribute('visibility', 'visible');
        cursor.setAttribute('x1', String(at.x - 3)); cursor.setAttribute('x2', String(at.x - 3));
        cursor.setAttribute('y1', String(at.ev.top)); cursor.setAttribute('y2', String(at.ev.top + at.ev.height));
        for (const group of at.ev.elements ?? []) for (const el of group) { el.classList.add('abcjs-highlight'); lit.current.push(el); }
        // A new system: centred in the score box — and only there.
        // scrollIntoView would scroll every ancestor too, taking the player out
        // of sight. Rects are window pixels, scrollBy wants layout pixels.
        if (at.ev.top !== lastTop.current) {
          lastTop.current = at.ev.top;
          const note = at.ev.elements?.[0]?.[0] as Element | undefined;
          if (note) {
            const z = getZoom() / 100;
            const n = note.getBoundingClientRect(), p = paper.getBoundingClientRect();
            paper.scrollBy({ top: (n.top + n.height / 2 - p.top) / z - paper.clientHeight / 2, behavior: 'smooth' });
          }
        }
      } else {
        cursor.setAttribute('visibility', 'hidden');
      }
      // The region's bounds, where they fall in the score — each with the
      // number of the pass it is in, the waveform's numbers: one score drawn
      // for several passes, a start and an end on the same page would
      // otherwise read as a loop round that one pass (the user, 2026-10-28).
      // The end's number sits on its left, inside the region — unless the
      // start's, on the same line just before, is already there.
      if (dirty.current) {
        let inBadge: { x: number; top: number } | null = null;
        (['in', 'out'] as const).forEach((side) => {
          const line = svgLine(svg, `score-follow-bound-${side}`);
          const badge = svgBadge(svg, `score-follow-bound-badge-${side}`);
          const b = r ? noteAt(tl, f, side === 'in' ? r.start + 0.001 : r.end - 0.001) : null;
          if (!b) { line.setAttribute('visibility', 'hidden'); badge(null); return; }
          const x = side === 'in' ? b.ev.left - 6 : b.x + 4;
          line.setAttribute('visibility', 'visible');
          line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x));
          line.setAttribute('y1', String(b.ev.top - 4)); line.setAttribute('y2', String(b.ev.top + b.ev.height + 4));
          const top = b.ev.top - 4, label = String(b.pass + 1);
          if (side === 'in') {
            inBadge = { x, top };
            badge({ x: x + 0.5, top, label });
          } else {
            const crowded = inBadge !== null && inBadge.top === top && x > inBadge.x && x - inBadge.x < 34;
            badge(crowded ? { x: x + 0.5, top, label } : { x: x - 0.5, top, label, left: true });
          }
        });
      }
      dirty.current = false;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The screen stays on while the music plays: the score is read, not touched.
  useEffect(() => {
    if (!playing) return;
    const wake = new WakeLockManager();
    void wake.start();
    return () => wake.stop();
  }, [playing]);

  // Space plays / pauses, ← → skip — a score being read is a hands-off page.
  // Caught before anything else gets it: a button pressed a moment ago (a
  // pass's number) keeps the focus, and Space would press it again instead.
  // Text fields and sliders keep their keys.
  useEffect(() => {
    const ours = (e: KeyboardEvent): boolean => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName))) return false;
      if (el?.tagName === 'INPUT') return false;
      return e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowLeft';
    };
    const onKey = (e: KeyboardEvent) => {
      const eng = live.current.engine;
      if (!eng || !ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === ' ') { if (eng.isPlaying()) eng.pause(); else void eng.play(); }
      else if (e.key === 'ArrowRight') eng.seek(eng.position() + SKIP_S);
      else eng.seek(Math.max(0, eng.position() - SKIP_S));
    };
    // A focused button acts on Space's keyup: that one is swallowed too.
    const onKeyUp = (e: KeyboardEvent) => { if (live.current.engine && ours(e) && e.key === ' ') e.preventDefault(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  return (
    <div class="relative rounded overflow-hidden" style={{ background: colours.paper }}>
      {/* Behind the text face the stave is still drawn, at the box's width:
          its timeline is what the text's cursor reads. Out of sight in a box
          of no height that clips it all — not display:none, a box of no width
          is never drawn; and not visibility:hidden on the paper, which its
          cursor and bounds override (`visibility="visible"`): they were seen
          floating over the text (2026-10-29). */}
      <div style={face === 'text' ? { position: 'absolute', left: 0, right: 0, top: 0, height: 0, overflow: 'hidden', opacity: 0, pointerEvents: 'none' } : undefined}>
        <div
          ref={paperRef}
          onClick={onPaperClick}
          class={`abc-score-paper score-follow-paper overflow-y-auto p-2 ${tools ? 'pt-8' : ''}`}
          style={{ color: colours.ink, '--abc-paper': colours.paper, '--abc-cursor': colours.cursor, '--abc-in': colours.boundIn, '--abc-out': colours.boundOut, maxHeight, minHeight: '8rem' }}
        >
          <div ref={drawingRef} />
        </div>
      </div>
      {face === 'text' && (
        // Read-only: what is followed is the version as drawn, aligned as such.
        <pre
          ref={textRef}
          class={`score-follow-text relative m-0 overflow-y-auto p-3 font-mono text-xs whitespace-pre-wrap break-words ${tools ? 'pt-8' : ''}`}
          style={{ color: colours.ink, '--abc-cursor': colours.cursor, '--abc-in': colours.boundIn, '--abc-out': colours.boundOut, maxHeight, minHeight: '8rem' }}
        />
      )}
      {/* Over the paper, in its ink — the score viewer's own corner. */}
      {tools && (
        <div class="absolute top-1 right-3 z-20 flex items-center" style={{ '--abc-ink': colours.ink }}>{tools}</div>
      )}
    </div>
  );
}

/** Where each pass of the score starts in the recording — the player's marks. */
export function passStartsOf(follow: FollowResult): number[] {
  const out = [follow.times[0]!];
  for (let k = 1; k < follow.indices.length; k++) if (follow.indices[k]! <= follow.indices[k - 1]!) out.push(follow.times[k]!);
  return out;
}
