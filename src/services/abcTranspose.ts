// ── An ABC tune, written out in another key ──────────────────────────────────
// For a score Cadence builds itself — a detection's stand-in from the
// recognition index, a heard set fused from them — shown in the key it was
// PLAYED in (2026-11-07): the text itself transposed, K: lines, notes and
// accidentals, so the stave, the ABC face, the playback, the audio sync and
// the Play-along all read the same key with nothing to say it was moved. A
// card's own score is never rewritten: the viewer opens it transposed instead
// (fileViewer.ts's initialTranspose), the file staying as the user wrote it.
//
// abcjs's own strTranspose, which needs the tune parsed (renderAbc on '*'
// draws nothing). Whatever it cannot read comes back as it was.

export async function transposeAbcText(abc: string, semitones: number): Promise<string> {
  const steps = Math.round(semitones);
  if (steps === 0) return abc;
  try {
    const abcjs = await import('abcjs');
    const visual = abcjs.renderAbc('*', abc);
    return abcjs.strTranspose(abc, visual, steps);
  } catch {
    return abc;
  }
}
