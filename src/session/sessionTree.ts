import type { AppState } from '../types';
import { TUNE_ANALYSER_MODULE_KEY, type SessionFolder, type TuneAnalyserModuleData } from './model';

// ── Folders over the analyses library ────────────────────────────────────────
// Same shape as the decks' own folder tree (types.ts's Folder, services/
// deckService.ts): a parent holds ORDERED lists of its children, because the
// order is the point — the user arranges the list, they do not just label it.
// Deliberately a copy of that shape rather than a reuse of it: `User.folders`
// is the decks' tree, it is shown in the sidebar, and putting analyses in it
// would make every deck folder answer for two unrelated kinds of content.
//
// ⚠️ The one rule that is NOT the decks' rule, and the reason this file exists
// at all: **the list of analyses is the truth, the tree is only an arrangement**.
// An analysis named by no list still shows up, at the top of the root level
// (`rootOrder` below). It has to: this whole blob belongs to ONE local user
// (`modules` is a field of `User`, written per user id by db.ts's saveUser —
// nothing here is ever shared between two people on the same device), but that
// one user syncs it across their own devices through Drive, and one of those
// can still be running a bundle from before folders existed. That device
// records an evening, writes it into `sessions`, and knows nothing about
// `rootSessionIds`. A tree treated as authoritative would make that recording
// invisible — the user's own words on this module, "c'est crucial qu'on ne
// casse rien chez eux".
//
// The tree is therefore stored as three fields that are all absent until the
// first folder is made (see `editSessionTree`), so nothing changes at all in
// the blob of someone who never makes one.

export interface SessionTree {
  folders: Record<string, SessionFolder>;
  rootFolderIds: string[];
  rootSessionIds: string[];
}

/** What a drag is carrying, and what it is being dropped on. */
export type TreeItem = { type: 'folder' | 'session'; id: string };

/** Where a drop lands relative to the row under the pointer — `into` only ever
 *  applies to a folder. Same three zones as the sidebar's tree. */
export type DropZone = 'before' | 'after' | 'into';

export function emptyTree(): SessionTree {
  return { folders: {}, rootFolderIds: [], rootSessionIds: [] };
}

/** The tree as it stands, tolerant of every field being absent (which is the
 *  normal state for anyone who has never made a folder). Returns a detached
 *  copy — mutating it changes nothing; `editSessionTree` is how it is written. */
export function sessionTreeOf(user: AppState): SessionTree {
  const mod = user.modules?.[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined;
  return {
    folders: Object.fromEntries(Object.entries(mod?.folders ?? {}).map(([id, f]) => [id, {
      id: f.id,
      name: f.name,
      folderIds: [...(f.folderIds ?? [])],
      sessionIds: [...(f.sessionIds ?? [])],
    }])),
    rootFolderIds: [...(mod?.rootFolderIds ?? [])],
    rootSessionIds: [...(mod?.rootSessionIds ?? [])],
  };
}

/** Applies `fn` to the user's tree and writes the result back. Call it INSIDE
 *  a `ctx.mutate(...)` — it takes the draft state, not the store.
 *
 *  An empty tree is written as three absent fields rather than as three empty
 *  containers: "no folders" is the state every install is in today, and it
 *  should keep looking exactly like that in the synced blob. */
export function editSessionTree(user: AppState, fn: (tree: SessionTree) => void): void {
  const tree = sessionTreeOf(user);
  fn(tree);
  user.modules ??= {};
  const mod = (user.modules[TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData | undefined) ?? { sessions: {} };
  const empty = Object.keys(tree.folders).length === 0
    && tree.rootFolderIds.length === 0
    && tree.rootSessionIds.length === 0;
  if (empty) {
    delete mod.folders;
    delete mod.rootFolderIds;
    delete mod.rootSessionIds;
  } else {
    mod.folders = tree.folders;
    mod.rootFolderIds = tree.rootFolderIds;
    mod.rootSessionIds = tree.rootSessionIds;
  }
  user.modules[TUNE_ANALYSER_MODULE_KEY] = mod;
}

// ── Reading the tree ─────────────────────────────────────────────────────────

/** Every analysis id the tree places somewhere — root list included. */
function placedIds(tree: SessionTree): Set<string> {
  const placed = new Set(tree.rootSessionIds);
  for (const f of Object.values(tree.folders)) for (const id of f.sessionIds) placed.add(id);
  return placed;
}

/** Analyses the tree says nothing about, in the order they were given. Either
 *  they were never arranged, or they were recorded by a device that does not
 *  know about folders — see this file's header. */
export function unplacedIds(tree: SessionTree, allIds: string[]): string[] {
  const placed = placedIds(tree);
  return allIds.filter(id => !placed.has(id));
}

/** The root level's analyses: the unarranged ones first, in the order they
 *  came in (the library's own — most recent first), then the arranged ones.
 *
 *  New first, and not the other way round, because "unarranged" is what a
 *  recording made five minutes ago is: it lands where it has always landed,
 *  at the top, rather than below a row of evenings from last winter. */
export function rootOrder(tree: SessionTree, allIds: string[]): string[] {
  const known = new Set(allIds);
  return [...unplacedIds(tree, allIds), ...tree.rootSessionIds.filter(id => known.has(id))];
}

/** A folder's own analyses, in their arranged order, minus anything that no
 *  longer exists. Never picks up unplaced ones — those belong to the root. */
export function folderOrder(tree: SessionTree, folderId: string, allIds: string[]): string[] {
  const known = new Set(allIds);
  return (tree.folders[folderId]?.sessionIds ?? []).filter(id => known.has(id));
}

/** Sub-folders of a level, in order. `null` = the root level. */
export function childFolderIds(tree: SessionTree, folderId: string | null): string[] {
  const ids = folderId === null ? tree.rootFolderIds : tree.folders[folderId]?.folderIds ?? [];
  return ids.filter(id => !!tree.folders[id]);
}

export function parentFolderOf(tree: SessionTree, item: TreeItem): string | null {
  for (const f of Object.values(tree.folders)) {
    const list = item.type === 'folder' ? f.folderIds : f.sessionIds;
    if (list.includes(item.id)) return f.id;
  }
  return null;
}

/** "Sessions d'hiver / Mardis" — the label a folder is offered under. */
export function folderPathOf(tree: SessionTree, folderId: string): string {
  const parts: string[] = [];
  let current: string | null = folderId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const folder: SessionFolder | undefined = tree.folders[current];
    if (!folder) break;
    parts.unshift(folder.name);
    current = parentFolderOf(tree, { type: 'folder', id: current });
  }
  return parts.join(' / ');
}

/** A folder and its ancestors, outermost first — the breadcrumb, in order.
 *
 *  Empty for the root (`null`), and empty for an id whose record is gone: a
 *  breadcrumb that cannot be built is a breadcrumb that should not be shown,
 *  and the caller then reads that as "we are at the root", which is where a
 *  deleted folder leaves you anyway.
 *
 *  Guards against a cycle rather than trusting there is none. Nothing here
 *  creates one, but this walks user data that has been through a Drive merge,
 *  and an infinite loop in a breadcrumb takes the whole tab down with it. */
export function folderChain(tree: SessionTree, folderId: string | null): SessionFolder[] {
  const chain: SessionFolder[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const folder = tree.folders[current];
    if (!folder) return [];
    chain.unshift(folder);
    current = parentFolderOf(tree, { type: 'folder', id: current });
  }
  return chain;
}

/** Every folder in the tree, in display order — what "collapse all" needs. */
export function allFolderIds(tree: SessionTree): string[] {
  const out: string[] = [];
  const visit = (ids: string[]) => {
    for (const id of ids) {
      if (!tree.folders[id]) continue;
      out.push(id);
      visit(tree.folders[id]!.folderIds);
    }
  };
  visit(tree.rootFolderIds);
  return out;
}

export function isFolderDescendant(tree: SessionTree, ancestorId: string, targetId: string): boolean {
  const folder = tree.folders[ancestorId];
  if (!folder) return false;
  if (folder.folderIds.includes(targetId)) return true;
  return folder.folderIds.some(subId => isFolderDescendant(tree, subId, targetId));
}

// ── Writing the tree ─────────────────────────────────────────────────────────

/** Takes an id out of every list it appears in, wherever that is. */
function detach(tree: SessionTree, item: TreeItem): void {
  if (item.type === 'folder') {
    tree.rootFolderIds = tree.rootFolderIds.filter(id => id !== item.id);
    for (const f of Object.values(tree.folders)) f.folderIds = f.folderIds.filter(id => id !== item.id);
  } else {
    tree.rootSessionIds = tree.rootSessionIds.filter(id => id !== item.id);
    for (const f of Object.values(tree.folders)) f.sessionIds = f.sessionIds.filter(id => id !== item.id);
  }
}

/** Freezes the order currently ON SCREEN into the tree, so that everything at
 *  the root level has an explicit position.
 *
 *  Needed before any before/after drop: until the first one, most analyses are
 *  unplaced (see `rootOrder`), and inserting "just above that one" is
 *  meaningless when "that one" is in no list either. Called once, by the first
 *  drag — which is also when the user first expresses an order to keep. */
export function settleRoot(tree: SessionTree, allIds: string[]): void {
  tree.rootSessionIds = rootOrder(tree, allIds);
}

export function createFolder(tree: SessionTree, id: string, name: string, parentId: string | null): void {
  tree.folders[id] = { id, name, folderIds: [], sessionIds: [] };
  if (parentId && tree.folders[parentId]) tree.folders[parentId]!.folderIds.push(id);
  else tree.rootFolderIds.push(id);
}

export function renameFolder(tree: SessionTree, folderId: string, name: string): void {
  const folder = tree.folders[folderId];
  if (folder) folder.name = name;
}

/** Every analysis a folder holds, its sub-folders included — what deleting it
 *  would take with it, and therefore what the confirmation has to count. */
export function collectFolderSessionIds(tree: SessionTree, folderId: string): string[] {
  const folder = tree.folders[folderId];
  if (!folder) return [];
  return [...folder.sessionIds, ...folder.folderIds.flatMap(subId => collectFolderSessionIds(tree, subId))];
}

/** Removes a folder and every sub-folder under it.
 *
 *  The analyses themselves are NOT this function's business: the tree only
 *  holds ids, and a recording is deleted through `deleteSession` (which also
 *  drops its audio, locally and on Drive). The caller does that first, with
 *  `collectFolderSessionIds`, behind a confirmation — same contract as the
 *  decks' `deleteFolderRecursive` (views/folder.tsx). */
export function deleteFolderTree(tree: SessionTree, folderId: string): void {
  const folder = tree.folders[folderId];
  if (!folder) return;
  for (const subId of [...folder.folderIds]) deleteFolderTree(tree, subId);
  detach(tree, { type: 'folder', id: folderId });
  delete tree.folders[folderId];
}

/** Puts an analysis in a folder (or back at the root), at the end of it. */
export function placeSession(tree: SessionTree, sessionId: string, folderId: string | null): void {
  detach(tree, { type: 'session', id: sessionId });
  if (folderId && tree.folders[folderId]) tree.folders[folderId]!.sessionIds.push(sessionId);
  else tree.rootSessionIds.push(sessionId);
}

/** Reparents a folder, at the end of its new parent. No-op on a cycle. */
export function moveFolder(tree: SessionTree, folderId: string, parentId: string | null): void {
  if (parentId === folderId) return;
  if (parentId && isFolderDescendant(tree, folderId, parentId)) return;
  if (!tree.folders[folderId]) return;
  detach(tree, { type: 'folder', id: folderId });
  if (parentId && tree.folders[parentId]) tree.folders[parentId]!.folderIds.push(folderId);
  else tree.rootFolderIds.push(folderId);
}

function insertNextTo(tree: SessionTree, drag: TreeItem, target: TreeItem, before: boolean): void {
  const listsFor = (type: 'folder' | 'session'): string[][] => [
    type === 'folder' ? tree.rootFolderIds : tree.rootSessionIds,
    ...Object.values(tree.folders).map(f => (type === 'folder' ? f.folderIds : f.sessionIds)),
  ];

  if (drag.type === target.type) {
    for (const list of listsFor(target.type)) {
      const idx = list.indexOf(target.id);
      if (idx === -1) continue;
      list.splice(before ? idx : idx + 1, 0, drag.id);
      return;
    }
  }
  // Dropped next to a row of the other kind: the position within the level is
  // meaningless (folders and analyses are two separate runs), so only the
  // level itself is honoured — the item joins the target's parent.
  const parentId = parentFolderOf(tree, target);
  if (drag.type === 'folder') moveFolder(tree, drag.id, parentId);
  else placeSession(tree, drag.id, parentId);
}

/** Applies one drop. `allIds` is the library order, used to settle the root
 *  the first time anything is arranged (see `settleRoot`). */
export function applyDrop(tree: SessionTree, drag: TreeItem, target: TreeItem, zone: DropZone, allIds: string[]): void {
  if (drag.id === target.id) return;
  if (drag.type === 'folder' && target.type === 'folder' && isFolderDescendant(tree, drag.id, target.id)) return;
  if (drag.type === 'folder' && !tree.folders[drag.id]) return;

  if (zone === 'into') {
    if (target.type !== 'folder' || !tree.folders[target.id]) return;
    if (drag.type === 'folder') moveFolder(tree, drag.id, target.id);
    else placeSession(tree, drag.id, target.id);
    return;
  }

  settleRoot(tree, allIds);
  detach(tree, drag);
  insertNextTo(tree, drag, target, zone === 'before');
}

/** Forgets a deleted analysis. Nothing breaks without it — every read filters
 *  against the real list — it only keeps the blob from collecting dead ids. */
export function forgetSession(tree: SessionTree, sessionId: string): void {
  detach(tree, { type: 'session', id: sessionId });
}
