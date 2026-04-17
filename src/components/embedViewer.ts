import type { EmbedEntry } from '../types';
import { generateId } from '../utils';
import { resolveEmbed, detectPlatform, PLATFORM_ICONS, IFRAME_DIMS } from '../services/embedService';
import { showModal, closeModal } from './modal';
import { t } from '../services/i18nService';

// ── Preview modal ─────────────────────────────────────────────────────────────

function showEmbedModal(entry: EmbedEntry): void {
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

// ── Single embed row ──────────────────────────────────────────────────────────

function renderEmbedRow(entry: EmbedEntry, onRemove: () => void, editable: boolean): HTMLElement {
  const platform = detectPlatform(entry.url);
  const icon = platform ? PLATFORM_ICONS[platform] : '⛓';

  const row = document.createElement('div');
  row.className = 'flex items-center gap-2 px-3 py-1.5 rounded border border-border group';

  const iconEl = document.createElement('span');
  iconEl.className = 'text-[11px] text-dim shrink-0 w-4 text-center font-mono';
  iconEl.textContent = icon;

  const label = document.createElement('span');
  label.className = 'text-xs font-mono truncate flex-1 text-muted hover:text-primary cursor-pointer transition-colors';
  if (entry.title) {
    label.textContent = entry.title;
  } else {
    try {
      const u = new URL(entry.url);
      label.textContent = u.hostname.replace('www.', '') + u.pathname.split('/').slice(0, 3).join('/');
    } catch { label.textContent = entry.url; }
  }
  label.title = entry.url;
  label.onclick = () => showEmbedModal(entry);

  const openBtn = document.createElement('button');
  openBtn.className = 'text-xs text-dim hover:text-accent transition-colors shrink-0 opacity-0 group-hover:opacity-100 cursor-pointer';
  openBtn.textContent = '▶'; openBtn.title = t('embed.play');
  openBtn.onclick = () => showEmbedModal(entry);

  row.append(iconEl, label, openBtn);

  if (editable) {
    const rm = document.createElement('button');
    rm.className = 'text-dim hover:text-danger text-xs transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100';
    rm.textContent = '✕'; rm.title = t('embed.remove'); rm.onclick = onRemove;
    row.appendChild(rm);
  }

  return row;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderEmbeds(options: {
  embeds: EmbedEntry[];
  editable: boolean;
  onAdd?: (e: EmbedEntry) => void;
  onRemove?: (i: number) => void;
}): HTMLElement {
  const { embeds, editable } = options;
  const onAdd    = options.onAdd    ?? (() => {});
  const onRemove = options.onRemove ?? (() => {});

  const wrap = document.createElement('div'); wrap.className = 'space-y-2';

  const header = document.createElement('div'); header.className = 'flex items-center justify-between';
  const titleEl = document.createElement('span'); titleEl.className = 'section-title';
  titleEl.textContent = t('embed.section');
  header.appendChild(titleEl);

  if (editable) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-ghost text-xs'; addBtn.textContent = t('embed.add');

    addBtn.onclick = () => {
      const body = document.createElement('div'); body.className = 'space-y-3';
      const inp = document.createElement('input');
      inp.type = 'url'; inp.placeholder = t('embed.placeholder');
      inp.className = 'input text-xs';
      const errorEl = document.createElement('p'); errorEl.className = 'text-xs text-danger min-h-[1rem]';
      body.append(inp, errorEl);

      const doAdd = async () => {
        const url = inp.value.trim();
        if (!url) return;
        if (!detectPlatform(url)) { errorEl.textContent = t('embed.unsupported'); return; }
        errorEl.textContent = t('embed.checking');
        const meta = await resolveEmbed(url);
        if (!meta) { errorEl.textContent = t('embed.error'); return; }
        onAdd({ id: generateId(), url, title: meta.title, embedUrl: meta.embedUrl });
        closeModal();
      };

      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { void doAdd(); } });
      showModal(t('embed.addTitle'), body, [
        { label: t('common.cancel'), onClick: closeModal },
        { label: t('common.add'), primary: true, onClick: () => { void doAdd(); } },
      ]);
      setTimeout(() => inp.focus(), 30);
    };

    header.appendChild(addBtn);
  }
  wrap.appendChild(header);

  if (embeds.length > 0) {
    const list = document.createElement('div'); list.className = 'space-y-1';
    embeds.forEach((entry, i) => list.appendChild(renderEmbedRow(entry, () => onRemove(i), editable)));
    wrap.appendChild(list);
  }

  return wrap;
}
