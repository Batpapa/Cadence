import type { EmbedEntry } from '../types';
import { detectPlatform, IFRAME_DIMS } from '../services/embedService';
import { t } from '../services/i18nService';

// ── Preview modal ─────────────────────────────────────────────────────────────

export function showEmbedModal(entry: EmbedEntry): void {
  const platform = detectPlatform(entry.url);
  const dims = platform ? IFRAME_DIMS[platform] : { width: '600px', height: '400px' };

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden mx-4';
  dialog.style.maxWidth = '90vw';
  dialog.style.maxHeight = '90vh';
  dialog.style.width = dims.width;

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-3 border-b border-border shrink-0';
  const titleEl = document.createElement('span');
  titleEl.className = 'text-xs font-mono text-muted truncate';
  titleEl.textContent = entry.title ?? entry.url;

  let onKey: (e: KeyboardEvent) => void;
  const closeModal = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };

  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer shrink-0 ml-4';
  closeBtn.textContent = '✕'; closeBtn.onclick = closeModal;
  header.append(titleEl, closeBtn);

  const body = document.createElement('div');
  body.className = 'flex-1 flex items-center justify-center p-4';

  if (entry.embedUrl) {
    const iframe = document.createElement('iframe');
    iframe.src = entry.embedUrl;
    iframe.style.cssText = `width:100%;height:${dims.height};border:none;`;
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    body.appendChild(iframe);
  } else {
    const msg = document.createElement('p');
    msg.className = 'text-sm text-dim italic';
    msg.textContent = t('embed.error');
    body.appendChild(msg);
  }

  dialog.append(header, body);
  overlay.appendChild(dialog);

  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { mouseDownOnOverlay = e.target === overlay; });
  overlay.onclick = (e) => { if (e.target === overlay && mouseDownOnOverlay) closeModal(); };
  onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

