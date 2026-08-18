'use strict';
// Minimal dependency-free SVG histogram (two overlaid density series) — no
// chart library needed for a static report.

function histogramSvg(musicVals, noiseVals, { width = 420, height = 220, bins = 24, title = '', xLabel = '' } = {}) {
  const allVals = [...musicVals, ...noiseVals].filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  if (allVals.length === 0) return `<div class="chart-empty">${title}: no data</div>`;
  const min = Math.min(...allVals), max = Math.max(...allVals);
  const range = max - min || 1;
  const binWidth = range / bins;

  function densities(vals) {
    const counts = new Array(bins).fill(0);
    for (const v of vals) {
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      let idx = Math.floor((v - min) / binWidth);
      if (idx >= bins) idx = bins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
    const n = vals.length || 1;
    return counts.map(c => c / n); // density, not raw count — fair comparison across group sizes
  }

  const musicDensity = densities(musicVals);
  const noiseDensity = densities(noiseVals);
  const maxDensity = Math.max(...musicDensity, ...noiseDensity, 1e-9);

  const marginLeft = 40, marginBottom = 24, marginTop = 28, marginRight = 12;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;
  const barW = plotW / bins;

  function bars(density, cls) {
    return density.map((d, i) => {
      const h = (d / maxDensity) * plotH;
      const x = marginLeft + i * barW;
      const y = marginTop + (plotH - h);
      return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 0.5).toFixed(1)}" height="${h.toFixed(1)}" />`;
    }).join('');
  }

  const xTicks = [0, 0.5, 1].map(f => min + f * range);
  const xTickLabels = xTicks.map((v, i) => {
    const x = marginLeft + i * (plotW / 2);
    return `<text x="${x.toFixed(1)}" y="${height - 6}" class="axis-label" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${v.toFixed(2)}</text>`;
  }).join('');

  return `
<figure class="chart">
  <figcaption class="chart-title">${title}</figcaption>
  <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${title}">
    <line x1="${marginLeft}" y1="${marginTop + plotH}" x2="${marginLeft + plotW}" y2="${marginTop + plotH}" class="axis-line" />
    ${bars(noiseDensity, 'bar-noise')}
    ${bars(musicDensity, 'bar-music')}
    ${xTickLabels}
  </svg>
  <div class="chart-xlabel">${xLabel}</div>
</figure>`;
}

module.exports = { histogramSvg };
