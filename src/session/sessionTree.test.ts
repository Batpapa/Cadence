import { describe, it, expect } from 'vitest';
import type { AppState } from '../types';
import { TUNE_ANALYSER_MODULE_KEY, type TuneAnalyserModuleData } from './model';
import {
  allFolderIds, applyDrop, childFolderIds, collectFolderSessionIds, createFolder, deleteFolderTree,
  editSessionTree, emptyTree, folderChain, folderOrder, folderPathOf, forgetSession,
  isFolderDescendant, moveFolder, parentFolderOf, placeSession, renameFolder, rootOrder,
  sessionTreeOf, settleRoot, unplacedIds, type SessionTree,
} from './sessionTree';

/** A tree with two folders and nothing arranged at the root. */
function tree(): SessionTree {
  const t = emptyTree();
  createFolder(t, 'f1', 'Mardis', null);
  createFolder(t, 'f2', 'Été', 'f1');
  return t;
}

/** Just enough AppState for the two functions that take one. */
function state(mod?: Partial<TuneAnalyserModuleData>): AppState {
  return { modules: mod ? { [TUNE_ANALYSER_MODULE_KEY]: { sessions: {}, ...mod } } : undefined } as unknown as AppState;
}

describe('sessionTreeOf / editSessionTree', () => {
  it('reads an install that has never had a folder as an empty tree', () => {
    expect(sessionTreeOf(state())).toEqual(emptyTree());
  });

  it('leaves the three fields ABSENT when the tree is empty', () => {
    const s = state({ sessions: {} });
    editSessionTree(s, t => { createFolder(t, 'f1', 'x', null); deleteFolderTree(t, 'f1'); });
    const mod = s.modules![TUNE_ANALYSER_MODULE_KEY] as TuneAnalyserModuleData;
    expect('folders' in mod).toBe(false);
    expect('rootFolderIds' in mod).toBe(false);
    expect('rootSessionIds' in mod).toBe(false);
  });

  it('round-trips a tree through the module data', () => {
    const s = state();
    editSessionTree(s, t => { createFolder(t, 'f1', 'Mardis', null); placeSession(t, 's1', 'f1'); });
    expect(sessionTreeOf(s).folders['f1']).toEqual({ id: 'f1', name: 'Mardis', folderIds: [], sessionIds: ['s1'] });
  });

  it('does not hand out a live reference to the stored arrays', () => {
    const s = state();
    editSessionTree(s, t => createFolder(t, 'f1', 'Mardis', null));
    const copy = sessionTreeOf(s);
    copy.folders['f1']!.name = 'changed';
    copy.rootFolderIds.push('ghost');
    expect(sessionTreeOf(s).folders['f1']!.name).toBe('Mardis');
    expect(sessionTreeOf(s).rootFolderIds).toEqual(['f1']);
  });
});

describe('rootOrder', () => {
  it('is the library order untouched while nothing is arranged', () => {
    expect(rootOrder(emptyTree(), ['s1', 's2', 's3'])).toEqual(['s1', 's2', 's3']);
  });

  it('puts the unarranged ones FIRST, so a new recording stays on top', () => {
    const t = emptyTree();
    t.rootSessionIds = ['s2', 's1'];
    // s3 is the one a device that knows nothing about folders just recorded.
    expect(rootOrder(t, ['s3', 's2', 's1'])).toEqual(['s3', 's2', 's1']);
  });

  it('never shows an analysis that is already in a folder', () => {
    const t = tree();
    placeSession(t, 's1', 'f1');
    expect(rootOrder(t, ['s1', 's2'])).toEqual(['s2']);
  });

  it('drops ids of analyses that no longer exist', () => {
    const t = emptyTree();
    t.rootSessionIds = ['gone', 's1'];
    expect(rootOrder(t, ['s1'])).toEqual(['s1']);
  });

  it('reports what it holds no opinion about', () => {
    const t = tree();
    placeSession(t, 's1', 'f2');
    expect(unplacedIds(t, ['s1', 's2'])).toEqual(['s2']);
  });
});

describe('folders', () => {
  it('nests, and knows its own path', () => {
    const t = tree();
    expect(childFolderIds(t, null)).toEqual(['f1']);
    expect(childFolderIds(t, 'f1')).toEqual(['f2']);
    expect(folderPathOf(t, 'f2')).toBe('Mardis / Été');
  });

  it('hides a child id whose folder record is gone', () => {
    const t = tree();
    delete t.folders['f2'];
    expect(childFolderIds(t, 'f1')).toEqual([]);
  });

  it('lists every folder in display order, for "collapse all"', () => {
    const t = tree();
    createFolder(t, 'f3', 'Jeudis', null);
    createFolder(t, 'f4', 'Hiver', 'f2');
    expect(allFolderIds(t)).toEqual(['f1', 'f2', 'f4', 'f3']);
  });

  it('skips a child id whose folder record is gone rather than looping', () => {
    const t = tree();
    delete t.folders['f2'];
    expect(allFolderIds(t)).toEqual(['f1']);
  });

  it('builds a breadcrumb, outermost first', () => {
    const t = tree();
    expect(folderChain(t, 'f2').map(f => f.name)).toEqual(['Mardis', 'Été']);
    expect(folderChain(t, 'f1').map(f => f.name)).toEqual(['Mardis']);
  });

  it('has no breadcrumb at the root, nor for a folder that is gone', () => {
    const t = tree();
    expect(folderChain(t, null)).toEqual([]);
    expect(folderChain(t, 'nope')).toEqual([]);
  });

  it('does not hang on a cycle that came back from a merge', () => {
    const t = tree();
    // f1 holds f2 (from the fixture); make f2 hold f1 as well.
    t.folders['f2']!.folderIds.push('f1');
    expect(folderChain(t, 'f2').length).toBeLessThanOrEqual(2);
  });

  it('renames', () => {
    const t = tree();
    renameFolder(t, 'f1', 'Jeudis');
    expect(folderPathOf(t, 'f2')).toBe('Jeudis / Été');
  });

  it('deleting one takes its sub-folders with it, and leaves its siblings alone', () => {
    const t = emptyTree();
    createFolder(t, 'a', 'A', null);
    createFolder(t, 'f1', 'Mardis', null);
    createFolder(t, 'b', 'B', null);
    createFolder(t, 'sub', 'Sous', 'f1');
    deleteFolderTree(t, 'f1');
    expect(t.folders['f1']).toBeUndefined();
    expect(t.folders['sub']).toBeUndefined();
    expect(t.rootFolderIds).toEqual(['a', 'b']);
  });

  it('names every analysis a delete would take, sub-folders included', () => {
    const t = tree();
    placeSession(t, 's1', 'f1');
    placeSession(t, 's2', 'f2');
    expect(collectFolderSessionIds(t, 'f1').sort()).toEqual(['s1', 's2']);
    expect(collectFolderSessionIds(t, 'f2')).toEqual(['s2']);
    expect(collectFolderSessionIds(t, 'nope')).toEqual([]);
  });

  it('deleting a folder does not by itself remove the analyses from the tree', () => {
    // The ids go out with `deleteSession`, which is the caller's job — this
    // only proves the two steps are separate, not that one implies the other.
    const t = tree();
    placeSession(t, 's1', 'f1');
    deleteFolderTree(t, 'f1');
    expect(rootOrder(t, ['s1'])).toEqual(['s1']);
  });

  it('refuses to move a folder into its own descendant', () => {
    const t = tree();
    expect(isFolderDescendant(t, 'f1', 'f2')).toBe(true);
    moveFolder(t, 'f1', 'f2');
    expect(childFolderIds(t, null)).toEqual(['f1']);
  });

  it('moves a folder back to the root', () => {
    const t = tree();
    moveFolder(t, 'f2', null);
    expect(childFolderIds(t, null)).toEqual(['f1', 'f2']);
    expect(childFolderIds(t, 'f1')).toEqual([]);
  });
});

describe('placeSession', () => {
  it('moves an analysis between folders without leaving a copy behind', () => {
    const t = tree();
    placeSession(t, 's1', 'f1');
    placeSession(t, 's1', 'f2');
    expect(folderOrder(t, 'f1', ['s1'])).toEqual([]);
    expect(folderOrder(t, 'f2', ['s1'])).toEqual(['s1']);
    expect(parentFolderOf(t, { type: 'session', id: 's1' })).toBe('f2');
  });

  it('sends it back to the root', () => {
    const t = tree();
    placeSession(t, 's1', 'f1');
    placeSession(t, 's1', null);
    expect(parentFolderOf(t, { type: 'session', id: 's1' })).toBeNull();
    expect(rootOrder(t, ['s1'])).toEqual(['s1']);
  });

  it('ignores a folder that does not exist, rather than losing the analysis', () => {
    const t = emptyTree();
    placeSession(t, 's1', 'nope');
    expect(rootOrder(t, ['s1'])).toEqual(['s1']);
  });
});

describe('applyDrop', () => {
  const all = ['s1', 's2', 's3'];

  it('freezes the visible order the first time anything is reordered', () => {
    const t = emptyTree();
    applyDrop(t, { type: 'session', id: 's3' }, { type: 'session', id: 's1' }, 'before', all);
    expect(rootOrder(t, all)).toEqual(['s3', 's1', 's2']);
  });

  it('drops after a target', () => {
    const t = emptyTree();
    applyDrop(t, { type: 'session', id: 's1' }, { type: 'session', id: 's3' }, 'after', all);
    expect(rootOrder(t, all)).toEqual(['s2', 's3', 's1']);
  });

  it('reorders inside a folder', () => {
    const t = tree();
    placeSession(t, 's1', 'f1');
    placeSession(t, 's2', 'f1');
    applyDrop(t, { type: 'session', id: 's2' }, { type: 'session', id: 's1' }, 'before', all);
    expect(folderOrder(t, 'f1', all)).toEqual(['s2', 's1']);
  });

  it('drops an analysis INTO a folder', () => {
    const t = tree();
    applyDrop(t, { type: 'session', id: 's1' }, { type: 'folder', id: 'f1' }, 'into', all);
    expect(folderOrder(t, 'f1', all)).toEqual(['s1']);
    expect(rootOrder(t, all)).toEqual(['s2', 's3']);
  });

  it('drops a folder INTO a folder', () => {
    const t = emptyTree();
    createFolder(t, 'f1', 'A', null);
    createFolder(t, 'f2', 'B', null);
    applyDrop(t, { type: 'folder', id: 'f2' }, { type: 'folder', id: 'f1' }, 'into', all);
    expect(childFolderIds(t, 'f1')).toEqual(['f2']);
  });

  it('refuses a folder into its own descendant', () => {
    const t = tree();
    applyDrop(t, { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }, 'into', all);
    expect(childFolderIds(t, null)).toEqual(['f1']);
    expect(childFolderIds(t, 'f1')).toEqual(['f2']);
  });

  it('ignores a drop on itself', () => {
    const t = emptyTree();
    applyDrop(t, { type: 'session', id: 's1' }, { type: 'session', id: 's1' }, 'before', all);
    expect(t.rootSessionIds).toEqual([]);
  });

  it('reads a drop beside a row of the other kind as "join that level"', () => {
    const t = tree();
    placeSession(t, 's1', 'f1');
    // Dropped just above the folder f2, which lives in f1: the analysis joins f1.
    applyDrop(t, { type: 'session', id: 's2' }, { type: 'folder', id: 'f2' }, 'before', all);
    expect(folderOrder(t, 'f1', all)).toEqual(['s1', 's2']);
  });

  it('does not resurrect a folder that no longer exists', () => {
    const t = emptyTree();
    applyDrop(t, { type: 'folder', id: 'ghost' }, { type: 'session', id: 's1' }, 'before', all);
    expect(t.rootFolderIds).toEqual([]);
  });
});

describe('settleRoot / forgetSession', () => {
  it('settling twice changes nothing', () => {
    const t = emptyTree();
    settleRoot(t, ['s1', 's2']);
    settleRoot(t, ['s1', 's2']);
    expect(t.rootSessionIds).toEqual(['s1', 's2']);
  });

  it('forgets a deleted analysis wherever it was', () => {
    const t = tree();
    placeSession(t, 's1', 'f2');
    forgetSession(t, 's1');
    expect(folderOrder(t, 'f2', ['s1'])).toEqual([]);
  });
});
