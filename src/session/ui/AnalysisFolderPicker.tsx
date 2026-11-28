import type { AppContext } from '../../types';
import { FolderPicker } from '../../components/folderBrowser';
import { editSessionTree, placeSession, sessionTreeOf } from '../sessionTree';

// ── Where one analysis lives ─────────────────────────────────────────────────
// The deck view's "Emplacement :" row, for an analysis: the same control, in
// the same place under the title, because it answers the same question. The
// chooser itself is components/folderBrowser.tsx's FolderPicker since
// 2026-11-28 (a transcription has one too); it renders nothing while there are
// no folders.

export function AnalysisFolderPicker({ ctx, sessionId }: { ctx: AppContext; sessionId: string }) {
  return (
    <FolderPicker
      tree={sessionTreeOf(ctx.user)}
      itemId={sessionId}
      onPlace={(folderId) => { void ctx.mutate(s => editSessionTree(s, tr => placeSession(tr, sessionId, folderId))); }}
    />
  );
}
