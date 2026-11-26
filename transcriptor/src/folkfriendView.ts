// FolkFriend's cleaned energies as the decoder's extra class view (decoder.ts's ClassView). The
// decoder knows nothing of FolkFriend: it reads any view of the 12 classes, frame by frame. This
// file is the adapter — FolkFriend's format and the settings its cleaned energies are read with.
// The caller runs FolkFriend (in Cadence: src/session/recognition/folkfriendView.ts) and folds its
// output here.

import type { ClassView } from './decoder.ts';

/** FolkFriendWASM.take_clean_features's settings and frames: the harmonic part of 48 notes from
 *  MIDI 48, each note minus its median over `drone` frames, the median taken every `stride`
 *  frames; frames of `hop` samples at 48 kHz. Measured (research journal, outside the repo): the
 *  drone removal is what makes the view worth reading (without it the recogniser's right tune
 *  first in 92.1 % of the windows instead of 93.2). */
export const CLEAN_VIEW = { drone: 469, stride: 47, hop: 1024 };

/** Classes kept in each frame (5 = all 12 as measured; 3 lost 0.5 point). */
const KEEP = 5;

/** take_clean_features's frames x 48 folded to the 12 classes, each frame's 5 strongest kept. */
export function classView(f48: Float32Array): ClassView {
  const frames = Math.floor(f48.length / 48), out = new Float32Array(frames * 12);
  const row = new Float32Array(12);
  for (let f = 0; f < frames; f++) {
    for (let m = 0; m < 48; m++) out[f * 12 + (m % 12)] += f48[f * 48 + m]!;
    row.set(out.subarray(f * 12, f * 12 + 12));
    row.sort();
    const keep = row[12 - KEEP]!;
    for (let c = 0; c < 12; c++) if (out[f * 12 + c]! < keep) out[f * 12 + c] = 0;
  }
  return { classes: out, hop: CLEAN_VIEW.hop };
}
