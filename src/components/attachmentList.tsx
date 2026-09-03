import { useEffect, useRef, useMemo } from 'preact/hooks';
import type { RefObject, ComponentChild } from 'preact';
import type { Attachment, FileEntry, EmbedEntry, Card, CardRef } from '../types';
import { fileToEntry, entryToObjectUrl, generateId, focusIfDesktop, addTouchDragSupport, sortByRelevance } from '../utils';
import { TrashIcon, PlusIcon, GearIcon } from './icons';
import { useContextMenu } from './contextMenu';
import { showPreviewModal } from './fileViewer';
import { showEmbedModal } from './embedViewer';
import { detectPlatform, resolveEmbed, PLATFORM_ICONS } from '../services/embedService';
import { resolveCardRef } from '../services/cardRefService';
import { tunesetAbcEntry, tunesetAbcFileName, clampRepeat, MAX_REPEAT, TUNESET_ABC_NAME } from '../services/abcService';
import { isTuneset } from '../services/cardTypeService';
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

function FileRowContent({ entry, onRemove, editable, onSave, onSetPreferredIndex, glyph, downloadName }: {
  entry: FileEntry & { preferredIndex?: number };
  onRemove: () => void;
  editable: boolean;
  onSave?: (data: string) => void;
  onSetPreferredIndex?: (index: number) => void;
  /** What the download is called, when that must differ from what is shown —
   *  a set name contains slashes, which no filesystem accepts, but the row is
   *  just a label and should read as the set is really called. */
  downloadName?: string;
  /** Replaces the MIME glyph. Used to mark a file the app generates, which is
   *  not the same kind of thing as one the user attached. */
  glyph?: ComponentChild;
}) {
  const previewable = isPreviewable(entry);
  return (
    <>
      <span class="text-[11px] text-dim shrink-0 w-4 flex items-center justify-center font-mono">{glyph ?? mimeIcon(entry)}</span>
      <span
        class={`text-xs font-mono truncate flex-1 ${previewable ? 'text-muted hover:text-primary cursor-pointer transition-colors' : 'text-dim'}`}
        // Favoriting a version isn't "editing" the card — available regardless of `editable`.
        onClick={previewable ? () => showPreviewModal(entry, editable ? onSave : undefined, { initialIndex: entry.preferredIndex, onSetPreferredIndex }) : undefined}
      >
        {entry.name}
      </span>
      <a
        href={entryToObjectUrl(entry)} download={downloadName ?? entry.name}
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

function CardRefRowContent({ entry, onRemove, editable, glyph = '↗' }: { entry: CardRef; onRemove: () => void; editable: boolean; glyph?: ComponentChild }) {
  const resolved = resolveCardRef(entry, appState.value.cards);
  return (
    <>
      {/* flex, not the inline span the other row types use: `w-4`/`text-center`
          are both no-ops on a non-replaced inline element, which went unnoticed
          while the glyph was a single character and stopped being true the
          moment it became an SVG. */}
      <span class="text-[11px] text-dim shrink-0 w-4 flex items-center justify-center font-mono">{glyph}</span>
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

/** Search-and-pick one card from the library.
 *
 *  `eligible` narrows the candidates (a tuneset offers only what may be one of
 *  its tunes); `titleKey` names the modal, since "add a reference" and "add a
 *  tune" are not the same act even though they pick the same way. */
export function showCardPicker(
  onPick: (card: Card) => void,
  opts: { titleKey?: string; eligible?: (card: Card) => boolean; emptyKey?: string } = {},
): void {
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
    const cards = Object.values(appState.value.cards).filter(opts.eligible ?? (() => true));
    const filtered = q ? cards.filter(c => c.name.toLowerCase().includes(q)) : cards;
    const sorted = q
      ? sortByRelevance(filtered, q)
      : [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    for (const card of sorted) {
      const item = document.createElement('button');
      item.className = 'w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent/10 transition-colors cursor-pointer';
      item.textContent = card.name;
      item.onclick = () => {
        onPick(card);
        closeModal();
      };
      listEl.appendChild(item);
    }
    // An eligibility filter can empty the list for a reason the user cannot
    // see — "only tunes appear here" is invisible when every candidate was
    // filtered out. Say it rather than showing a blank box.
    if (sorted.length === 0 && opts.emptyKey) {
      const note = document.createElement('p');
      note.className = 'text-xs text-dim px-2 py-1.5';
      note.textContent = t(opts.emptyKey);
      listEl.appendChild(note);
    }
  };

  renderList('');
  inp.addEventListener('input', () => renderList(inp.value));
  body.append(inp, listEl);

  showModal(t(opts.titleKey ?? 'fileViewer.cardRef.title'), body, []);
  focusIfDesktop(inp);
}

/** The reference payload of a card — what both roles store about a target. */
export function cardToRef(card: Card): CardRef {
  return { id: card.id, guid: card.guid, externalId: card.externalId, title: card.name };
}

function showCardRefPicker(onAdd: (a: Attachment) => void): void {
  showCardPicker(card => onAdd({ type: 'card', ...cardToRef(card) }));
}

/** An ordered, reorderable list of card references, rendered as rows like the
 *  attachment list's own — same drag machinery, same resolution, same
 *  unresolved state. Used for a tuneset's tunes.
 *
 *  Rows are deliberately NOT numbered: the order is already the order they are
 *  drawn in, so an ordinal would only restate the row's own position. `glyph`
 *  says what kind of thing each row is instead. */
export function CardRefList({ refs, editable, onRemove, onReorder, glyph, onSetRepeat }: {
  refs: CardRef[];
  editable: boolean;
  onRemove: (i: number) => void;
  onReorder: (from: number, insertBefore: number) => void;
  glyph?: ComponentChild;
  /** Shows a repeat counter on each row when given. Click cycles it: a set
   *  repeats two or three times in practice, so a stepper would be more
   *  machinery than the choice deserves. */
  onSetRepeat?: (i: number, repeat: number) => void;
}) {
  const scratch = useRef<DragScratch>({ draggedIdx: null, indicatorEl: null }).current;
  if (refs.length === 0) return null;
  return (
    <div class="space-y-1">
      {refs.map((ref, i) => (
        <AttachmentRow key={i} index={i} editable={editable} onReorder={onReorder} scratch={scratch}>
          <CardRefRowContent entry={ref} editable={editable} onRemove={() => onRemove(i)} glyph={glyph} />
          {onSetRepeat && (
            <button
              type="button"
              class={`shrink-0 text-[11px] font-mono px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                clampRepeat(ref.repeat) > 1 ? 'text-accent bg-accent/10' : 'text-dim hover:text-muted'
              }`}
              title={t('card.tunes.repeatTitle')}
              onClick={() => onSetRepeat(i, clampRepeat(ref.repeat) % MAX_REPEAT + 1)}
            >×{clampRepeat(ref.repeat)}</button>
          )}
        </AttachmentRow>
      ))}
    </div>
  );
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
  /** The card these attachments belong to. Only needed to resolve a set's
   *  generated score, whose stored `data` is empty by design — everything else
   *  here works from the attachments alone. */
  card?: Card;
}

export function AttachmentList({ options }: { options: AttachmentListOptions }) {
  const { attachments, editable } = options;
  const onAdd     = options.onAdd     ?? (() => {});
  const onRemove  = options.onRemove  ?? (() => {});
  const onReorder = options.onReorder ?? (() => {});
  const onUpdateFile = options.onUpdateFile;
  const onSetPreferredIndex = options.onSetPreferredIndex;
  const card = options.card;

  const scratch = useRef<DragScratch>({ draggedIdx: null, indicatorEl: null }).current;

  // A set's score is REBUILT here rather than read from the attachment: what is
  // stored is only the intent to show one. Recomputed whenever the library
  // changes, so it cannot lag behind a tune being renamed, restarred, added or
  // removed — and it costs nothing in the synced blob.
  const generatedAbc = useMemo(
    () => (card && isTuneset(card) ? tunesetAbcEntry(card, appState.value.cards) : null),
    [card, appState.value.cards],
  );
  const hasTunesetAbc = attachments.some(a => a.type === 'file' && a.generatedBy === 'tuneset');

  /** The stored entry carries no content and a placeholder name; this is what
   *  is shown, previewed and downloaded. The NAME is derived too, so it follows
   *  the set being renamed — including automatically, which happens whenever a
   *  tune is added or renamed. */
  const resolve = (att: Attachment): Attachment => (
    att.type === 'file' && att.generatedBy === 'tuneset' && generatedAbc && card
      ? { ...att, data: generatedAbc.data, mimeType: generatedAbc.mimeType, name: card.name + '.abc' }
      : att
  );

  // One "+" raising the same overflow menu the library's ⋯ uses, rather than
  // three permanent buttons: the choice is made once per addition and does
  // not deserve standing header real estate. Each entry closes the menu
  // before it runs, so an entry may safely open a modal of its own.
  const addMenu = useContextMenu([
    { label: t('fileViewer.addFile'), onClick: () => addFiles(onAdd) },
    { label: t('fileViewer.addLink'), onClick: () => addLink(onAdd) },
    { label: t('fileViewer.addCard'), onClick: () => showCardRefPicker(onAdd) },
    // Sets only, and once only — the entry disappears rather than being offered
    // and refused, like every other impossible action in this app.
    ...(card && isTuneset(card) && !hasTunesetAbc
      ? [{
          label: t('fileViewer.addTunesetAbc'),
          onClick: () => onAdd({
            type: 'file' as const, name: TUNESET_ABC_NAME, mimeType: 'text/vnd.abc',
            data: '', generatedBy: 'tuneset' as const,
          }),
        }]
      : []),
  ]);

  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="section-title">{t('fileViewer.attachments')}</span>
        {editable && (
          <>
            <button
              class="btn-ghost px-2"
              title={t('fileViewer.addAttachment')}
              onClick={(e) => addMenu.open(e.clientX, e.clientY)}
            >
              <PlusIcon size={13} />
            </button>
            {addMenu.menu}
          </>
        )}
      </div>

      {attachments.length > 0 && (
        <div class="space-y-1">
          {attachments.map((att, i) => (
            <AttachmentRow key={i} index={i} editable={editable} onReorder={onReorder} scratch={scratch}>
              {att.type === 'file' ? (
                <FileRowContent
                  entry={resolve(att) as FileEntry & { preferredIndex?: number }}
                  onRemove={() => onRemove(i)} editable={editable}
                  // A gear rather than the clef: this file is produced by the
                  // app, not attached by the user, and that is worth seeing.
                  glyph={att.generatedBy === 'tuneset' ? <GearIcon size={12} filled /> : undefined}
                  downloadName={att.generatedBy === 'tuneset' && card ? tunesetAbcFileName(card.name) : undefined}
                  // A derived score has nowhere to save an edit back to, and a
                  // fused set is a single page — so neither editing its text
                  // nor starring a version applies to it.
                  onSave={onUpdateFile && att.generatedBy !== 'tuneset' ? (data) => onUpdateFile(i, data) : undefined}
                  onSetPreferredIndex={onSetPreferredIndex && att.generatedBy !== 'tuneset' ? (index) => onSetPreferredIndex(i, index) : undefined}
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
