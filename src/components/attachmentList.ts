import type { Attachment, FileEntry, EmbedEntry } from '../types';
import { fileToEntry, entryToObjectUrl, generateId, focusIfDesktop, addTouchDragSupport } from '../utils';
import { showPreviewModal } from './fileViewer';
import { showEmbedModal } from './embedViewer';
import { detectPlatform, resolveEmbed, PLATFORM_ICONS } from '../services/embedService';
import { showModal, closeModal } from './modal';
import { t } from '../services/i18nService';

// ── MIME helpers ──────────────────────────────────────────────────────────────

function isPreviewable(entry: FileEntry): boolean {
  const m = entry.mimeType;
  return m.startsWith('audio/') || m.startsWith('image/') || m.startsWith('video/') ||
    m === 'application/pdf' || m.startsWith('text/') ||
    entry.name.endsWith('.md') || entry.name.endsWith('.txt') ||
    entry.name.endsWith('.abc') || m === 'text/vnd.abc';
}

function mimeIcon(entry: FileEntry): string {
  const m = entry.mimeType;
  if (entry.name.endsWith('.abc') || m === 'text/vnd.abc') return '𝄞';
  if (m.startsWith('audio/'))  return '♫';
  if (m.startsWith('video/'))  return '▶';
  if (m.startsWith('image/'))  return '▣';
  if (m === 'application/pdf') return '≣';
  if (m.startsWith('text/') || entry.name.endsWith('.md') || entry.name.endsWith('.txt')) return '¶';
  return '◈';
}

// ── Row renderers ─────────────────────────────────────────────────────────────

function renderFileRow(entry: FileEntry, onRemove: () => void, editable: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'flex items-center gap-2 px-3 py-1.5 rounded border border-border group';

  const icon = document.createElement('span');
  icon.className = 'text-[11px] text-dim shrink-0 w-4 text-center font-mono';
  icon.textContent = mimeIcon(entry);

  const name = document.createElement('span');
  name.className = 'text-xs font-mono truncate flex-1';
  if (isPreviewable(entry)) {
    name.className += ' text-muted hover:text-primary cursor-pointer transition-colors';
    name.onclick = () => showPreviewModal(entry);
  } else {
    name.className += ' text-dim';
  }
  name.textContent = entry.name;

  const dl = document.createElement('a');
  dl.href = entryToObjectUrl(entry); dl.download = entry.name;
  dl.className = 'text-xs text-dim hover:text-accent transition-colors shrink-0 opacity-0 group-hover:opacity-100';
  dl.textContent = '↓'; dl.title = t('fileViewer.download');

  wrap.append(icon, name, dl);

  if (editable) {
    const rm = document.createElement('button');
    rm.className = 'text-dim hover:text-danger text-xs transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100';
    rm.textContent = '✕'; rm.title = t('fileViewer.remove'); rm.onclick = onRemove;
    wrap.appendChild(rm);
  }

  return wrap;
}

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

export function renderAttachmentList(options: {
  attachments: Attachment[];
  editable: boolean;
  onAdd?: (a: Attachment) => void;
  onRemove?: (i: number) => void;
  onReorder?: (from: number, insertBefore: number) => void;
}): HTMLElement {
  const { attachments, editable } = options;
  const onAdd     = options.onAdd     ?? (() => {});
  const onRemove  = options.onRemove  ?? (() => {});
  const onReorder = options.onReorder ?? (() => {});

  const wrap = document.createElement('div');
  wrap.className = 'space-y-2';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between';

  const titleEl = document.createElement('span');
  titleEl.className = 'section-title';
  titleEl.textContent = t('fileViewer.attachments');
  header.appendChild(titleEl);

  if (editable) {
    const btnRow = document.createElement('div');
    btnRow.className = 'flex gap-2';

    const fileBtn = document.createElement('button');
    fileBtn.className = 'btn-ghost text-xs'; fileBtn.textContent = t('fileViewer.addFile');
    fileBtn.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true;
      inp.onchange = async () => {
        for (const file of Array.from(inp.files ?? [])) {
          const entry = await fileToEntry(file);
          onAdd({ type: 'file', ...entry });
        }
      };
      inp.click();
    };

    const linkBtn = document.createElement('button');
    linkBtn.className = 'btn-ghost text-xs'; linkBtn.textContent = t('fileViewer.addLink');
    linkBtn.onclick = () => {
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
        onAdd({ type: 'embed', id: generateId(), url, title: meta.title, embedUrl: meta.embedUrl });
        closeModal();
      };

      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { void doAdd(); } });
      showModal(t('embed.addTitle'), body, [
        { label: t('common.cancel'), onClick: closeModal },
        { label: t('common.add'), primary: true, onClick: () => { void doAdd(); } },
      ]);
      focusIfDesktop(inp);
    };

    btnRow.append(fileBtn, linkBtn);
    header.appendChild(btnRow);
  }

  wrap.appendChild(header);

  if (attachments.length === 0) return wrap;

  const list = document.createElement('div');
  list.className = 'space-y-1';

  let draggedIdx: number | null = null;
  let dropIndicator: HTMLElement | null = null;

  const clearIndicator = () => {
    dropIndicator?.classList.remove('drop-before', 'drop-after');
    dropIndicator = null;
  };

  attachments.forEach((att, i) => {
    const rowEl = att.type === 'file'
      ? renderFileRow(att, () => onRemove(i), editable)
      : renderEmbedRow(att, () => onRemove(i), editable);

    if (editable) {
      rowEl.draggable = true;

      const handle = document.createElement('span');
      handle.className = 'text-dim opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity';
      handle.textContent = '⠿';
      rowEl.prepend(handle);

      rowEl.addEventListener('dragstart', (e) => {
        draggedIdx = i;
        e.dataTransfer?.setData('text/plain', String(i));
        setTimeout(() => rowEl.classList.add('opacity-40'), 0);
      });
      rowEl.addEventListener('dragend', () => {
        rowEl.classList.remove('opacity-40');
        clearIndicator();
      });
      rowEl.addEventListener('dragover', (e) => {
        if (draggedIdx === null || draggedIdx === i) return;
        e.preventDefault();
        const rect = rowEl.getBoundingClientRect();
        const zone = (e.clientY - rect.top) / rect.height < 0.5 ? 'drop-before' : 'drop-after';
        if (dropIndicator !== rowEl || !rowEl.classList.contains(zone)) {
          clearIndicator();
          rowEl.classList.add(zone);
          dropIndicator = rowEl;
        }
      });
      rowEl.addEventListener('dragleave', (e) => {
        if (!rowEl.contains(e.relatedTarget as Node)) clearIndicator();
      });
      rowEl.addEventListener('drop', (e) => {
        if (draggedIdx === null || draggedIdx === i) return;
        e.preventDefault();
        const rect = rowEl.getBoundingClientRect();
        const before = (e.clientY - rect.top) / rect.height < 0.5;
        clearIndicator();
        const from = draggedIdx;
        draggedIdx = null;
        onReorder(from, before ? i : i + 1);
      });
      addTouchDragSupport(rowEl);
    }

    list.appendChild(rowEl);
  });

  wrap.appendChild(list);
  return wrap;
}
