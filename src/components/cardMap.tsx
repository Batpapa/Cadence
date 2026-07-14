import { useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { navigate } from '../store';
import { timeAgo, pct } from '../utils';
import { decksContainingCard } from '../services/deckService';
import { replayFSRS, fsrsRetrievability, retentionWindowDays } from '../services/knowledgeService';
import { t } from '../services/i18nService';
import type { AppState, Card } from '../types';

function formatDays(d: number): string {
  if (d >= 365) return t('common.durationYears',  { n: (d / 365).toFixed(1) });
  if (d >= 30)  return t('common.durationMonths', { n: Math.round(d / 30) });
  if (d >= 1)   return t('common.durationDays',   { n: Math.round(d) });
  return t('common.durationLessThanDay');
}

// ── Card map SVG builder (vanilla, unchanged) ─────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';
const mkEl = (tag: string, attrs: Record<string, string>) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const mkText = (x: number, y: number, content: string, anchor: string, size = '8') => {
  const el = mkEl('text', { x: String(x), y: String(y), 'text-anchor': anchor, 'font-size': size, fill: 'var(--color-dim)', 'font-family': 'IBM Plex Mono, monospace' });
  el.textContent = content; return el;
};

type Point = { id: string; name: string; s: number; ease: number; k: number; imp: number; deckIds: string[] };

const H = 240;
const padL = 38, padR = 14, padT = 12, padB = 30;
const xMin = 0.5, xMax = 730;
const logXMin = Math.log(xMin), logXMax = Math.log(xMax);
const rScale  = (imp: number) => Math.sqrt(Math.max(1, Math.min(10, Math.log10(Math.max(1, imp)))));
const dotColor = (k: number) => k >= 0.75 ? 'var(--color-success)' : k >= 0.4 ? 'var(--color-warn)' : 'var(--color-danger)';
const xTicks: Array<{ val: number; labelKey: string }> = [
  { val: 1,   labelKey: 'dashboard.period.1d'  },
  { val: 7,   labelKey: 'dashboard.period.7d'  },
  { val: 30,  labelKey: 'dashboard.period.30d' },
  { val: 180, labelKey: 'dashboard.period.6mo' },
  { val: 365, labelKey: 'dashboard.period.1y'  },
];

function buildSvg(
  W: number,
  pts: Point[],
  onHover: (pt: Point, cx: number, cy: number, W: number) => void,
  onLeave: () => void,
): SVGSVGElement {
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xScale = (s: number) => padL + (Math.log(Math.max(xMin, Math.min(xMax, s))) - logXMin) / (logXMax - logXMin) * plotW;
  const yScale = (e: number) => padT + plotH * (1 - Math.max(0, Math.min(1, e)));

  const svg = mkEl('svg', { width: String(W), height: String(H) }) as SVGSVGElement;

  for (const tick of [0, 0.25, 0.5, 0.75, 1.0]) {
    const y = yScale(tick);
    svg.append(mkEl('line', { x1: String(padL), x2: String(W - padR), y1: String(y), y2: String(y), stroke: 'var(--color-border)', 'stroke-width': '1' }));
    svg.append(mkText(padL - 5, y + 3.5, `${Math.round(tick * 100)}%`, 'end'));
  }
  for (const { val, labelKey } of xTicks) {
    const x = xScale(val);
    svg.append(mkEl('line', { x1: String(x), x2: String(x), y1: String(padT), y2: String(padT + plotH), stroke: 'var(--color-border)', 'stroke-width': '1' }));
    svg.append(mkText(x, H - padB + 12, t(labelKey), 'middle'));
  }
  svg.append(mkEl('rect', { x: String(padL), y: String(padT), width: String(plotW), height: String(plotH), fill: 'none', stroke: 'var(--color-border)', 'stroke-width': '1' }));

  for (const pt of [...pts].sort((a, b) => b.imp - a.imp)) {
    const color  = dotColor(pt.k);
    const circle = mkEl('circle', {
      cx: String(xScale(pt.s)), cy: String(yScale(pt.ease)), r: String(rScale(pt.imp)),
      fill: color, 'fill-opacity': '0.7', stroke: color, 'stroke-opacity': '0.35', 'stroke-width': '1.5',
    });
    (circle as unknown as HTMLElement).style.cursor = 'pointer';
    circle.addEventListener('mouseenter', () => onHover(pt, parseFloat(circle.getAttribute('cx') ?? '0'), parseFloat(circle.getAttribute('cy') ?? '0'), W));
    circle.addEventListener('mouseleave', onLeave);
    circle.addEventListener('click', () => navigate({ view: 'card', cardId: pt.id }));
    svg.append(circle);
  }

  svg.append(mkText(padL + plotW / 2, H - 2, t('deck.section.stability'), 'middle', '10'));
  const yLbl = mkEl('text', { x: '0', y: '0', 'text-anchor': 'middle', 'font-size': '10', fill: 'var(--color-dim)', 'font-family': 'IBM Plex Mono, monospace', transform: `rotate(-90) translate(${-(padT + plotH / 2)}, 9)` });
  yLbl.textContent = t('deck.section.ease');
  svg.append(yLbl);
  svg.addEventListener('mouseleave', onLeave);
  return svg;
}

// ── Card map component ────────────────────────────────────────────────────────

/** Scatter plot of stability (x) vs ease (y) for the given cards — dot size = importance, color = availability. */
export function CardMap({ user, cards }: { user: AppState; cards: Card[] }) {

  const allPoints: Point[] = [];
  for (const card of cards) {
    const work = user.cardWorks[`${user.currentProfileId}:${card.id}`];
    if (!work || work.history.length === 0) continue;
    const fsrs = replayFSRS(work.history);
    if (!fsrs) continue;
    const ease      = (10 - fsrs.difficulty) / 9;
    const elapsed   = (Date.now() - fsrs.lastTs) / 86400000;
    const lambda    = user.forgettingRate ?? 1;
    const k         = fsrsRetrievability(elapsed, fsrs.stability, lambda);
    const retWindow = retentionWindowDays(fsrs.stability, user.availabilityThreshold, lambda);
    const deckIds   = decksContainingCard(card.id, user);
    allPoints.push({ id: card.id, name: card.name, s: retWindow, ease, k, imp: card.defaultImportance, deckIds });
  }

  const svgRef     = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const lastWRef   = useRef(0);

  // Tooltip helpers (vanilla — ref-controlled to avoid fighting Preact)
  const rColor = (k: number) => k >= 0.75 ? 'var(--color-success)' : k >= 0.4 ? 'var(--color-warn)' : 'var(--color-danger)';
  const eColor = (e: number) => e >= 0.6  ? 'var(--color-success)' : e >= 0.35 ? 'var(--color-warn)' : 'var(--color-danger)';

  const showTooltip = (pt: Point, dotX: number, dotY: number, svgW: number) => {
    const tip = tooltipRef.current; if (!tip) return;
    tip.style.left    = dotX > svgW * 0.6 ? `${dotX - 188}px` : `${dotX + 12}px`;
    tip.style.top     = `${Math.max(0, dotY - 10)}px`;
    tip.style.display = 'block';
    const deckNames = pt.deckIds.map(id => user.decks[id]?.name).filter(Boolean).join(', ');
    const lastWork  = user.cardWorks[`${user.currentProfileId}:${pt.id}`];
    const lastTs    = lastWork?.history.at(-1)?.ts;
    tip.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:var(--color-primary);margin-bottom:4px;line-height:1.3">${pt.name}</div>
      <div style="font-size:10px;color:var(--color-dim);margin-bottom:8px">${deckNames ? deckNames + ' · ' : ''}${lastTs ? timeAgo(lastTs) : t('card.neverReviewed')}</div>
      <div style="display:flex;flex-direction:column;gap:3px">
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:var(--color-dim);text-transform:uppercase;letter-spacing:0.08em">${t('deck.section.availability')}</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:${rColor(pt.k)};font-weight:500">${pct(pt.k)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:var(--color-dim);text-transform:uppercase;letter-spacing:0.08em">${t('deck.section.stability')}</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--color-primary);font-weight:500">${formatDays(pt.s)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:var(--color-dim);text-transform:uppercase;letter-spacing:0.08em">${t('deck.section.ease')}</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:${eColor(pt.ease)};font-weight:500">${pct(pt.ease)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="font-size:9px;color:var(--color-dim);text-transform:uppercase;letter-spacing:0.08em">${t('card.section.importance')}</span><span style="font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--color-primary);font-weight:500">×${pt.imp}</span></div>
      </div>`;
  };
  const hideTooltip = () => { const tip = tooltipRef.current; if (tip) tip.style.display = 'none'; };

  // ref to always-fresh rebuild function (avoids stale closure in ResizeObserver)
  const rebuildRef = useRef<() => void>(() => {});
  rebuildRef.current = () => {
    const w = lastWRef.current;
    const container = svgRef.current;
    if (w <= 0 || !container) return;
    hideTooltip();
    const newSvg = buildSvg(w, allPoints, showTooltip, hideTooltip);
    const old = container.querySelector('svg');
    if (old) old.replaceWith(newSvg); else container.insertBefore(newSvg, tooltipRef.current);
  };

  // ResizeObserver — permanent, calls rebuildRef.current (always fresh)
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      requestAnimationFrame(() => {
        const w = Math.floor(entries[0]!.contentRect.width);
        if (w <= 0) return;
        lastWRef.current = w;
        rebuildRef.current();
      });
    });
    if (!svgRef.current) return;
    obs.observe(svgRef.current);
    return () => obs.disconnect();
  }, []);

  useLayoutEffect(() => { rebuildRef.current(); });

  return (
    <div ref={svgRef} style="position:relative">
      <div ref={tooltipRef} style="position:absolute;display:none;pointer-events:none;z-index:20;width:176px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:10px 12px;box-shadow:0 4px 24px rgba(0,0,0,0.6);font-family:'IBM Plex Sans',system-ui,sans-serif;" />
    </div>
  );
}
