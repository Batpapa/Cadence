// ── How a score is engraved on screen ─────────────────────────────────────────
// The score viewer's drawing (fileViewer.ts, where the measurements behind it
// are told) and the score that follows a recording (syncedScore.tsx) draw the
// same way: one set of options, one crop to the ink (the user, 2026-10-30:
// the followed score lost its last line where the viewer's never did).

/** Narrower than this and abcjs is drawing for nobody — the modal itself never
 *  gets this small, but a box measured mid-layout can report anything. */
export const MIN_ENGRAVE_WIDTH = 180;

/** How far the box has to change width before the score is re-engraved.
 *  Re-engraving rebuilds the audio buffer (see redrawPreservingPlayback), so
 *  this is deliberately coarser than the incipit's: wide enough to swallow a
 *  scrollbar appearing, which is the one width change a redraw causes itself. */
export const ENGRAVE_HYSTERESIS = 24;

/** The width abcjs is asked to engrave to: the box's own, less its
 *  padding. `clientWidth` and not `getBoundingClientRect` — this is
 *  layout pixels, which is the space abcjs lays out in, and it is
 *  therefore the one measurement the app's CSS zoom must NOT be divided
 *  out of (see zoomService's note on the two pixel spaces). */
export function engraveWidthOf(box: HTMLElement): number {
  const style = getComputedStyle(box);
  const inner = box.clientWidth
    - parseFloat(style.paddingLeft || '0')
    - parseFloat(style.paddingRight || '0');
  return Math.max(MIN_ENGRAVE_WIDTH, Math.round(inner));
}

export interface EngraveSettings {
  width: number;
  ink: string;
  transpose: number;
}


/** Everything about how a score is DRAWN, in one place, so the four callers
 *  that redraw one cannot drift apart. */
export function engraveOptions(s: EngraveSettings): Record<string, unknown> {
  return {
    // NO `responsive: 'resize'`, since 2026-09-21. It existed to scale a
    // 740-unit layout into whatever box it landed in, and there is nothing
    // left to scale now that the layout IS the box's width: measured at 327,
    // 390, 818 and 1150 px, the svg's own width attribute came back equal to
    // the box every time and the ink stopped 12 px short of the edge.
    //
    // Dropping it is what makes `cropToInk` below possible: a responsive
    // render writes `overflow:hidden` and a fixed height onto its target and
    // puts the drawing's height into a percentage padding, so a cropped
    // viewBox would have been clipped by the very box it was shrinking.
    add_classes: true,
    staffwidth: Math.max(MIN_ENGRAVE_WIDTH, Math.round(s.width)),
    // No `wrap` here: where the lines break is engraveScore's.
    // abcjs's own defaults for the sides (15/50) leave the last note of a line
    // hanging outside the box at some widths — measured. These are symmetric
    // and verified to keep the ink inside from 348 px to 1200 px.
    // `paddingtop: 0` because `cropToInk` takes the top margin off anyway, and
    // any value here is simply cropped away again.
    paddingleft: 12, paddingright: 12, paddingtop: 0, paddingbottom: 8,
    // `currentColor` is abcjs 6's own default and would work if the score were
    // drawn into the themed page; it is stated instead because the box sets its
    // own paper, which is not the colour the surrounding app uses for text.
    foregroundColor: s.ink,
    visualTranspose: s.transpose,
    format: {
      gchordfont: 'Verdana 12',
      annotationfont: 'Verdana 12',
      // Everything above the first staff that the screen around it already
      // says, or that nobody asked the score for: the title (the modal's own
      // heading, one centimetre higher), the composer, and the rhythm line
      // (`R: reel` — the card knows what kind of tune it is). Three lines of
      // vertical budget on a phone, spent saying nothing new.
      //
      // `partsfont` is deliberately LEFT ALONE: a set's fused score names its
      // tunes with `[P:]` markers, and those are the only labels in this
      // notation that carry information the reader needs.
      titlefont: 'Verdana 0',
      subtitlefont: 'Verdana 0',
      composerfont: 'Verdana 0',
      infofont: 'Verdana 0',
    },
  };
}

/** Takes the empty band off the top of an engraved score.
 *
 *  Measured on 2026-09-21, at the options above: the first staff line sat 42 px
 *  down a score whose own ink started at 27, and every pixel between was
 *  reserved for things that are not drawn — the zero-sized title block still
 *  claims ~10 px of box, and abcjs's own top margin the rest. Reported as "tout
 *  un espace inutile en haut de la partition", and it was.
 *
 *  Fixing the FONTS does not fix this; the layout is already done by the time
 *  a zero-sized font paints nothing, which is also why hiding the tempo mark in
 *  CSS reclaimed nothing. The only thing that moves the music up is re-stating
 *  the viewBox over the ink — the same trick the incipit's `fitToInk` plays,
 *  for the same reason.
 *
 *  abcjs also writes `overflow:hidden` and a fixed `height` onto the element it
 *  drew into; both are cleared, or the box stays as tall as the uncropped
 *  drawing and the space comes back underneath.
 *
 *  Ink is what is DRAWN: an element hidden in CSS is skipped. getBBox does not
 *  know about CSS — it answers for the tempo mark too, which
 *  `.abc-score-paper .abcjs-tempo` hides — so the crop used to start at the
 *  tempo and leave its band above the first staff (measured 2026-10-24 on a
 *  360 px phone: viewBox at 31, staff at 69). getClientRects is empty for an
 *  element that is not rendered, its own display or an ancestor's. */
export function cropToInk(host: HTMLElement): void {
  host.style.removeProperty('overflow');
  host.style.removeProperty('height');
  host.style.removeProperty('width');
  const svg = host.querySelector('svg');
  if (!svg) return;
  const width = parseFloat(svg.getAttribute('width') ?? '') || svg.getBoundingClientRect().width;
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of Array.from(svg.querySelectorAll('path, text, rect'))) {
    if (el.getClientRects().length === 0) continue;
    let box: DOMRect;
    // getBBox throws on a detached or undisplayed element, and returns zeros
    // for an empty one; neither is ink.
    try { box = (el as SVGGraphicsElement).getBBox(); } catch { continue; }
    if (!box.width && !box.height) continue;
    top = Math.min(top, box.y);
    bottom = Math.max(bottom, box.y + box.height);
  }
  // Nothing recognisable: leave abcjs's own drawing exactly as it is rather
  // than write a viewBox computed from infinities.
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return;
  const height = bottom - top;
  svg.setAttribute('viewBox', `0 ${top.toFixed(2)} ${width} ${height.toFixed(2)}`);
  svg.setAttribute('height', String(Math.ceil(height)));
}
