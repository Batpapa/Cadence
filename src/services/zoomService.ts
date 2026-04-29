const LS_ZOOM = 'cadence_zoom';
export const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const DEFAULT_ZOOM = 100;

export function getZoom(): number {
  return parseInt(localStorage.getItem(LS_ZOOM) ?? String(DEFAULT_ZOOM), 10);
}

export function setZoom(pct: number): void {
  localStorage.setItem(LS_ZOOM, String(pct));
  document.documentElement.style.zoom = `${pct}%`;
}

export function zoomIn(): void {
  const current = getZoom();
  const next = ZOOM_LEVELS.find(v => v > current);
  if (next !== undefined) setZoom(next);
}

export function zoomOut(): void {
  const current = getZoom();
  const prev = [...ZOOM_LEVELS].reverse().find(v => v < current);
  if (prev !== undefined) setZoom(prev);
}

export function canZoomIn(): boolean  { return getZoom() < ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!; }
export function canZoomOut(): boolean { return getZoom() > ZOOM_LEVELS[0]!; }

export function applyZoom(): void {
  document.documentElement.style.zoom = `${getZoom()}%`;
}
