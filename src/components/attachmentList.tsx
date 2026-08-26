import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Attachment, FileEntry, EmbedEntry, CardReferenceAttachment } from '../types';
import { fileToEntry, entryToObjectUrl, generateId, focusIfDesktop, addTouchDragSupport, sortByRelevance } from '../utils';
import { TrashIcon } from './icons';
import { showPreviewModal } from './fileViewer';
import { showEmbedModal } from './embedViewer';
import { detectPlatform, resolveEmbed, PLATFORM_ICONS } from '../services/embedService';
import { resolveCardRef } from '../services/cardRefService';
import { appState, navigate } from '../store';
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

// ── Drag-to-reorder ────────────────────────────────────────────────────────────
// Same rationale as sidebar.tsx's identical pattern: dragover can fire many
// times a second, so the drop indicator is toggled via direct DOM
// manipulation on the row's own ref instead of Preact state, to avoid a
// re-render storm during every drag gesture. Scoped per <AttachmentList>
// instance (a ref, not module-level like sidebar's) since more than one list
// could in principle be on screen at once.
interface DragScratch { draggedIdx: number | null; indicatorEl: HTMLElement | null }

function clearIndicator(scratch: DragScratch): void {
  scratch.indicatorEl?.classList.remove('drop-before', 'drop-after');
  scratch.indicatorEl = null;
}

function useReorderDrag(
  ref: RefObject<HTMLDivElement>, index: number, editable: boolean,
  scratch: DragScratch, onReorder: (from: number, insertBefore: number) => void,
): void {
  useEffect(() => {
    if (!editable) return;
    const el = ref.current;
    if (!el) return;
    el.draggable = true;

    const onDragStart = (e: DragEvent) => {
      scratch.draggedIdx = index;
      e.dataTransfer?.setData('text/plain', String(index));
      setTimeout(() => el.classList.add('opacity-40'), 0);
    };
    const onDragEnd = () => { el.classList.remove('opacity-40'); clearIndicator(scratch); };
    const onDragOver = (e: DragEvent) => {
      if (scratch.draggedIdx === null || scratch.draggedIdx === index) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const zone = (e.clientY - rect.top) / rect.height < 0.5 ? 'drop-before' : 'drop-after';
      if (scratch.indicatorEl !== el || !el.classList.contains(zone)) {
        clearIndicator(scratch);
        el.classList.add(zone);
        scratch.indicatorEl = el;
      }
    };
    const onDragLeave = (e: DragEvent) => { if (!el.contains(e.relatedTarget as Node)) clearIndicator(scratch); };
    const onDrop = (e: DragEvent) => {
      if (scratch.draggedIdx === null || scratch.draggedIdx === index) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) / rect.height < 0.5;
      clearIndicator(scratch);
      const from = scratch.draggedIdx;
      scratch.draggedIdx = null;
      onReorder(from, before ? index : index + 1);
    };

    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragend', onDragEnd);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    addTouchDragSupport(el);
    // eslint-disable-next-line
  }, [index, editable]);
}

function AttachmentRow({ index, editable, onReorder, scratch, children }: {
  index: number;
  editable: boolean;
  onReorder: (from: number, insertBefore: number) => void;
  scratch: DragScratch;
  children: preact.ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useReorderDrag(ref, index, editable, scratch, onReorder);
  return (
    <div ref={ref} class="flex items-center gap-2 px-3 py-1.5 rounded border border-border group">
      {editable && (
        <span class="text-dim opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 text-xs select-none transition-opacity">⠿</span>
      )}
      {children}
    </div>
  );
}

// ── Row content ──────────────────────────────────────────────────────────────

function FileRowContent({ entry, onRemove, editable, onSave, onSetPreferredIndex }: {
  entry: FileEntry & { preferredIndex?: number };
  onRemove: () => void;
  editable: boolean;
  onSave?: (data: string) => void;
  onSetPreferredIndex?: (index: number) => void;
}) {
  const previewable = isPreviewable(entry);
  return (
    <>
      <span class="text-[11px] text-dim shrink-0 w-4 text-center font-mono">{mimeIcon(entry)}</span>
      <span
        class={`text-xs font-mono truncate flex-1 ${previewable ? 'text-muted hover:text-primary cursor-pointer transition-colors' : 'text-dim'}`}
        // Favoriting a version isn't "editing" the card — available regardless of `editable`.
        onClick={previewable ? () => showPreviewModal(entry, editable ? onSave : undefined, { initialIndex: entry.preferredIndex, onSetPreferredIndex }) : undefined}
      >
        {entry.name}
      </span>
      <a
        href={entryToObjectUrl(entry)} download={entry.name}
        class="text-xs text-dim hover:text-accent transition-colors shrink-0 opacity-0 group-hover:opacity-100"
        title={t('fileViewer.download')}
      >↓</a>
      {editable && (
        <button
          class="text-dim hover:text-danger transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100"
          title={t('fileViewer.remove')} onClick={onRemove}
        >
          <TrashIcon size={11} />
        </button>
      )}
    </>
  );
}

function EmbedRowContent({ entry, onRemove, editable }: { entry: EmbedEntry; onRemove: () => void; editable: boolean }) {
  const platform = detectPlatform(entry.url);
  const icon = platform ? PLATFORM_ICONS[platform] : '⛓';
  let label = entry.title;
  if (!label) {
    try {
      const u = new URL(entry.url);
      label = u.hostname.replace('www.', '') + u.pathname.split('/').slice(0, 3).join('/');
    } catch { label = entry.url; }
  }
  return (
    <>
      <span class="text-[11px] text-dim shrink-0 w-4 text-center font-mono">{icon}</span>
      <span
        class="text-xs font-mono truncate flex-1 text-muted hover:text-primary cursor-pointer transition-colors"
        title={entry.url} onClick={() => showEmbedModal(entry)}
      >{label}</span>
      <button
        class="text-xs text-dim hover:text-accent transition-colors shrink-0 opacity-0 group-hover:opacity-100 cursor-pointer"
        title={t('embed.play')} onClick={() => showEmbedModal(entry)}
      >▶</button>
      {editable && (
        <button
          class="text-dim hover:text-danger transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100"
          title={t('embed.remove')} onClick={onRemove}
        >
          <TrashIcon size={11} />
        </button>
      )}
    </>
  );
}

function CardRefRowContent({ entry, onRemove, editable }: { entry: CardReferenceAttachment; onRemove: () => void; editable: boolean }) {
  const resolved = resolveCardRef(entry, appState.value.cards);
  return (
    <>
      <span class="text-[11px] text-dim shrink-0 w-4 text-center font-mono">↗</span>
      {resolved ? (
        <span
          class="text-xs font-mono truncate flex-1 text-muted hover:text-primary cursor-pointer transition-colors"
          title={t('fileViewer.cardRef.open')} onClick={() => navigate({ view: 'card', cardId: resolved.id })}
        >{resolved.name}</span>
      ) : (
        <span class="text-xs font-mono truncate flex-1 text-dim">
          {entry.title}<span class="ml-1 text-danger text-[10px]">{t('fileViewer.cardRef.unresolved')}</span>
        </span>
      )}
      {editable && (
        <button
          class="text-dim hover:text-danger transition-colors cursor-pointer shrink-0 opacity-0 group-hover:opacity-100"
          title={t('fileViewer.remove')} onClick={onRemove}
        >
          <TrashIcon size={11} />
        </button>
      )}
    </>
  );
}

// ── Add-card picker (its own small modal — vanilla body, same as before) ───────

function showCardRefPicker(onAdd: (a: Attachment) => void): void {
  const body = document.createElement('div');
  body.className = 'space-y-2';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = t('fileViewer.cardRef.search');
  inp.className = 'input text-sm';

  const listEl = document.createElement('div');
  listEl.className = 'max-h-60 overflow-y-auto space-y-0.5';

  const renderList = (query: string) => {
    listEl.innerHTML = '';
    const q = query.trim().toLowerCase();
    const cards = Object.values(appState.value.cards);
    const filtered = q ? cards.filter(c => c.name.toLowerCase().includes(q)) : cards;
    const sorted = q
      ? sortByRelevance(filtered, q)
      : [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    for (const card of sorted) {
      const item = document.createElement('button');
      item.className = 'w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent/10 transition-colors cursor-pointer';
      item.textContent = card.name;
      item.onclick = () => {
        onAdd({ type: 'card', id: card.id, guid: card.guid, externalId: card.externalId, title: card.name });
        closeModal();
      };
      listEl.appendChild(item);
    }
  };

  renderList('');
  inp.addEventListener('input', () => renderList(inp.value));
  body.append(inp, listEl);

  showModal(t('fileViewer.cardRef.title'), body, []);
  focusIfDesktop(inp);
}

function addLink(onAdd: (a: Attachment) => void): void {
  const body = document.createElement('div'); body.className = 'space-y-3';
  const inp = document.createElement('input');
  inp.type = 'url'; inp.placeholder = t('embed.placeholder');
  inp.className = 'input text-xs';
  const errorEl = document.createElement('p'); errorEl.className = 'text-xs text-danger'; errorEl.style.display = 'none';
  const setError = (msg: string) => { errorEl.textContent = msg; errorEl.style.display = 'block'; };
  body.append(inp, errorEl);

  const doAdd = async () => {
    const url = inp.value.trim();
    if (!url) return;
    if (!detectPlatform(url)) { setError(t('embed.unsupported')); return; }
    setError(t('embed.checking'));
    const meta = await resolveEmbed(url);
    if (!meta) { setError(t('embed.error')); return; }
    onAdd({ type: 'embed', id: generateId(), url, title: meta.title, embedUrl: meta.embedUrl });
    closeModal();
  };

  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { void doAdd(); } });
  showModal(t('embed.addTitle'), body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('common.add'), primary: true, onClick: () => { void doAdd(); } },
  ]);
  focusIfDesktop(inp);
}

function addFiles(onAdd: (a: Attachment) => void): void {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  inp.onchange = async () => {
    for (const file of Array.from(inp.files ?? [])) {
      const entry = await fileToEntry(file);
      onAdd({ type: 'file', ...entry });
    }
  };
  inp.click();
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AttachmentListOptions {
  attachments: Attachment[];
  editable: boolean;
  onAdd?: (a: Attachment) => void;
  onRemove?: (i: number) => void;
  onReorder?: (from: number, insertBefore: number) => void;
  /** Persists an edited file's content (currently only wired for the ABC
   *  raw-text editor in the preview modal). */
  onUpdateFile?: (i: number, data: string) => void;
  /** Persists the "★ default version" pick for a multi-tune ABC file — wired
   *  even where `editable` is false (study), since it's a viewing preference,
   *  not a content edit. */
  onSetPreferredIndex?: (i: number, index: number) => void;
}

export function AttachmentList({ options }: { options: AttachmentListOptions }) {
  const { attachments, editable } = options;
  const onAdd     = options.onAdd     ?? (() => {});
  const onRemove  = options.onRemove  ?? (() => {});
  const onReorder = options.onReorder ?? (() => {});
  const onUpdateFile = options.onUpdateFile;
  const onSetPreferredIndex = options.onSetPreferredIndex;

  const scratch = useRef<DragScratch>({ draggedIdx: null, indicatorEl: null }).current;

  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="section-title">{t('fileViewer.attachments')}</span>
        {editable && (
          <div class="flex gap-2">
            <button class="btn-ghost text-xs" onClick={() => addFiles(onAdd)}>{t('fileViewer.addFile')}</button>
            <button class="btn-ghost text-xs" onClick={() => addLink(onAdd)}>{t('fileViewer.addLink')}</button>
            <button class="btn-ghost text-xs" onClick={() => showCardRefPicker(onAdd)}>{t('fileViewer.addCard')}</button>
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div class="space-y-1">
          {attachments.map((att, i) => (
            <AttachmentRow key={i} index={i} editable={editable} onReorder={onReorder} scratch={scratch}>
              {att.type === 'file' ? (
                <FileRowContent
                  entry={att} onRemove={() => onRemove(i)} editable={editable}
                  onSave={onUpdateFile ? (data) => onUpdateFile(i, data) : undefined}
                  onSetPreferredIndex={onSetPreferredIndex ? (index) => onSetPreferredIndex(i, index) : undefined}
                />
              ) : att.type === 'card' ? (
                <CardRefRowContent entry={att} onRemove={() => onRemove(i)} editable={editable} />
              ) : (
                <EmbedRowContent entry={att} onRemove={() => onRemove(i)} editable={editable} />
              )}
            </AttachmentRow>
          ))}
        </div>
      )}
    </div>
  );
}
