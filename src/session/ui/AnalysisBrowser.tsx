import type { JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { hasLibrary } from '../../services/pageMode';
import type { AppContext } from '../../types';
import { generateId, addTouchDragSupport, matchesSearch } from '../../utils';
import { promptModal, confirmModal } from '../../components/modal';
import { MicIcon, FileAudioIcon, DeviceAudioIcon, PencilIcon, TrashIcon } from '../../components/icons';
import { fmtLongTime } from './sessionUiShared';
import { fmtSessionDateTime } from '../sessionNaming';
import type { Analysis } from '../model';
import { deleteSession } from '../db';
import { showBatchProgress, type BatchStep } from './batchRunner';
import {
  childFolderIds, collectFolderSessionIds, createFolder, deleteFolderTree,
  editSessionTree, folderChain, folderOrder, isFolderDescendant, levelItems, moveFolder, parentFolderOf,
  placeSession, renameFolder, sessionTreeOf, type TreeItem,
} from '../sessionTree';

// ── Browsing the analyses, one folder at a time ──────────────────────────────
// A file explorer, deliberately: "un système à la Windows". One level on
// screen, folders above analyses, a breadcrumb to climb back, and a folder that
// looks like an analysis except for its glyph and its second line.
//
// This replaces a tree with everything unfolded in place (2026-09-12), which
// was turned down as too austere for this screen. The MODEL is the same one and
// did not move — sessionTree.ts, untouched — only the way in changed.
//
// A folder is renamed and deleted only from INSIDE it, as asked: the name
// being acted on is then the one you are looking at, never one picked out of a
// list of siblings — and a delete that takes a whole subtree with it is not an
// action to offer from a row you were merely scrolling past.

/** What each kind of analysis is marked with. Same glyphs as the source
 *  selector on the start button, so the icon that chose a recording is the icon
 *  that later identifies it. */
const SOURCE_BADGE: Record<Analysis['source'], { icon: JSX.Element; title: string }> = {
  live:   { icon: <MicIcon size={11} />,         title: 'sessions.source.mic' },
  device: { icon: <DeviceAudioIcon size={11} />, title: 'sessions.source.device' },
  import: { icon: <FileAudioIcon size={11} />,   title: 'sessions.importBadge' },
};

function FolderGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** The way out of a folder: the same folder, with the arrow that says which
 *  way. It carries no name on purpose — it is not a place, it is a direction. */
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

/** One card, whichever kind of thing it holds — a folder and an analysis are
 *  the same object to the eye here, which is the whole point of the shape. */
function Card({ icon, iconTitle, name, detail, onOpen, dragItem, target, accepts, onDrop }: {
  icon: JSX.Element;
  iconTitle?: string;
  name: string;
  detail: string;
  onOpen: () => void;
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
    <div ref={ref} class="rounded-lg border border-border bg-bg hover:border-accent/50 transition-colors">
      <div class="flex items-center gap-3 p-3 cursor-pointer" data-tour={target.kind === 'session' ? 'analysis-row' : undefined} onClick={onOpen}>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-primary truncate flex items-center gap-1.5">
            {/* Before the name, not after it: these are scanned down a column,
                and an icon that moves with the end of a truncated name cannot
                be scanned at all. */}
            <span class="text-dim shrink-0 flex items-center" title={iconTitle}>{icon}</span>
            <span class="truncate">{name}</span>
          </div>
          <div class="text-xs text-dim">{detail}</div>
        </div>
      </div>
    </div>
  );
}

export function AnalysisBrowser({ ctx, sessions, query, folderId, onOpenFolder, onOpenSession, onSessionsChanged }: {
  ctx: AppContext;
  /** Every analysis, in library order — NOT filtered: the tree needs the whole
   *  list to know which ones it has no opinion about (see rootOrder). */
  sessions: Analysis[];
  /** The search box, already trimmed and lowercased. */
  query: string;
  /** Which folder is open; null is the root, shown as "Home". */
  folderId: string | null;
  onOpenFolder: (folderId: string | null) => void;
  onOpenSession: (id: string) => void;
  /** Deleting a folder deletes the recordings in it — the one action here that
   *  changes what EXISTS rather than how it is arranged, so the library has to
   *  re-read its list rather than re-derive it. */
  onSessionsChanged: () => void;
}) {
  const tree = sessionTreeOf(ctx.user);
  const allIds = sessions.map(s => s.id);
  const byId = new Map(sessions.map(s => [s.id, s]));
  const edit = (fn: Parameters<typeof editSessionTree>[1]) => { void ctx.mutate(s => editSessionTree(s, fn)); };

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
   *  recordings go first — `deleteSession` also drops their audio, locally and
   *  on Drive — then the now-empty folders leave the tree, and the screen
   *  climbs to the parent, which is the only place left to be. */
  const removeFolder = () => {
    if (!current) return;
    const doomed = collectFolderSessionIds(tree, current.id);
    confirmModal(
      t('sessions.folder.delete.title'),
      t('sessions.folder.delete.message', { name: current.name }),
      t('common.delete'),
      () => {
        const finish = () => {
          edit(tr => deleteFolderTree(tr, current.id));
          onOpenFolder(parentId);
          onSessionsChanged();
        };
        if (doomed.length === 0) { finish(); return; }
        // A folder holding thirty evenings is thirty Drive round trips; a
        // dialog that says where it is beats one that looks frozen.
        const steps: BatchStep[] = doomed.map(id => ({
          label: byId.get(id)?.name ?? id,
          run: async () => { await deleteSession(id); return { status: 'done' as const }; },
        }));
        showBatchProgress(t('sessions.folder.delete.title'), steps, finish);
      },
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

  // Searching flattens everything: what is being asked is "where is that
  // evening", and an answer three folders down is not one. The breadcrumb goes
  // with it — there is no "here" while the whole library is being searched, and
  // nothing is dragged either, for the same reason: a list that is not a place
  // has no order to rearrange.
  if (query) {
    const found = sessions.filter(s => matchesSearch(s.name, query));
    return (
      <div class="mt-4 space-y-2">
        {found.length === 0
          ? <p class="text-xs text-dim text-center py-4">{t('sessions.noSearchResults')}</p>
          : found.map(s => (
            <Card
              key={s.id}
              icon={SOURCE_BADGE[s.source].icon}
              iconTitle={t(SOURCE_BADGE[s.source].title)}
              name={s.name}
              detail={analysisDetail(s)}
              onOpen={() => onOpenSession(s.id)}
              target={{ kind: 'session', id: s.id }}
              accepts={() => false}
              onDrop={() => {}}
            />
          ))}
      </div>
    );
  }

  return (
    <>
      {/* No folders without a library (the standalone page, 2026-10-26): its
          analyses are to go into an account one day, and folders made here
          would have to be merged into that account's own tree. With none to
          make, the row would hold only "Home". */}
      {hasLibrary() && (
      <div class="mt-3 flex items-center gap-2">
        {/* The breadcrumb. Every step but the last is a way back up; the last
            is where you are, so it is not a link. Wraps rather than scrolls —
            a deep path on a phone is still readable stacked. */}
        <div class="flex-1 min-w-0 flex items-center gap-1 flex-wrap text-xs">
          <button
            type="button"
            class={`cursor-pointer transition-colors ${here === null ? 'text-primary font-medium cursor-default' : 'text-dim hover:text-accent'}`}
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
                  class={`truncate cursor-pointer transition-colors ${last ? 'text-primary font-medium cursor-default' : 'text-dim hover:text-accent'}`}
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
        {current && (
          <button
            type="button"
            class="shrink-0 w-6 h-6 flex items-center justify-center rounded text-dim hover:text-accent hover:bg-elevated transition-colors cursor-pointer border-none bg-transparent"
            title={t('sessions.folder.rename')}
            aria-label={t('sessions.folder.rename')}
            onClick={rename}
          >
            <PencilIcon size={12} />
          </button>
        )}
        {/* No glyph: the label already carries the plus, same as the sidebar's. */}
        <button type="button" class="btn-ghost text-xs px-2 py-1 shrink-0 text-dim hover:text-accent" onClick={newFolder}>
          {t('sessions.folder.new')}
        </button>
        {/* Like the rename beside it: only from inside, and for the same
            reason — this one takes a whole subtree, so it must never sit on a
            row you were only scrolling past. */}
        {current && (
          <button
            type="button"
            class="btn-danger px-2 shrink-0"
            title={t('sessions.folder.delete.title')}
            aria-label={t('sessions.folder.delete.title')}
            onClick={removeFolder}
          >
            <TrashIcon size={14} />
          </button>
        )}
      </div>
      )}

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
          <p class="text-xs text-dim text-center py-4">
            {here === null ? t('sessions.empty') : t('sessions.folder.empty')}
          </p>
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
                  icon={<FolderGlyph />}
                  name={folder.name}
                  detail={folderDetail(childFolderIds(tree, folder.id).length, folderOrder(tree, folder.id, allIds).length)}
                  onOpen={() => onOpenFolder(folder.id)}
                  dragItem={{ type: 'folder', id: folder.id }}
                  target={{ kind: 'folder', id: folder.id }}
                  accepts={folderAccepts(folder.id)}
                  onDrop={onDrop}
                />
              );
            }
            const session = byId.get(item.id)!;
            return (
              <Card
                key={session.id}
                icon={SOURCE_BADGE[session.source].icon}
                iconTitle={t(SOURCE_BADGE[session.source].title)}
                name={session.name}
                detail={analysisDetail(session)}
                onOpen={() => onOpenSession(session.id)}
                dragItem={{ type: 'session', id: session.id }}
                target={{ kind: 'session', id: session.id }}
                accepts={sessionAccepts}
                onDrop={onDrop}
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
function folderDetail(folders: number, analyses: number): string {
  const parts: string[] = [];
  if (folders > 0) parts.push(t(folders === 1 ? 'sessions.folder.countFolders' : 'sessions.folder.countFoldersPlural', { n: folders }));
  if (analyses > 0) parts.push(t(analyses === 1 ? 'sessions.folder.countAnalyses' : 'sessions.folder.countAnalysesPlural', { n: analyses }));
  return parts.length > 0 ? parts.join(' · ') : t('sessions.folder.empty');
}

function analysisDetail(session: Analysis): string {
  // The date always, in today's format, even when the name says it too — no
  // reading dates out of names (the user's call, 2026-10-16; see
  // sessionNaming.ts's header).
  const when = session.date ? fmtSessionDateTime(session.date) : '';
  return `${when ? `${when} · ` : ''}${fmtLongTime(session.duration)} · ${t(session.annotations.length === 1 ? 'sessions.tunesCount' : 'sessions.tunesCountPlural', { n: session.annotations.length })}`;
}
