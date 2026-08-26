// ── Sparkline (house style) ────────────────────────────────────────────────
// Cadence has no charting dependency anywhere (the dashboard's ActivityBars —
// folder.tsx — draws its bars in plain DOM/JSX) and the build already warns
// about bundle size, so this is a small inline <svg> polyline rather than
// pulling in Chart.js like TheSession_PopularityExplorer (the reference tool
// this was ported from) does.

export interface SparklineProps {
  values: (number | null)[];
  width: number;
  height: number;
  class?: string;
}

export function Sparkline({ values, width, height, class: className }: SparklineProps) {
  const known = values.filter((v): v is number => v !== null);
  let d = '';
  if (known.length > 0) {
    const min = Math.min(...known);
    const max = Math.max(...known);
    const range = max - min || 1;
    const stepX = values.length > 1 ? width / (values.length - 1) : 0;
    const toY = (v: number) => height - ((v - min) / range) * height;

    let penDown = false;
    values.forEach((v, i) => {
      if (v === null) { penDown = false; return; }
      const x = i * stepX;
      const y = toY(v);
      d += `${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      penDown = true;
    });
    d = d.trim();
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }} class={className}>
      {d && <path d={d} fill="none" stroke="var(--color-accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />}
    </svg>
  );
}
