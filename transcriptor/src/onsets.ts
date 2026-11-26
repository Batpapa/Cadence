// Onset detection functions and peak picking.
//   - broadband: SuperFlux (Böck & Widmer 2013), computed in spectrum.ts on a short window:
//     the attack of a bow, a tongue, a finger, a re-attacked note;
//   - pitch change: how much of the pitch-class distribution is new against LAG frames
//     before (half the L1 distance of the normalised class saliences): a legato change of
//     note, with no attack noise at all.

/** Pitch-change novelty from frames x 12 class saliences. */
export function pitchChange(cls: Float32Array, frames: number, lag = 4): Float32Array {
  const out = new Float32Array(frames);
  const norm = (t: number, k: number, s: number) => (s > 0 ? cls[t * 12 + k]! / s : 0);
  const sums = new Float64Array(frames);
  for (let t = 0; t < frames; t++) { let s = 0; for (let k = 0; k < 12; k++) s += cls[t * 12 + k]!; sums[t] = s; }
  for (let t = lag; t < frames; t++) {
    let d = 0;
    for (let k = 0; k < 12; k++) {
      const x = norm(t, k, sums[t]!) - norm(t - lag, k, sums[t - lag]!);
      if (x > 0) d += x;
    }
    out[t - (lag >> 1)] = d;
  }
  return out;
}

/** Each value over the median of the values within `span` frames (a level that adapts). */
export function overLocalMedian(x: Float32Array, span: number): Float32Array {
  const n = x.length, out = new Float32Array(n), win: number[] = [];
  const step = Math.max(1, span >> 3);
  let med = 0;
  for (let t = 0; t < n; t++) {
    if (t % step === 0) {
      win.length = 0;
      for (let u = Math.max(0, t - span); u < Math.min(n, t + span); u++) win.push(x[u]!);
      win.sort((a, b) => a - b);
      med = win[win.length >> 1] ?? 0;
    }
    out[t] = Math.max(0, x[t]! - med);
  }
  return out;
}

/** Local maxima within `radius` frames over `threshold` x the function's mean. */
export function peaks(x: Float32Array, radius: number, threshold: number): number[] {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length || 1;
  const thr = threshold * mean, out: number[] = [];
  for (let t = 0; t < x.length; t++) {
    const v = x[t]!;
    if (v <= thr) continue;
    let top = true;
    for (let u = Math.max(0, t - radius); u <= Math.min(x.length - 1, t + radius) && top; u++) if (x[u]! > v || (x[u] === v && u < t)) top = false;
    if (top) out.push(t);
  }
  return out;
}
