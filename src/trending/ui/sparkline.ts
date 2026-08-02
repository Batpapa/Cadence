// ── Sparkline (house style) ────────────────────────────────────────────────
// Cadence has no charting dependency anywhere (the dashboard's ActivityBars —
// folder.tsx — draws its bars in plain DOM/JSX) and the build already warns
// about bundle size, so this is a small inline <svg> polyline rather than
// pulling in Chart.js like TheSession_PopularityExplorer (the reference tool
// this was ported from) does.

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SparklineOptions {
  width: number;
  height: number;
}

export function buildSparkline(values: (number | null)[], opts: SparklineOptions): SVGElement {
  const { width, height } = opts;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.display = 'block';

  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return svg;

  const min = Math.min(...known);
  const max = Math.max(...known);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const toY = (v: number) => height - ((v - min) / range) * height;

  let d = '';
  let penDown = false;
  values.forEach((v, i) => {
    if (v === null) { penDown = false; return; }
    const x = i * stepX;
    const y = toY(v);
    d += `${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    penDown = true;
  });

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d.trim());
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--color-accent)');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  return svg;
}
