import { describe, it, expect } from 'vitest';
import type { AppState } from '../types';
import { TUNE_ANALYSER_MODULE_KEY, type TuneAnalyserModuleData } from './model';
import {
  allFolderIds, childFolderIds, collectFolderSessionIds, createFolder, deleteFolderTree,
  editSessionTree, emptyTree, folderChain, folderDate, folderOrder, folderPathOf, forgetSession,
  isFolderDescendant, levelItems, moveFolder, parentFolderOf, placeSession, renameFolder, rootOrder,
  sessionTreeOf, type SessionTree,
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

  it('is the library order whatever the stored list says', () => {
    const t = emptyTree();
    t.rootSessionIds = ['s1', 's2'];
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

});

describe('folderOrder', () => {
  it('is the library order, not the order analyses were put in', () => {
    // Reported 2026-10-11: the newest import went to the BOTTOM of a folder
    // kept most recent first, because it was appended.
    const t = tree();
    for (const id of ['s2', 's1', 's3']) placeSession(t, id, 'f1');
    expect(folderOrder(t, 'f1', ['s3', 's2', 's1'])).toEqual(['s3', 's2', 's1']);
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

describe('a level\'s order — folders and analyses together, by date', () => {
  const s = (id: string, date: string | null, name = id) => ({ id, date, name });
  const ids = (t: SessionTree, folderId: string | null, sessions: ReturnType<typeof s>[]) =>
    levelItems(t, folderId, sessions).map(i => i.id);

  it('dates a folder by its most recent analysis, sub-folders included', () => {
    const t = tree(); // f2 inside f1
    placeSession(t, 'old', 'f1');
    placeSession(t, 'new', 'f2');
    const dates: Record<string, string> = { old: '2026-01-01T20:00:00.000Z', new: '2026-09-01T20:00:00.000Z' };
    expect(folderDate(t, 'f1', id => dates[id])).toBe('2026-09-01T20:00:00.000Z');
    expect(folderDate(t, 'f2', id => dates[id])).toBe('2026-09-01T20:00:00.000Z');
  });

  it('leaves a folder undated when it is empty, or holds nothing dated', () => {
    const t = tree();
    expect(folderDate(t, 'f1', () => null)).toBeNull();
    placeSession(t, 'u', 'f2');
    expect(folderDate(t, 'f1', () => null)).toBeNull();
  });

  it('mixes folders among the analyses, most recent first', () => {
    const t = emptyTree();
    createFolder(t, 'f1', 'Été', null);
    placeSession(t, 'in', 'f1');
    const sessions = [
      s('newest', '2026-10-01T20:00:00.000Z'),
      s('in', '2026-08-01T20:00:00.000Z'),
      s('oldest', '2026-05-01T20:00:00.000Z'),
    ];
    expect(ids(t, null, sessions)).toEqual(['newest', 'f1', 'oldest']);
  });

  it('puts the undated last — folders and analyses alike — alphabetically', () => {
    const t = emptyTree();
    createFolder(t, 'fE', 'Empty', null);
    createFolder(t, 'fB', 'Bag', null);
    placeSession(t, 'u2', 'fB'); // holds only an undated analysis
    const sessions = [
      s('zebra', null, 'Zebra'),
      s('dated', '2026-09-01T20:00:00.000Z', 'Dated'),
      s('apple', null, 'Apple'),
      s('u2', null, 'Inside'),
    ];
    expect(ids(t, null, sessions)).toEqual(['dated', 'apple', 'fB', 'fE', 'zebra']);
  });

  it('sorts inside a folder by the same rule', () => {
    const t = tree(); // f2 inside f1
    placeSession(t, 'a', 'f1');
    placeSession(t, 'b', 'f2');
    const sessions = [s('a', '2026-01-01T20:00:00.000Z'), s('b', '2026-03-01T20:00:00.000Z')];
    expect(ids(t, 'f1', sessions)).toEqual(['f2', 'a']);
  });

  it('ignores an id that no longer exists — it neither shows nor dates a folder', () => {
    const t = tree();
    placeSession(t, 'gone', 'f1');
    expect(ids(t, 'f1', [])).toEqual(['f2']);
    expect(ids(t, null, [s('x', '2026-01-01T20:00:00.000Z')])).toEqual(['x', 'f1']);
  });

  it('survives a cycle left by a merge', () => {
    const t = tree();
    t.folders['f2']!.folderIds.push('f1');
    expect(folderDate(t, 'f1', () => null)).toBeNull();
  });
});

describe('forgetSession', () => {
  it('forgets a deleted analysis wherever it was', () => {
    const t = tree();
    placeSession(t, 's1', 'f2');
    forgetSession(t, 's1');
    expect(folderOrder(t, 'f2', ['s1'])).toEqual([]);
  });
});
