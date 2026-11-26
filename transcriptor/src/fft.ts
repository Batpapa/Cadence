// In-place iterative radix-2 FFT on separate real / imaginary arrays, with the twiddles and
// the bit reversal computed once per size; and the FFT of a REAL signal through a complex one
// of half its length (the even samples as real parts, the odd ones as imaginary parts, then
// one butterfly pass to separate them): half the work.

export class FFT {
  readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform of (re, im), in place. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        let t = re[i]!; re[i] = re[j]!; re[j] = t;
        t = im[i]!; im[i] = im[j]!; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k, b = a + half;
          const wr = cs[t]!, wi = sn[t]!;
          const br = re[b]!, bi = im[b]!;
          const xr = br * wr - bi * wi, xi = br * wi + bi * wr;
          const ar = re[a]!, ai = im[a]!;
          re[b] = ar - xr; im[b] = ai - xi;
          re[a] = ar + xr; im[a] = ai + xi;
        }
      }
    }
  }
}

/** FFT of a real signal of length n: bins 0..n/2 into (outRe, outIm). */
export class RealFFT {
  readonly n: number;
  private readonly half: FFT;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly wr: Float64Array;
  private readonly wi: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.half = new FFT(n / 2);
    this.zr = new Float64Array(n / 2);
    this.zi = new Float64Array(n / 2);
    this.wr = new Float64Array(n / 2);
    this.wi = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { this.wr[k] = Math.cos((2 * Math.PI * k) / n); this.wi[k] = -Math.sin((2 * Math.PI * k) / n); }
  }

  /** x: n real samples; outRe / outIm: n / 2 + 1 bins. */
  transform(x: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    const m = this.n / 2, zr = this.zr, zi = this.zi;
    for (let j = 0; j < m; j++) { zr[j] = x[2 * j]!; zi[j] = x[2 * j + 1]!; }
    this.half.transform(zr, zi);
    // X[k] = E[k] + W^k O[k], E = (Z[k] + conj Z[m-k]) / 2, O = (Z[k] - conj Z[m-k]) / 2i
    outRe[0] = zr[0]! + zi[0]!; outIm[0] = 0;
    outRe[m] = zr[0]! - zi[0]!; outIm[m] = 0;
    for (let k = 1; k < m; k++) {
      const ar = zr[k]!, ai = zi[k]!, br = zr[m - k]!, bi = -zi[m - k]!;
      const er = (ar + br) / 2, ei = (ai + bi) / 2;
      // (Z[k] - conj Z[m-k]) / 2i = ((ai - bi) - i (ar - br)) / 2
      const or = (ai - bi) / 2, oi = -(ar - br) / 2;
      const wr = this.wr[k]!, wi = this.wi[k]!;
      outRe[k] = er + wr * or - wi * oi;
      outIm[k] = ei + wr * oi + wi * or;
    }
  }
}
