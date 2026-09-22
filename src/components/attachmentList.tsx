import { useEffect, useRef, useMemo, useState } from 'preact/hooks';
import type { RefObject, ComponentChild } from 'preact';
import type { Attachment, FileEntry, EmbedEntry, Card, CardRef } from '../types';
import { entryToObjectUrl, generateId, focusIfDesktop, addTouchDragSupport, rankByRelevance } from '../utils';
import { TrashIcon, PlusIcon, GearIcon, WrenchIcon, PencilIcon, ExternalLinkIcon } from './icons';
import { useContextMenu } from './contextMenu';
import { showPreviewModal, type PreviewSaveResult } from './fileViewer';
import { splitFileName, renamedFileName } from '../services/attachmentNames';
import { showEmbedModal } from './embedViewer';
import { showAddFileModal } from './addFileModal';
import { showAddLinkModal, showEditLinkModal } from './addLinkModal';
import { detectPlatform, PLATFORM_ICONS, linkMode, safeExternalUrl } from '../services/embedService';
import { resolveCardRef } from '../services/cardRefService';
import { tunesetAbcEntry, tunesetAbcFileName, clampRepeat, MAX_REPEAT, tunesetAbcPlaceholder, isAbcFile } from '../services/abcService';
import { isTuneset, hasTunesetScore, CARD_TYPE_TUNE } from '../services/cardTypeService';
import { appState, navigate, getContext, mutate } from '../store';
import { showModal, closeModal, confirmModal, renderModalBody } from './modal';
import { showNewCardModal, type NewCardPreset } from './theSessionImport';
import { t } from '../services/i18nService';
import { downloadIcon } from './playbackIcons';

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
        <span class="text-dim cursor-grab active:cursor-grabbing shrink-0 text-xs select-none">⠿</span>
      )}
      {children}
    </div>
  );
}

/** Removing is instant and cannot be undone, and the trash icon now sits
 *  permanently beside every row instead of appearing on hover — which makes a
 *  misclick both easier to make and likelier. So it asks first, naming what it
 *  is about to remove.
 *
 *  `isRef` picks the wording for a row that points AT a card (a reference, or a
 *  tune in a set): there the trash icon sits next to a card's name, which is
 *  exactly what it does not delete — worth saying rather than leaving to be
 *  discovered. */
function confirmRemove(name: string, isRef: boolean, remove: () => void): void {
  confirmModal(
    t('fileViewer.remove.title'),
    t(isRef ? 'fileViewer.remove.messageRef' : 'fileViewer.remove.message', { name }),
    t('fileViewer.remove.title'),
    remove,
  );
}

// ── Row content ──────────────────────────────────────────────────────────────

function FileRowContent({ entry, onRemove, editable, onSave, onRename, onSetPreferredIndex, reloadEntry, glyph, downloadName }: {
  entry: FileEntry & { preferredIndex?: number };
  onRemove: () => void;
  editable: boolean;
  onSave?: (data: string) => PreviewSaveResult | Promise<PreviewSaveResult>;
  /** The full new name, extension kept. Absent where a file cannot be renamed. */
  onRename?: (name: string) => void;
  onSetPreferredIndex?: (index: number | undefined) => void;
  /** For a DERIVED file only — see PreviewModalOpts.reloadEntry. */
  reloadEntry?: () => FileEntry | null;
  /** What the download is called, when that must differ from what is shown —
   *  a set name contains slashes, which no filesystem accepts, but the row is
   *  just a label and should read as the set is really called. */
  downloadName?: string;
  /** Replaces the MIME glyph. Used to mark a file the app generates, which is
   *  not the same kind of thing as one the user attached. */
  glyph?: ComponentChild;
}) {
  const previewable = isPreviewable(entry);
  // Renaming in place, on the row itself: the viewer's title offers the same,
  // but not every file has a viewer (an archive, a document), and those must be
  // renamable too. The extension is shown, never edited.
  const [draft, setDraft] = useState<string | null>(null);
  // Enter commits and unmounts the field, whose blur would commit again.
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  // Focused and selected on opening, phone included: the user asked to rename,
  // so the keyboard is wanted (focusIfDesktop is for fields nobody asked for).
  // `autoFocus` did nothing — browsers only honour it at page load.
  //
  // The row stops being draggable meanwhile: a mouse drag to select text in the
  // field started the ROW's native drag, the row being the draggable element.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
    const row = input.closest<HTMLElement>('[draggable="true"]');
    if (row) row.draggable = false;
    return () => { if (row) row.draggable = true; };
  }, [editing]);
  const { base, ext } = splitFileName(entry.name);
  const finishRename = (commit: boolean) => {
    if (settled.current || draft === null) return;
    settled.current = true;
    const next = commit ? renamedFileName(entry.name, draft) : null;
    setDraft(null);
    if (next) onRename?.(next);
  };
  return (
    <>
      <span class="text-[11px] text-dim shrink-0 w-4 flex items-center justify-center font-mono">{glyph ?? mimeIcon(entry)}</span>
      {draft !== null ? (
        <span class="flex items-center gap-1 flex-1 min-w-0">
          <input
            ref={inputRef}
            class="input text-xs font-mono py-0.5 min-w-0 flex-1"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') finishRename(true);
              if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
            }}
            onBlur={() => finishRename(true)}
            // The row is draggable, and on a touch screen a long press anywhere
            // in it starts the drag (addTouchDragSupport listens on the row). A
            // finger held in this field to place the caret must not move the row.
            onTouchStart={(e) => e.stopPropagation()}
          />
          {ext && <span class="text-xs font-mono text-dim shrink-0">{ext}</span>}
        </span>
      ) : (
        <span
          class={`text-xs font-mono truncate flex-1 ${previewable ? 'text-muted hover:text-primary cursor-pointer transition-colors' : 'text-dim'}`}
          // Favoriting a version isn't "editing" the card — available regardless of `editable`.
          onClick={previewable ? () => showPreviewModal(entry, editable ? onSave : undefined, {
            initialIndex: entry.preferredIndex, favoriteIndex: entry.preferredIndex, onSetPreferredIndex, reloadEntry,
            onRename: editable ? onRename : undefined,
          }) : undefined}
        >
          {entry.name}
        </span>
      )}
      {editable && onRename && draft === null && (
        <button
          class="text-dim hover:text-accent transition-colors cursor-pointer shrink-0 flex items-center"
          title={t('fileViewer.rename')}
          onClick={() => { settled.current = false; setDraft(base); }}
        >
          <PencilIcon size={11} />
        </button>
      )}
      {/* The same glyph the session module downloads with — this was the one
          place still using a bare arrow character, which read as a smaller,
          lighter control than the identical action everywhere else. */}
      <a
        href={entryToObjectUrl(entry)} download={downloadName ?? entry.name}
        class="text-dim hover:text-accent transition-colors shrink-0 flex items-center"
        title={t('fileViewer.download')}
        dangerouslySetInnerHTML={{ __html: downloadIcon(12) }}
      />
      {editable && (
        <button
          class="text-dim hover:text-danger transition-colors cursor-pointer shrink-0"
          title={t('fileViewer.remove')} onClick={() => confirmRemove(entry.name, false, onRemove)}
        >
          <TrashIcon size={11} />
        </button>
      )}
    </>
  );
}

function EmbedRowContent({ entry, onRemove, onEdit, editable }: {
  entry: EmbedEntry;
  onRemove: () => void;
  onEdit?: () => void;
  editable: boolean;
}) {
  const mode = linkMode(entry);
  const platform = detectPlatform(entry.url);
  // An external link is marked by where it goes, not by who hosts it — the
  // arrow is the same one the app uses for every other departure, and a
  // YouTube URL deliberately kept external must not look like an embed.
  const icon = mode === 'link' ? '↗' : platform ? PLATFORM_ICONS[platform] : '⛓';
  // A safe href only for an external link — an embed never becomes one, and a
  // scheme the browser would run as script never becomes anything (see
  // safeExternalUrl). An imported entry is the only way null gets here.
  const href = mode === 'link' ? safeExternalUrl(entry.url) : null;

  let label = entry.title;
  if (!label) {
    try {
      const u = new URL(entry.url);
      label = u.hostname.replace('www.', '') + u.pathname.split('/').slice(0, 3).join('/');
    } catch { label = entry.url; }
  }

  const labelClass = 'text-xs font-mono truncate flex-1 text-muted hover:text-primary transition-colors';
  const actionClass = 'text-dim hover:text-accent transition-colors shrink-0 cursor-pointer flex items-center';

  return (
    <>
      <span class="text-[11px] text-dim shrink-0 w-4 text-center font-mono">{icon}</span>

      {/* A real anchor rather than a click handler, so a middle click or a
          Ctrl+click behaves the way every other link on the page does — and so
          no popup blocker sees a window opened out of script. */}
      {mode === 'link' ? (
        href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" class={labelClass} title={entry.url}>{label}</a>
        ) : (
          <span class={`${labelClass} italic`} title={t('embed.badUrl')}>{label}</span>
        )
      ) : (
        <span class={`${labelClass} cursor-pointer`} title={entry.url} onClick={() => showEmbedModal(entry)}>{label}</span>
      )}

      {mode === 'link' ? (
        href && (
          <a href={href} target="_blank" rel="noopener noreferrer" class={actionClass} title={t('embed.open')}>
            <ExternalLinkIcon size={11} />
          </a>
        )
      ) : (
        <button class={`${actionClass} text-xs`} title={t('embed.play')} onClick={() => showEmbedModal(entry)}>▶</button>
      )}

      {editable && onEdit && (
        <button class={actionClass} title={t('embed.edit')} onClick={onEdit}>
          <PencilIcon size={11} />
        </button>
      )}
      {editable && (
        <button
          class="text-dim hover:text-danger transition-colors cursor-pointer shrink-0"
          title={t('embed.remove')} onClick={() => confirmRemove(label, false, onRemove)}
        >
          <TrashIcon size={11} />
        </button>
      )}
    </>
  );
}

// ── A reference whose card is gone ───────────────────────────────────────────

const SOURCE_LABEL: Record<NewCardPreset['source'], string> = {
  thesession: 'TheSession',
  irishtuneinfo: 'irishtune.info',
};

/** What, if anything, could put this reference's card back.
 *
 *  Importing is the ONLY repair that works, and only through the external id:
 *  `resolveCardRef` tries id, then guid, then externalId, and a card created by
 *  hand carries a fresh id and guid and no external id at all — it would not
 *  resolve, leaving the reference exactly as broken as before. Re-importing
 *  from the source stamps the same external id, the third key matches, and
 *  `stateNormalise` then heals the reference back onto the fast path.
 *
 *  Anything whose id is not a plain number is left out on purpose — a set
 *  (`thesession-set:12-34`) is imported by a different route, and offering a
 *  button that lands on a tune lookup would be a lie. */
function repairPreset(entry: CardRef): NewCardPreset | null {
  const raw = entry.externalId;
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const source = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!/^\d+$/.test(id)) return null;
  if (source === 'thesession' || source === 'irishtuneinfo') return { source, query: id };
  return null;
}

/** Recreates the missing card on the spot, so the reference resolves again.
 *
 *  The new card deliberately takes the reference's OWN id and guid rather than
 *  fresh ones. Those two are free — the reference did not resolve, so no card
 *  holds either — and they are the first two keys `resolveCardRef` consults, so
 *  reusing them is what turns this from a look-alike into a repair. It also
 *  mends every OTHER reference to the same vanished card in the same stroke.
 *
 *  The card arrives empty apart from its name: this puts back an identity, not
 *  a copy of what was lost, and there is nothing to invent the rest from.
 *
 *  `type` is imposed by the role the reference plays, never chosen here — a
 *  set's member must be a tune (`canBeTuneOf` refuses anything else, and a
 *  non-tune sitting in a set is precisely the state that rule exists to
 *  prevent), while a mention may point at any kind of card and so gets none. */
async function createMissingCard(entry: CardRef, type: string | undefined): Promise<void> {
  const id = entry.id || generateId();
  const guid = entry.guid || generateId();
  await mutate(s => {
    if (s.cards[id]) return;   // raced by another repair of the same reference
    s.cards[id] = {
      id, guid, name: entry.title.trim(), defaultImportance: 1, tags: [],
      content: { notes: '', attachments: [] },
      ...(type ? { type } : {}),
    };
  });
}

/** Says what is missing and offers the one repair that fits.
 *
 *  Deliberately explains rather than acts: three quite different histories lead
 *  here — the card was deleted, it was never imported (a shared set carries its
 *  tunes as references, not as cards), or a sync applied a copy that never had
 *  it — and nothing here can tell them apart.
 *
 *  One action, never two: with a source id, re-importing brings back the real
 *  card, notation and all, and creating a blank one instead would be strictly
 *  worse. Without one, creating is all there is. No Close button either — the
 *  ✕, Escape and the backdrop already do that, and a modal that offers a way
 *  out twice reads as if the two differed. */
function showBrokenRefModal(entry: CardRef, type: string | undefined): void {
  const preset = repairPreset(entry);
  // Nothing to name it with — a nameless card is unsortable, unsearchable and
  // effectively invisible, so it is not an offer worth making.
  const canCreate = !preset && entry.title.trim() !== '';
  const { el, cleanup } = renderModalBody(
    <div class="space-y-3">
      <p class="text-sm text-muted leading-relaxed">
        {t('fileViewer.cardRef.missing.body', { title: entry.title })}
      </p>
      <p class="text-xs text-dim leading-relaxed">
        {preset
          ? t('fileViewer.cardRef.missing.canImport', { source: SOURCE_LABEL[preset.source], id: preset.query })
          : t('fileViewer.cardRef.missing.canCreate')}
      </p>
      {canCreate && type === CARD_TYPE_TUNE && (
        <p class="text-xs text-dim leading-relaxed">{t('fileViewer.cardRef.missing.asTune')}</p>
      )}
    </div>,
  );
  const close = () => { closeModal(); cleanup(); };
  showModal(t('fileViewer.cardRef.missing.title'), el, [
    ...(preset ? [{
      label: t('fileViewer.cardRef.missing.import'),
      primary: true,
      // Closed BEFORE the import modal opens: that one mounts its own host on
      // document.body rather than joining this stack, so leaving this one up
      // would just sit behind it with nothing left to say.
      onClick: () => { close(); showNewCardModal(getContext(), undefined, preset); },
    }] : []),
    ...(canCreate ? [{
      label: t('fileViewer.cardRef.missing.create'),
      primary: true,
      onClick: () => { close(); void createMissingCard(entry, type); },
    }] : []),
  ], { maxWidth: '26rem', onDismiss: cleanup });
}

function CardRefRowContent({ entry, onRemove, editable, glyph = '↗', action, repairType }: {
  entry: CardRef;
  onRemove: () => void;
  editable: boolean;
  glyph?: ComponentChild;
  /** The type a card recreated from this reference must take — decided by the
   *  ROLE the reference plays, which only the caller knows. See
   *  createMissingCard. */
  repairType?: string;
  /** A control of this row's own, placed with the others and AHEAD of the
   *  trash — so remove stays last on every row, where the eye expects it,
   *  rather than having something appear beyond it on some rows only. */
  action?: ComponentChild;
}) {
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
        <>
          <span class="text-xs font-mono truncate flex-1 text-dim">
            {entry.title}<span class="ml-1 text-danger text-[10px]">{t('fileViewer.cardRef.unresolved')}</span>
          </span>
          {/* Shown whether or not the row is editable: a missing card is just
              as missing while studying, and putting it back is not an edit of
              THIS card — it creates another one. Rendered here rather than
              through the `action` slot below, which the repeat counter already
              occupies on a set's rows, and which knows nothing of resolution. */}
          <button
            class="text-dim hover:text-accent transition-colors cursor-pointer shrink-0"
            title={t('fileViewer.cardRef.repair')}
            onClick={() => showBrokenRefModal(entry, repairType)}
          >
            <WrenchIcon size={11} />
          </button>
        </>
      )}
      {action}
      {editable && (
        <button
          class="text-dim hover:text-danger transition-colors cursor-pointer shrink-0"
          title={t('fileViewer.remove')} onClick={() => confirmRemove(resolved?.name ?? entry.title, true, onRemove)}
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
    // Aliases searched with the name; one that found a card is shown under it.
    const sorted = q
      ? rankByRelevance(cards, q)
      : [...cards].sort((a, b) => a.name.localeCompare(b.name)).map(item => ({ item, via: undefined }));
    for (const { item: card, via } of sorted) {
      const item = document.createElement('button');
      item.className = 'w-full text-left text-sm px-2 py-1.5 rounded hover:bg-accent/10 transition-colors cursor-pointer';
      const name = document.createElement('span');
      name.className = 'block truncate';
      name.textContent = card.name;
      item.appendChild(name);
      if (via !== undefined) {
        const alias = document.createElement('span');
        alias.className = 'block truncate text-xs text-dim';
        alias.textContent = t('search.viaAlias', { alias: via });
        item.appendChild(alias);
      }
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
  /** Makes the repeat counter changeable. Click cycles it: a set repeats two
   *  or three times in practice, so a stepper would be more machinery than
   *  the choice deserves.
   *
   *  Without it the counter is still SHOWN, but only where it says something
   *  — see the row below. */
  onSetRepeat?: (i: number, repeat: number) => void;
}) {
  const scratch = useRef<DragScratch>({ draggedIdx: null, indicatorEl: null }).current;
  if (refs.length === 0) return null;
  return (
    <div class="space-y-1">
      {refs.map((ref, i) => (
        <AttachmentRow key={i} index={i} editable={editable} onReorder={onReorder} scratch={scratch}>
          <CardRefRowContent
            entry={ref} editable={editable} onRemove={() => onRemove(i)} glyph={glyph}
            // This list IS a set's tune list — its repeat counter says as much
            // — so anything recreated from one of its references is a tune, and
            // the set's "members are tunes" invariant survives the repair.
            repairType={CARD_TYPE_TUNE}
            // A control when it can be changed, a readout when it cannot —
            // which is why one shows at ×1 and the other does not. A control
            // has to be findable before you know you want it, so it is always
            // there; a readout that says "once" tells a reader nothing they
            // were not already assuming, and every row would carry one.
            action={onSetRepeat ? (
              <button
                type="button"
                class={`shrink-0 text-[11px] font-mono px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                  clampRepeat(ref.repeat) > 1 ? 'text-accent bg-accent/10' : 'text-dim hover:text-muted'
                }`}
                title={t('card.tunes.repeatTitle')}
                // Left click counts up, right click counts down, both wrapping
                // at the ends — so 3 → 2 is one gesture instead of a lap round
                // the whole range. Right click on a control the browser has no
                // menu worth showing for, hence preventDefault.
                onClick={() => onSetRepeat(i, clampRepeat(ref.repeat) % MAX_REPEAT + 1)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onSetRepeat(i, (clampRepeat(ref.repeat) + MAX_REPEAT - 2) % MAX_REPEAT + 1);
                }}
              >×{clampRepeat(ref.repeat)}</button>
            ) : clampRepeat(ref.repeat) > 1 ? (
              <span
                class="shrink-0 text-[11px] font-mono px-1.5 py-0.5 rounded text-accent bg-accent/10"
                title={t('card.tunes.repeatReadOnly', { n: clampRepeat(ref.repeat) })}
              >×{clampRepeat(ref.repeat)}</span>
            ) : null}
          />
        </AttachmentRow>
      ))}
    </div>
  );
}

/** The save of a TheSession score's editor (2026-09-15). "Refresh ABC" replaces
 *  that file wholesale, so an edit made in it would be lost at the next refresh:
 *  the first save of an opened viewer asks, then writes the edit to a COPY
 *  inserted just before the original, which stays untouched.
 *
 *  The copy takes the original's index and the original moves down one, so
 *  every handler of this row bound to `i` — the next saves, the star, a rename —
 *  then addresses the copy, which is the file the viewer now shows. That is also
 *  why later saves from the same viewer go straight to it without asking again.
 *  One saver per row per render; an open viewer keeps the one it was given. */
function theSessionScoreSaver(
  i: number,
  update: (i: number, data: string) => void,
  copy: (i: number, data: string) => string,
): (data: string) => PreviewSaveResult | Promise<PreviewSaveResult> {
  let copied = false;
  return (data) => {
    if (copied) { update(i, data); return; }
    return new Promise<PreviewSaveResult>(resolve => {
      const body = document.createElement('p');
      body.className = 'text-sm text-muted leading-relaxed';
      body.textContent = t('fileViewer.abc.copy.message');
      showModal(t('fileViewer.abc.copy.title'), body, [
        { label: t('common.cancel'), onClick: () => { closeModal(); resolve(false); } },
        {
          label: t('fileViewer.abc.copy.confirm'), primary: true, onClick: () => {
            closeModal();
            const name = copy(i, data);
            copied = !!name;
            resolve(name || false);
          },
        },
      ], { onDismiss: () => resolve(false) });
    });
  };
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
  onSetPreferredIndex?: (i: number, index: number | undefined) => void;
  /** Renames a file attachment — the full new name, extension already kept. */
  onRenameFile?: (i: number, name: string) => void;
  /** Saves an edit to a TheSession score as a copy inserted just before it,
   *  and answers the copy's name. See theSessionScoreSaver. */
  onCopyFile?: (i: number, data: string) => string;
  /** Replaces a link attachment wholesale — its URL, its name and above all
   *  its mode, which is why this is a replacement and not a rename: switching
   *  an embed to an external link drops its `embedUrl`, and the entry that
   *  comes back is already built (see showEditLinkModal). */
  onUpdateLink?: (i: number, entry: EmbedEntry) => void;
  /** The card these attachments belong to. Only needed to resolve a set's
   *  generated score, whose stored `data` is empty by design — everything else
   *  here works from the attachments alone. */
  card?: Card;
}

/** Opens the card's SCORE — its first ABC attachment — in the viewer, wired
 *  exactly as its row in the list below would wire it.
 *
 *  Here rather than at the call site because that wiring is not obvious: a
 *  generated set score is rebuilt rather than read, a TheSession score saves to
 *  a copy and may be refused, and a derived one has to be re-read whenever a
 *  preference changes underneath it. One reader for all of that, so the button
 *  in the opening-bars heading and the file row can never open the same score
 *  two different ways.
 *
 *  Answers whether there was a score to open, so a caller can decide not to
 *  offer the button at all.
 *
 *  The one difference from the row: its TheSession saver is built once per
 *  render and this one once per opening. Both give a freshly opened viewer a
 *  saver that has not yet asked its question, which is the behaviour that
 *  matters (see theSessionScoreSaver). */
export function openCardScore(options: AttachmentListOptions): boolean {
  const { attachments, editable, card } = options;
  const i = attachments.findIndex(a => a.type === 'file' && isAbcFile(a));
  const att = attachments[i];
  if (!att || att.type !== 'file') return false;

  const generated = att.generatedBy === 'tuneset' && card
    ? tunesetAbcEntry(card, appState.value.cards, { includeRepeats: appState.value.abcIncludeRepeats })
    : null;
  const entry: FileEntry & { preferredIndex?: number } = generated && card
    ? { ...att, data: generated.data, mimeType: generated.mimeType, name: card.name + '.abc' }
    : att;

  const onUpdateFile = options.onUpdateFile;
  const onCopyFile = options.onCopyFile;
  const onSave = onUpdateFile && att.generatedBy !== 'tuneset'
    ? att.generatedBy === 'thesession' && onCopyFile
      ? theSessionScoreSaver(i, onUpdateFile, onCopyFile)
      : (data: string) => onUpdateFile(i, data)
    : undefined;

  showPreviewModal(entry, editable ? onSave : undefined, {
    initialIndex: att.preferredIndex,
    favoriteIndex: att.preferredIndex,
    onSetPreferredIndex: options.onSetPreferredIndex && att.generatedBy !== 'tuneset'
      ? (index) => options.onSetPreferredIndex!(i, index)
      : undefined,
    onRename: editable && options.onRenameFile && att.generatedBy !== 'tuneset'
      ? (name) => options.onRenameFile!(i, name)
      : undefined,
    reloadEntry: att.generatedBy === 'tuneset' && card
      ? () => tunesetAbcEntry(card, appState.value.cards, { includeRepeats: appState.value.abcIncludeRepeats })
      : undefined,
  });
  return true;
}

/** Whether `openCardScore` would have anything to open. */
export function hasScore(attachments: Attachment[]): boolean {
  return attachments.some(a => a.type === 'file' && isAbcFile(a));
}

export function AttachmentList({ options }: { options: AttachmentListOptions }) {
  const { attachments, editable } = options;
  const onAdd     = options.onAdd     ?? (() => {});
  const onRemove  = options.onRemove  ?? (() => {});
  const onReorder = options.onReorder ?? (() => {});
  const onUpdateFile = options.onUpdateFile;
  const onRenameFile = options.onRenameFile;
  const onCopyFile = options.onCopyFile;
  const onSetPreferredIndex = options.onSetPreferredIndex;
  const onUpdateLink = options.onUpdateLink;
  const card = options.card;

  const scratch = useRef<DragScratch>({ draggedIdx: null, indicatorEl: null }).current;

  // A set's score is REBUILT here rather than read from the attachment: what is
  // stored is only the intent to show one. Recomputed whenever the library
  // changes, so it cannot lag behind a tune being renamed, restarred, added or
  // removed — and it costs nothing in the synced blob.
  const generatedAbc = useMemo(
    () => (card && isTuneset(card) ? tunesetAbcEntry(card, appState.value.cards, { includeRepeats: appState.value.abcIncludeRepeats }) : null),
    [card, appState.value.cards, appState.value.abcIncludeRepeats],
  );
  const hasAbc = hasTunesetScore(attachments);

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
    // A file has two sources — the device, or a text in the clipboard — and
    // which one is asked in a dialog of its own rather than as two entries
    // here: this menu says WHAT is being attached, not where it comes from.
    { label: t('fileViewer.addFile'), onClick: () => showAddFileModal(onAdd) },
    { label: t('fileViewer.addLink'), onClick: () => showAddLinkModal(onAdd) },
    { label: t('fileViewer.addCard'), onClick: () => showCardRefPicker(onAdd) },
    // Sets only, and once only — the entry disappears rather than being offered
    // and refused, like every other impossible action in this app.
    ...(card && isTuneset(card) && !hasAbc
      ? [{ label: t('fileViewer.addTunesetAbc'), onClick: () => onAdd(tunesetAbcPlaceholder()) }]
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
                  onSave={onUpdateFile && att.generatedBy !== 'tuneset'
                    ? att.generatedBy === 'thesession' && onCopyFile
                      ? theSessionScoreSaver(i, onUpdateFile, onCopyFile)
                      : (data) => onUpdateFile(i, data)
                    : undefined}
                  // Its name is derived from the set's, so it has none of its own to change.
                  onRename={onRenameFile && att.generatedBy !== 'tuneset' ? (name) => onRenameFile(i, name) : undefined}
                  onSetPreferredIndex={onSetPreferredIndex && att.generatedBy !== 'tuneset' ? (index) => onSetPreferredIndex(i, index) : undefined}
                  reloadEntry={att.generatedBy === 'tuneset' && card
                    ? () => tunesetAbcEntry(card, appState.value.cards, { includeRepeats: appState.value.abcIncludeRepeats })
                    : undefined}
                />
              ) : att.type === 'card' ? (
                <CardRefRowContent entry={att} onRemove={() => onRemove(i)} editable={editable} />
              ) : (
                <EmbedRowContent
                  entry={att} onRemove={() => onRemove(i)} editable={editable}
                  onEdit={onUpdateLink ? () => showEditLinkModal(att, (next) => onUpdateLink(i, next)) : undefined}
                />
              )}
            </AttachmentRow>
          ))}
        </div>
      )}
    </div>
  );
}
