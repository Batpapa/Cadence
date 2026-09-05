import type { EmbedEntry } from '../types';
import { detectPlatform, IFRAME_DIMS } from '../services/embedService';
import { t } from '../services/i18nService';
import { modalMaxH } from '../services/zoomService';
import { showModal } from './modal';

// ── Preview modal ─────────────────────────────────────────────────────────────
// Delegates the overlay/dialog/close/outside-click/Escape shell to the shared
// Preact modal (modal.tsx, 2026-08-26) instead of building its own — only the
// iframe-vs-error body is still hand-built here.

export function showEmbedModal(entry: EmbedEntry): void {
  const platform = detectPlatform(entry.url);
  const dims = platform ? IFRAME_DIMS[platform] : { width: '600px', height: '400px' };

  const body = document.createElement('div');
  body.className = 'flex-1 flex items-center justify-center';

  if (entry.embedUrl) {
    const iframe = document.createElement('iframe');
    iframe.src = entry.embedUrl;
    iframe.style.cssText = `width:100%;height:min(${dims.height}, calc(${modalMaxH(0.85)} - 80px));border:none;`;
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    body.appendChild(iframe);
  } else {
    const msg = document.createElement('p');
    msg.className = 'text-sm text-dim italic';
    msg.textContent = t('embed.error');
    body.appendChild(msg);
  }

  showModal(entry.title ?? entry.url, body, [], { maxWidth: dims.width });
}
