'use strict';
// RealFFT against the complex FFT on random signals: largest difference.
const { pathToFileURL } = require('node:url'), path = require('node:path');
(async () => {
  const F = await import(pathToFileURL(path.join(__dirname, '../src/fft.ts')).href);
  for (const n of [2048, 4096]) {
    const x = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
    const re = Float64Array.from(x), im = new Float64Array(n);
    new F.FFT(n).transform(re, im);
    const r2 = new Float64Array(n / 2 + 1), i2 = new Float64Array(n / 2 + 1);
    new F.RealFFT(n).transform(x, r2, i2);
    let d = 0; for (let k = 0; k <= n / 2; k++) d = Math.max(d, Math.abs(re[k] - r2[k]), Math.abs(im[k] - i2[k]));
    console.log(n, 'max diff', d.toExponential(2));
  }
})();
