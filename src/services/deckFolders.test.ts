import { describe, it, expect } from 'vitest';
import { folderChainIds } from './deckService';
import { emptyState } from '../utils';
import type { AppState } from '../types';

function withFolders(): AppState {
  const user = emptyState();
  user.folders = {
    folk:  { id: 'folk',  name: 'Folk',  folderIds: ['reels'], deckIds: [] },
    reels: { id: 'reels', name: 'Reels', folderIds: [], deckIds: ['d1'] },
  };
  user.rootFolderIds = ['folk'];
  return user;
}

describe('folderChainIds', () => {
  it('lists a folder and its ancestors, outermost first', () => {
    expect(folderChainIds('reels', withFolders())).toEqual(['folk', 'reels']);
    expect(folderChainIds('folk', withFolders())).toEqual(['folk']);
  });

  it('is empty for the root and for a folder that no longer exists', () => {
    expect(folderChainIds(null, withFolders())).toEqual([]);
    expect(folderChainIds('gone', withFolders())).toEqual([]);
  });

  it('stops on a cycle instead of looping', () => {
    const user = withFolders();
    user.folders.reels!.folderIds = ['folk'];
    expect(folderChainIds('reels', user).length).toBeLessThanOrEqual(2);
  });
});
