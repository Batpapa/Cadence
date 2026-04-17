import type { AppState, FileEntry } from './types';
import { t } from './services/i18nService';

export function generateId(): string {
  return crypto.randomUUID();
}

export function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function knowledgeColor(k: number): string {
  if (k >= 0.75) return 'bg-success';
  if (k >= 0.4)  return 'bg-warn';
  return 'bg-danger';
}

export function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor(diff / 60000);
  if (days > 30) return t('time.ago.months', { n: Math.floor(days / 30) });
  if (days > 0)  return t('time.ago.days',   { n: days });
  if (hours > 0) return t('time.ago.hours',  { n: hours });
  if (minutes > 0) return t('time.ago.minutes', { n: minutes });
  return t('time.ago.justNow');
}

export const DAY_NAMES_KEYS = [
  'time.days.sun', 'time.days.mon', 'time.days.tue', 'time.days.wed',
  'time.days.thu', 'time.days.fri', 'time.days.sat',
] as const;

export function fileToEntry(file: File): Promise<FileEntry> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target!.result as string;
      const base64 = dataUrl.split(',')[1] ?? '';
      resolve({ name: file.name, data: base64, mimeType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function entryToObjectUrl(entry: FileEntry): string {
  const bytes = atob(entry.data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: entry.mimeType });
  return URL.createObjectURL(blob);
}

export function emptyState(): AppState {
  return {
    users: {},
    currentUserId: '',
    cards: {},
    decks: {},
    cardWorks: {},
    folders: {},
    rootFolderIds: [],
    rootDeckIds: [],
  };
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function renderKnowledgeBar(
  buckets: [number, number, number, number],
  total: number,
  className: string
): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = className;
  if (total > 0) {
    for (const [i, cls] of (['bg-danger', 'bg-warn', 'bg-success/60', 'bg-success'] as const).entries()) {
      const w = buckets[i]! / total;
      if (w === 0) continue;
      const seg = document.createElement('div'); seg.className = cls; seg.style.width = `${w * 100}%`;
      bar.appendChild(seg);
    }
  }
  return bar;
}

export function makeInlineEditable(el: HTMLElement, currentValue: string, onSave: (val: string) => void): void {
  el.className = 'text-xl font-semibold text-primary cursor-text hover:text-accent transition-colors';
  el.title = 'Click to rename';
  el.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = currentValue;
    inp.className = 'text-xl font-semibold bg-transparent border-b border-accent outline-none text-primary w-full';
    el.replaceWith(inp); inp.focus(); inp.select();
    const commit = () => {
      const val = inp.value.trim();
      if (val && val !== currentValue) { onSave(val); }
      else { inp.replaceWith(el); }
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.replaceWith(el); }
    });
  };
}

export function unlinkIcon(size = 11): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="2" y1="2" x2="22" y2="22"/>';
  return svg;
}

export function helpIcon(size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
  return svg;
}

export function trashIcon(size = 14): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<path d="M2 4h12"/><path d="M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4"/><path d="M3.5 4l.9 9a.5.5 0 0 0 .5.5h6.2a.5.5 0 0 0 .5-.5l.9-9"/><path d="M6.5 7v4M9.5 7v4"/>';
  return svg;
}

