import type { AppState, FileEntry } from './types';

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
  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

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

