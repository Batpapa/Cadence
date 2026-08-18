'use strict';
// Ported from Cadence's src/session/recognition/contourShift.ts — keep in sync.
const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';

function shiftContour(contour, semitones) {
  let out = '';
  for (const ch of contour) {
    const idx = CONTOUR_CHARS.indexOf(ch);
    if (idx === -1) continue;
    const shifted = idx + semitones;
    if (shifted >= 0 && shifted < CONTOUR_CHARS.length) out += CONTOUR_CHARS[shifted];
  }
  return out;
}

module.exports = { shiftContour };
