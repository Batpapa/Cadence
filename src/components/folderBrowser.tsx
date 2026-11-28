import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../services/i18nService';
import { hasLibrary } from '../services/pageMode';
import { generateId } from '../utils';
import { addTouchDragSupport } from './touchDrag';
import { scoreMatch, NO_SCORE_MATCH } from '../services/nameSearch';
import { promptModal, confirmModal } from './modal';
import { PencilIcon, TrashIcon, FolderIcon, PlusIcon, ChevronDownIcon } from './icons';
import { CustomSelect } from './customSelect';
import { IconButton, EmptyState } from './ui';
import { fromAttrs, originOf } from './navOrigin';
import { leaveDeletedPage, navEntry } from '../store';
import {
  childFolderIds, collectFolderSessionIds, createFolder, deleteFolderTree,
  folderChain, folderOrder, folderPathOf, isFolderDescendant, levelItems, moveFolder, parentFolderOf,
  placeSession, renameFolder, searchItems, type SessionTree, type TreeItem,
} from '../session/sessionTree';

// ── Browsing a module's items, one folder at a time ──────────────────────────
// A file explorer, deliberately: "un système à la Windows". One level on
// screen, folders above items, a breadcrumb to climb back, and a folder that
// looks like an item except for its glyph and its second line. The analyser's
// (session/ui/AnalysisBrowser.tsx) until 2026-11-28, made the Transcription
// module's too ("des dossiers comme pour l'analyse", the user): what is the
// analyser's — its tree, its rows, how a folder's analyses are deleted — is
// handed in (FolderSource). The tree's model is sessionTree.ts, whose
// "session" is any item.
//
// This replaces a tree with everything unfolded in place (2026-09-12), which
// was turned down as too austere for this screen. The MODEL is the same one and
// did not move — sessionTree.ts, untouched — only the way in changed.
//
// A folder is renamed and deleted only from INSIDE it, as asked: the name
// being acted on is then the one you are looking at, never one picked out of a
// list of siblings — and a delete that takes a whole subtree with it is not an
// action to offer from a row you were merely scrolling past.

/** An item as the tree sorts and searches it: `date` an ISO string, or null. */
export interface FolderItem { id: string; name: string; date: string | null }

/** What a module hands the browser: its tree, its rows, its words. */
export interface FolderSource {
  /** The tree as it stands (detached). */
  tree: SessionTree;
  /** Writes it, in one mutate of the user. */
  edit: (fn: (tree: SessionTree) => void) => void;
  /** Deletes these items for good — a folder's, before the folder goes. What
   *  it returns, when anything, runs once the screen has turned round: the
   *  analyser's recordings cleared on Drive, behind a dialog of its own. */
  deleteItems: (ids: string[]) => Promise<(() => Promise<void>) | void>;
  /** An item's glyph, the glyph's tooltip, and its second line. */
  icon: (id: string) => JSX.Element;
  iconTitle: (id: string) => string;
  detail: (id: string) => string;
  /** Its navOrigin key's kind ("analysis", "transcription"). */
  key: string;
  /** "3 analyses": a folder's count of its items. */
  count: (n: number) => string;
  /** The root's empty list, and a search finding nothing. */
  empty: string;
  noResults: string;
  /** Its walkthrough mark on an item row, when it has one. */
  tour?: string;
}

/** The way out of a folder: the same folder (icons.tsx's FolderIcon), with the
 *  arrow that says which way — a drawing of its own, icons.tsx has none. It
 *  carries no name on purpose — it is not a place, it is a direction. */
function ParentGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <polyline points="9 14 12 11 15 14" />
      <line x1="12" y1="11" x2="12" y2="18" />
    </svg>
  );
}

// ── Drag & drop ──────────────────────────────────────────────────────────────
// Both kinds move, and only ever INTO something: a sub-folder, or the ".."
// card, meaning "up one level". A level is sorted by date, folders and
// analyses together (sessionTree.ts's levelItems), so there is no place among
// them to drop anything at. Folders could still be reordered by hand among
// their peers until 2026-10-15; they sort by their most recent analysis now.
//
//   over an analysis   · refused, whatever is carried
//   over a folder      · into
//   over the ".." card · into, meaning "up one level"
//
// Plain module variables and direct classList work, not state: dragover fires
// many times a second and all it ever does is move one outline. Same mechanism
// and same CSS class as components/sidebar.tsx (.drop-into in styles.css).

let dragItem: TreeItem | null = null;
let indicatorEl: HTMLElement | null = null;

function clearIndicator(): void {
  indicatorEl?.classList.remove('drop-into');
  indicatorEl = null;
}

function setIndicator(el: HTMLElement): void {
  if (indicatorEl === el) return;
  clearIndicator();
  el.classList.add('drop-into');
  indicatorEl = el;
}

/** What a card is, as a destination.
 *
 *  `up` is the ".." card: its `id` is already the folder to move INTO (the
 *  current folder's own parent, null at the root), so nothing downstream has to
 *  know it is special. */
type DropTarget =
  | { kind: 'session'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'up'; id: string | null };

type Drop = (drag: TreeItem, target: DropTarget) => void;

function useCardDrag(ref: RefObject<HTMLElement>, opts: {
  dragItem?: TreeItem;
  target: DropTarget;
  /** Whether this card will take what is being carried — asked by the browser,
   *  which is the only one holding the tree (a folder cannot land inside
   *  itself or inside its own descendant). */
  accepts: (drag: TreeItem) => boolean;
  onDrop: Drop;
}): void {
  const { dragItem: mine, target } = opts;
  // Read through refs so the listeners, attached once, never close over a
  // stale handler — the tree they write to changes on every drop.
  const dropRef = useRef(opts.onDrop);
  dropRef.current = opts.onDrop;
  const targetRef = useRef(target);
  targetRef.current = target;
  const acceptsRef = useRef(opts.accepts);
  acceptsRef.current = opts.accepts;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onDragStart = (e: DragEvent) => {
      if (!mine) return;
      dragItem = mine;
      e.dataTransfer?.setData('text/plain', mine.id);
      // Deferred: applying it synchronously makes the browser snapshot a
      // half-transparent card as the drag image.
      setTimeout(() => el.classList.add('opacity-40'), 0);
    };
    const onDragEnd = () => {
      dragItem = null;
      el.classList.remove('opacity-40');
      clearIndicator();
    };
    const onDragOver = (e: DragEvent) => {
      if (!dragItem || !acceptsRef.current(dragItem)) return;
      e.preventDefault();
      e.stopPropagation();
      setIndicator(el);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node)) clearIndicator();
    };
    const onDropEvt = (e: DragEvent) => {
      if (!dragItem) return;
      e.preventDefault();
      e.stopPropagation();
      const moved = dragItem;
      clearIndicator();
      dragItem = null;
      if (!acceptsRef.current(moved)) return;
      dropRef.current(moved, targetRef.current);
    };

    if (mine) {
      el.draggable = true;
      // Touch has no HTML5 drag at all — the same polyfill the sidebar uses
      // synthesises the events from a long press and a move.
      addTouchDragSupport(el);
    }
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragend', onDragEnd);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDropEvt);
    return () => {
      el.removeEventListener('dragstart', onDragStart);
      el.removeEventListener('dragend', onDragEnd);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDropEvt);
    };
    // eslint-disable-next-line
  }, [mine?.type, mine?.id, target.kind, target.id]);
}

/** One card, whichever kind of thing it holds — a folder and an item are the
 *  same object to the eye here, which is the whole point of the shape. */
function Card({ icon, iconTitle, name, detail, onOpen, dragItem, target, accepts, onDrop, fromKey, tour }: {
  icon: JSX.Element;
  iconTitle?: string;
  name: string;
  detail: string;
  onOpen: (e: MouseEvent) => void;
  /** Its walkthrough mark (FolderSource.tour). */
  tour?: string;
  /** The card's key (navOrigin.ts): it lights up when what it opens is gone
   *  back from. None on "..": climbing up is no way back. */
  fromKey?: string;
  /** What this card carries when dragged. Absent on the ".." card, which is a
   *  destination and a direction, never a passenger. */
  dragItem?: TreeItem;
  target: DropTarget;
  accepts: (drag: TreeItem) => boolean;
  onDrop: Drop;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCardDrag(ref, { dragItem, target, accepts, onDrop });

  return (
    <div ref={ref} class="rounded-lg border border-border bg-bg hover:border-accent/50 transition-colors" {...(fromKey ? fromAttrs(fromKey) : {})}>
      <div class="flex items-center gap-3 p-3 cursor-pointer" data-tour={tour} onClick={onOpen}>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-primary flex items-start gap-1.5">
            {/* Before the name, not after it: these are scanned down a column,
                and an icon that moves with the end of a truncated name cannot
                be scanned at all. */}
            <span class="text-dim shrink-0 flex items-center h-5" title={iconTitle}>{icon}</span>
            <span class="name-wrap">{name}</span>
          </div>
          <div class="text-xs text-dim">{detail}</div>
        </div>
      </div>
    </div>
  );
}

export function FolderBrowser({ source, items: sessions, query, folderId, onOpenFolder, onOpenItem: onOpenSession, toolbar }: {
  source: FolderSource;
  /** Every item, in library order — NOT filtered: the tree needs the whole
   *  list to know which ones it has no opinion about (see rootOrder). */
  items: FolderItem[];
  /** The search box, already trimmed and lowercased. */
  query: string;
  /** Which folder is open; null is the root, shown as "Home". */
  folderId: string | null;
  /** `keepSearch` false: the search is left behind (a folder found by it). */
  /** `from`: the key of the card opened from (navOrigin.ts). */
  onOpenFolder: (folderId: string | null, keepSearch?: boolean, from?: string) => void;
  onOpenItem: (id: string, from?: string) => void;
  /** The search box, owned by the screen, shown just under the breadcrumb,
   *  browsing or searching: the search runs in the folder the breadcrumb
   *  names. */
  toolbar: ComponentChildren;
}) {
  const { tree, edit } = source;
  const allIds = sessions.map(s => s.id);
  const byId = new Map(sessions.map(s => [s.id, s]));

  // A folder deleted on another device leaves this route pointing at nothing.
  // `folderChain` returns empty for an id it cannot resolve, and the rest of
  // this reads that as the root — which is where that device would leave you.
  const chain = folderChain(tree, folderId);
  const here = folderId !== null && chain.length > 0 ? folderId : null;
  const current = here === null ? null : tree.folders[here] ?? null;
  const parentId = here === null ? null : parentFolderOf(tree, { type: 'folder', id: here });

  const items = levelItems(tree, here, sessions);

  /** Moving something INTO a folder, wherever that folder came from. The
   *  model carries the cycle guard too (moveFolder). */
  const moveInto = (drag: TreeItem, into: string | null) => edit(tr => {
    if (drag.type === 'folder') moveFolder(tr, drag.id, into);
    else placeSession(tr, drag.id, into);
  });

  const onDrop: Drop = (drag, target) => {
    if (target.kind === 'session') return; // an analysis takes no drop
    moveInto(drag, target.id);
  };

  /** A folder cannot land in itself, nor anywhere below itself — the model
   *  refuses it too (moveFolder, applyDrop), but a drop indicator that lights
   *  up for a move that will not happen is a lie told before the fact. */
  const folderAccepts = (folderIdHere: string) => (drag: TreeItem) =>
    drag.type === 'session'
    || (drag.id !== folderIdHere && !isFolderDescendant(tree, drag.id, folderIdHere));

  /** An analysis row is no position — see the zone table at the top of this
   *  file. */
  const sessionAccepts = () => false;

  /** Deletes the folder you are standing in, and everything under it. The
   *  items go first (FolderSource.deleteItems — the analyser's drop their
   *  audio, locally and on Drive), then the now-empty folders leave the tree,
   *  and the screen turns round to the page it was reached from, as a deleted
   *  folder of decks does (leaveDeletedPage): a folder is a history entry since
   *  2026-11-20, and the entries naming it, or anything below it, are stepped
   *  over by back and forward (store.ts, isValidRoute). Opened straight onto
   *  it, with nowhere alive to go, it stays — and this screen shows the root
   *  for a folder it cannot find. */
  const removeFolder = () => {
    if (!current) return;
    const doomed = collectFolderSessionIds(tree, current.id);
    confirmModal(
      t('sessions.folder.delete.title'),
      t('sessions.folder.delete.message', { name: current.name }),
      t('common.delete'),
      () => { void (async () => {
        // Where the user stood when they confirmed: deleting a full folder
        // takes a while, and by the end they may have moved on — then there is
        // nothing to leave.
        const stood = navEntry.peek();
        // All of them in one write, at once: no folder is ever left half
        // emptied.
        const after = doomed.length > 0 ? await source.deleteItems(doomed) : undefined;
        edit(tr => deleteFolderTree(tr, current.id));
        if (navEntry.peek() === stood) leaveDeletedPage();
        if (after) await after();
      })(); },
    );
  };

  const newFolder = () => promptModal(t('modal.newFolder.title'), t('modal.newFolder.label'), '', name => {
    const val = name.trim();
    if (val) edit(tr => createFolder(tr, generateId(), val, here));
  });

  const rename = () => {
    if (!current) return;
    promptModal(t('sessions.folder.renameTitle'), t('modal.newFolder.label'), current.name, name => {
      const val = name.trim();
      if (val) edit(tr => renameFolder(tr, current.id, val));
    });
  };

  /** The row above the list: the breadcrumb, then the open folder's actions
   *  — those only while browsing, see the search below. */
  const breadcrumbRow = (withActions: boolean) => (
    // No folders without a library (the standalone page, 2026-10-26): its
    // analyses are to go into an account one day, and folders made here
    // would have to be merged into that account's own tree. With none to
    // make, the row would hold only "Home".
    hasLibrary() && (
      <div class="mt-3 flex items-center gap-2">
        {/* The breadcrumb. Every step but the last is a way back up; the last
            is where you are, so it is not a link. Wraps rather than scrolls —
            a deep path on a phone is still readable stacked. */}
        <div class="flex-1 min-w-0 flex items-center gap-1 flex-wrap text-xs">
          <button
            type="button"
            class={`min-h-8 cursor-pointer transition-colors ${here === null ? 'text-primary font-medium cursor-default' : 'text-dim hover:text-accent'}`}
            disabled={here === null}
            onClick={() => onOpenFolder(null)}
          >
            {t('sessions.folder.home')}
          </button>
          {chain.map((folder, i) => {
            const last = i === chain.length - 1;
            return (
              <span key={folder.id} class="flex items-center gap-1 min-w-0">
                <span class="text-dim">/</span>
                <button
                  type="button"
                  class={`min-h-8 name-wrap text-left cursor-pointer transition-colors ${last ? 'text-primary font-medium cursor-default' : 'text-dim hover:text-accent'}`}
                  disabled={last}
                  onClick={() => onOpenFolder(folder.id)}
                >
                  {folder.name}
                </button>
              </span>
            );
          })}
        </div>

        {/* Renaming happens from INSIDE the folder, as asked: the name being
            edited is then the one on screen, not one picked out of a list of
            siblings. So there is nothing to rename at the root. */}
        {withActions && current && (
          <IconButton label={t('sessions.folder.rename')} class="hover:text-accent" onClick={rename}>
            <PencilIcon size={14} />
          </IconButton>
        )}
        {/* The plus is an icon, as on the sidebar and the folder page — it was
            a "+" written into the label. */}
        {withActions && (
          <button type="button" class="btn-ghost text-xs px-2 py-1 min-h-8 shrink-0 inline-flex items-center gap-1.5 text-dim hover:text-accent" onClick={newFolder}>
            <PlusIcon size={12} /><FolderIcon size={14} />{t('sessions.folder.new')}
          </button>
        )}
        {/* Like the rename beside it: only from inside, and for the same
            reason — this one takes a whole subtree, so it must never sit on a
            row you were only scrolling past. */}
        {withActions && current && (
          <IconButton label={t('sessions.folder.delete.title')} variant="danger" onClick={removeFolder}>
            <TrashIcon size={14} />
          </IconButton>
        )}
      </div>
    )
  );

  // Searching looks through the folder on screen and everything below it,
  // flattened — from the root, the whole library (2026-11-20, the user: once a
  // folder is a place, searching from it searches IN it; it used to search
  // everywhere). Folders are found too, the same day, and the list is ranked
  // by relevance as the card library's is (searchItems). The
  // breadcrumb stays, to say where the search runs and to climb out and widen
  // it — the search goes along; the folder's own actions go, a new folder made
  // here landing nowhere in sight. Nothing is dragged either: a flattened list
  // has no levels to drop into. Opening a folder found leaves the search
  // behind: that folder is where you were looking to go, not a narrower search.
  if (query) {
    const found = searchItems(tree, here, sessions, name => {
      const tier = scoreMatch(name, query);
      return tier < NO_SCORE_MATCH ? tier : null;
    });
    return (
      <>
      {breadcrumbRow(false)}
      {toolbar}
      <div class="mt-4 space-y-2">
        {found.length === 0
          ? <EmptyState>{source.noResults}</EmptyState>
          : found.map(item => {
            if (item.type === 'folder') {
              const folder = tree.folders[item.id]!;
              return (
                <Card
                  key={folder.id}
                  icon={<FolderIcon size={12} />}
                  name={folder.name}
                  detail={folderDetail(childFolderIds(tree, folder.id).length, folderOrder(tree, folder.id, allIds).length, source.count)}
                  onOpen={(e) => onOpenFolder(folder.id, false, originOf(e))}
                  target={{ kind: 'folder', id: folder.id }}
                  accepts={() => false}
                  onDrop={() => {}}
                  fromKey={`folder:${folder.id}`}
                />
              );
            }
            const s = byId.get(item.id)!;
            return (
              <Card
                key={s.id}
                icon={source.icon(s.id)}
                iconTitle={source.iconTitle(s.id)}
                name={s.name}
                detail={source.detail(s.id)}
                onOpen={(e) => onOpenSession(s.id, originOf(e))}
                target={{ kind: 'session', id: s.id }}
                accepts={() => false}
                onDrop={() => {}}
                fromKey={`${source.key}:${s.id}`}
                tour={source.tour}
              />
            );
          })}
      </div>
      </>
    );
  }

  return (
    <>
      {breadcrumbRow(true)}
      {toolbar}

      <div class="mt-3 space-y-2">
        {/* The way out, first in the list and before anything else — it is both
            the click that climbs a level and the target that sends an analysis
            up there, which is why it has to be a card like the others rather
            than a link in the breadcrumb: you cannot drop onto a breadcrumb. */}
        {here !== null && (
          <Card
            icon={<ParentGlyph />}
            iconTitle={t('sessions.folder.up')}
            name=".."
            detail={t('sessions.folder.up')}
            onOpen={() => onOpenFolder(parentId)}
            target={{ kind: 'up', id: parentId }}
            accepts={() => true}
            onDrop={onDrop}
          />
        )}

        {items.length === 0 ? (
          <EmptyState>
            {here === null ? source.empty : t('sessions.folder.empty')}
          </EmptyState>
        ) : (
          // Folders and analyses MIXED, by date (2026-10-15, the user's rule):
          // a folder sits where its most recent analysis would — not above
          // everything, as in a file explorer, which buried this week's
          // recording under every folder ever made. See levelItems.
          items.map(item => {
            if (item.type === 'folder') {
              const folder = tree.folders[item.id]!;
              return (
                <Card
                  key={folder.id}
                  icon={<FolderIcon size={12} />}
                  name={folder.name}
                  detail={folderDetail(childFolderIds(tree, folder.id).length, folderOrder(tree, folder.id, allIds).length, source.count)}
                  onOpen={(e) => onOpenFolder(folder.id, undefined, originOf(e))}
                  dragItem={{ type: 'folder', id: folder.id }}
                  target={{ kind: 'folder', id: folder.id }}
                  accepts={folderAccepts(folder.id)}
                  onDrop={onDrop}
                  fromKey={`folder:${folder.id}`}
                />
              );
            }
            const session = byId.get(item.id)!;
            return (
              <Card
                key={session.id}
                icon={source.icon(session.id)}
                iconTitle={source.iconTitle(session.id)}
                name={session.name}
                detail={source.detail(session.id)}
                onOpen={(e) => onOpenSession(session.id, originOf(e))}
                dragItem={{ type: 'session', id: session.id }}
                target={{ kind: 'session', id: session.id }}
                accepts={sessionAccepts}
                onDrop={onDrop}
                fromKey={`${source.key}:${session.id}`}
                tour={source.tour}
              />
            );
          })
        )}
      </div>
    </>
  );
}

/** A folder's second line: what it holds, DIRECTLY. Not a recursive total —
 *  the number has to agree with what clicking through actually shows, or it is
 *  a number that argues with the screen. */
function folderDetail(folders: number, items: number, count: (n: number) => string): string {
  const parts: string[] = [];
  if (folders > 0) parts.push(t(folders === 1 ? 'sessions.folder.countFolders' : 'sessions.folder.countFoldersPlural', { n: folders }));
  if (items > 0) parts.push(count(items));
  return parts.length > 0 ? parts.join(' · ') : t('sessions.folder.empty');
}

/** Where one item lives — the "Dossier :" row under its title, as the deck
 *  view's "Emplacement :" row (session/ui/AnalysisFolderPicker.tsx's history).
 *  Renders NOTHING while there are no folders at all: a chooser whose only
 *  entry is "no folder" can do nothing, and someone who does not use folders
 *  should not have to notice they exist. */
export function FolderPicker({ tree, itemId, onPlace }: {
  tree: SessionTree;
  itemId: string;
  /** Moves it: into a folder, or to the root (null). */
  onPlace: (folderId: string | null) => void;
}) {
  const folders = Object.values(tree.folders);
  if (folders.length === 0) return null;
  const parentId = parentFolderOf(tree, { type: 'session', id: itemId });
  const options = [
    { value: '', label: t('sessions.folder.root') },
    ...folders
      .map(f => ({ value: f.id, label: folderPathOf(tree, f.id) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  return (
    <div class="flex items-center gap-1 mt-1">
      <span class="text-2xs font-medium uppercase tracking-wider text-dim">{t('sessions.folder.label')}</span>
      <CustomSelect
        value={parentId ?? ''}
        options={options}
        onChange={(v) => onPlace(v || null)}
        renderTrigger={(label, open, toggle) => (
          <button
            type="button"
            class="min-h-8 text-2xs font-medium text-dim cursor-pointer hover:text-accent transition-colors flex items-center gap-0.5 shrink-0 whitespace-nowrap"
            onClick={toggle}
          >
            {label}
            <span class={`shrink-0 flex transition-transform ${open ? 'rotate-180' : ''}`}><ChevronDownIcon size={12} /></span>
          </button>
        )}
      />
    </div>
  );
}
