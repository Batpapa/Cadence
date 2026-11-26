// The reference signal of golden.test.ts: deterministic, a few seconds of what the decoder meets
// in a session — a melody, the same melody an octave down on a softer instrument, a drone, a
// little noise.

const RATE = 48000;

function tone(out: Float32Array, pitch: number, start: number, length: number, gain: number, harmonics: number): void {
  const f0 = 440 * 2 ** ((pitch - 69) / 12), s = Math.round(start * RATE), n = Math.round(length * RATE);
  for (let k = 0; k < n && s + k < out.length; k++) {
    const x = k / RATE, env = Math.min(1, x / 0.005, (length - x) / 0.01);
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * h * f0 * x) / h;
    out[s + k] += gain * env * v;
  }
}

/** 8 seconds at 48 kHz: a reel-like line in D twice, an octave below at half the level, a D
 *  drone, noise. */
export function goldenSignal(): Float32Array {
  const out = new Float32Array(8 * RATE);
  let seed = 3;
  for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = 0.003 * (seed / 0x7fffffff - 0.5); }
  const line = [74, 69, 66, 69, 74, 76, 78, 76, 74, 71, 69, 66, 64, 66, 69, 71, 69, 69, 74, 69, 66, 69, 71, 73];
  const q = 0.14;
  for (let rep = 0, t = 0.3; rep < 2; rep++) for (const p of line) { tone(out, p, t, q, 0.2, 6); tone(out, p - 12, t, q, 0.1, 4); t += q; }
  tone(out, 50, 0, 8, 0.05, 3);
  return out;
}
