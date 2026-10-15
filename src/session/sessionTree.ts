import type { AppState } from '../types';
import { TUNE_ANALYSER_MODULE_KEY, type SessionFolder, type TuneAnalyserModuleData } from './model';

// ── Folders over the analyses library ────────────────────────────────────────
// Same shape as the decks' own folder tree (types.ts's Folder, services/
// deckService.ts): a parent holds lists of its children. Those lists only say
// WHICH things a level holds, never in what order: a level is sorted, folders
// and analyses together, by date (`levelItems`). Analyses stopped being
// ordered by hand on 2026-10-11, after one imported into a folder kept most
// recent first landed at its bottom; folders followed on 2026-10-15, at the
// user's request — a folder dates from its most recent analysis, and takes its
// place among the analyses by that date. Stored order is ignored; appending is
// all any writer does.
// Deliberately a copy of that shape rather than a reuse of it: `User.folders`
// is the decks' tree, it is shown in the sidebar, and putting analyses in it
// would make every deck folder answer for two unrelated kinds of content.
//
// ⚠️ The one rule that is NOT the decks' rule, and the reason this file exists
// at all: **the list of analyses is the truth, the tree is only an arrangement**.
// An analysis named by no list still shows up, at the root level (`rootOrder`
// below). It has to: this whole blob belongs to ONE local user
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

/** A folder or an analysis — what a level lists, and what a drag carries. */
export type TreeItem = { type: 'folder' | 'session'; id: string };

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

/** The root level's analyses — those in no folder, whether the tree names them
 *  at the root or not at all — in `allIds`' order, which is the library's. */
export function rootOrder(tree: SessionTree, allIds: string[]): string[] {
  const inFolders = new Set(Object.values(tree.folders).flatMap(f => f.sessionIds));
  return allIds.filter(id => !inFolders.has(id));
}

/** A folder's own analyses, in `allIds`' order (the library's), minus anything
 *  that no longer exists. Never picks up unplaced ones — those belong to the
 *  root. */
export function folderOrder(tree: SessionTree, folderId: string, allIds: string[]): string[] {
  const here = new Set(tree.folders[folderId]?.sessionIds ?? []);
  return allIds.filter(id => here.has(id));
}

/** The library's order, for anything with a date and a name: dated first, most
 *  recent first; the undated after them, alphabetically. Analyses have sorted
 *  this way since 2026-09-08 (see db.ts's compareSessionsForLibrary, which is
 *  this); folders since 2026-10-15, by `folderDate`. */
export function compareByDateThenName(
  a: { date: string | null; name: string },
  b: { date: string | null; name: string },
): number {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return (a.name || '').localeCompare(b.name || '');
}

/** A folder's date: that of the most recent dated analysis anywhere under it,
 *  sub-folders included — a sub-folder's own date being exactly that, the
 *  recursion is the rule rather than an extra. Null when nothing under it is
 *  dated, an empty folder included: it then sorts with the undated, by name.
 *
 *  Guards against a cycle, as folderChain does: this walks merged user data. */
export function folderDate(
  tree: SessionTree,
  folderId: string,
  dateOf: (sessionId: string) => string | null | undefined,
  seen: Set<string> = new Set(),
): string | null {
  if (seen.has(folderId)) return null;
  seen.add(folderId);
  const folder = tree.folders[folderId];
  if (!folder) return null;
  let newest: string | null = null;
  for (const id of folder.sessionIds) {
    const d = dateOf(id);
    if (d && (!newest || d > newest)) newest = d;
  }
  for (const subId of folder.folderIds) {
    const d = folderDate(tree, subId, dateOf, seen);
    if (d && (!newest || d > newest)) newest = d;
  }
  return newest;
}

/** What one level shows, folders and analyses MIXED, in the library's order
 *  (compareByDateThenName, a folder dated by `folderDate`). `null` = the root.
 *
 *  `sessions` is every analysis that exists: the tree is only an arrangement
 *  of them (see this file's header), so an analysis it does not name shows at
 *  the root, and an id it names that no longer exists shows nowhere — and
 *  dates nothing. On a tie, the folder comes first. */
export function levelItems(
  tree: SessionTree,
  folderId: string | null,
  sessions: { id: string; date: string | null; name: string }[],
): TreeItem[] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const allIds = sessions.map(s => s.id);
  const dateOf = (id: string) => byId.get(id)?.date;
  const folders = childFolderIds(tree, folderId).map(id => ({
    item: { type: 'folder' as const, id },
    date: folderDate(tree, id, dateOf),
    name: tree.folders[id]!.name,
  }));
  const analyses = (folderId === null ? rootOrder(tree, allIds) : folderOrder(tree, folderId, allIds)).map(id => ({
    item: { type: 'session' as const, id },
    date: byId.get(id)!.date,
    name: byId.get(id)!.name,
  }));
  // Folders first into a stable sort: that is the whole tie rule.
  return [...folders, ...analyses].sort(compareByDateThenName).map(e => e.item);
}

/** Sub-folders of a level, in stored order — which is shown nowhere since
 *  2026-10-15 (see levelItems). `null` = the root level. */
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

/** Every folder in the tree, depth first in stored order — what "collapse
 *  all" needs. */
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

/** Puts an analysis in a folder (or back at the root). At the end of the
 *  list, for what that is worth: an analysis's place in it is never shown. */
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

/** Forgets a deleted analysis. Nothing breaks without it — every read filters
 *  against the real list — it only keeps the blob from collecting dead ids. */
export function forgetSession(tree: SessionTree, sessionId: string): void {
  detach(tree, { type: 'session', id: sessionId });
}
