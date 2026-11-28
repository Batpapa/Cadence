import type { ComponentChildren, JSX } from 'preact';
import { t } from '../../services/i18nService';
import { hasLibrary } from '../../services/pageMode';
import type { AppContext } from '../../types';
import { MicIcon, FileAudioIcon, DeviceAudioIcon } from '../../components/icons';
import { FolderBrowser, type FolderSource } from '../../components/folderBrowser';
import { fmtLongTime } from './sessionUiShared';
import { fmtSessionDateTime } from '../sessionNaming';
import type { Analysis } from '../model';
import { deleteSessions } from '../db';
import { showBlockingProgress } from './batchRunner';
import { editSessionTree, sessionTreeOf } from '../sessionTree';

// ── Browsing the analyses, one folder at a time ──────────────────────────────
// The folder browser (components/folderBrowser.tsx — this file's own code
// until 2026-11-28, when the Transcription module got folders too) on the
// analyser's tree, with its rows and its way of deleting a folder's analyses.

/** What each kind of analysis is marked with. Same glyphs as the source
 *  selector on the start button, so the icon that chose a recording is the icon
 *  that later identifies it. */
const SOURCE_BADGE: Record<Analysis['source'], { icon: JSX.Element; title: string }> = {
  live:   { icon: <MicIcon size={12} />,         title: 'sessions.source.mic' },
  device: { icon: <DeviceAudioIcon size={12} />, title: 'sessions.source.device' },
  import: { icon: <FileAudioIcon size={12} />,   title: 'sessions.importBadge' },
};

function analysisDetail(session: Analysis): string {
  // The date always, in today's format, even when the name says it too — no
  // reading dates out of names (the user's call, 2026-10-16; see
  // sessionNaming.ts's header).
  const when = session.date ? fmtSessionDateTime(session.date) : '';
  return `${when ? `${when} · ` : ''}${fmtLongTime(session.duration)} · ${t(session.annotations.length === 1 ? 'sessions.tunesCount' : 'sessions.tunesCountPlural', { n: session.annotations.length })}`;
}

export function AnalysisBrowser({ ctx, sessions, query, folderId, onOpenFolder, onOpenSession, onSessionsChanged, toolbar }: {
  ctx: AppContext;
  /** Every analysis, in library order — NOT filtered: the tree needs the whole
   *  list to know which ones it has no opinion about (see rootOrder). */
  sessions: Analysis[];
  /** The search box, already trimmed and lowercased. */
  query: string;
  /** Which folder is open; null is the root, shown as "Home". */
  folderId: string | null;
  /** `keepSearch` false: the search is left behind (a folder found by it). */
  /** `from`: the key of the card opened from (navOrigin.ts). */
  onOpenFolder: (folderId: string | null, keepSearch?: boolean, from?: string) => void;
  onOpenSession: (id: string, from?: string) => void;
  /** Deleting a folder deletes the recordings in it — the one action here that
   *  changes what EXISTS rather than how it is arranged, so the library has to
   *  re-read its list rather than re-derive it. */
  onSessionsChanged: () => void;
  /** The search box, owned by the screen, shown just under the breadcrumb,
   *  browsing or searching: the search runs in the folder the breadcrumb
   *  names. */
  toolbar: ComponentChildren;
}) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const source: FolderSource = {
    tree: sessionTreeOf(ctx.user),
    edit: (fn) => { void ctx.mutate(s => editSessionTree(s, fn)); },
    // All of them in one write, at once (deleteSessions), which also drops
    // their audio; then — once the screen has turned round — the list read
    // again, and their recordings cleared here and on Drive, in view, behind a
    // dialog that stays until it is done: a folder of thirty evenings is thirty
    // Drive round trips, and the tab is not safe to close before.
    deleteItems: async (ids) => {
      const names = new Map(ids.map(id => [id, byId.get(id)?.name ?? id]));
      const leftovers = await deleteSessions(ids);
      return async () => {
        onSessionsChanged();
        if (leftovers.length > 0) {
          await showBlockingProgress(t('sessions.folder.delete.title'), leftovers.map(l => ({
            label: names.get(l.sessionId) ?? l.sessionId,
            run: async () => { await l.clear(); return { status: 'done' as const }; },
          })));
        }
      };
    },
    icon: (id) => SOURCE_BADGE[byId.get(id)!.source].icon,
    iconTitle: (id) => t(SOURCE_BADGE[byId.get(id)!.source].title),
    detail: (id) => analysisDetail(byId.get(id)!),
    key: 'analysis',
    count: (n) => t(n === 1 ? 'sessions.folder.countAnalyses' : 'sessions.folder.countAnalysesPlural', { n }),
    empty: t('sessions.empty'),
    noResults: t(hasLibrary() ? 'sessions.noSearchResultsWithFolders' : 'sessions.noSearchResults'),
    tour: 'analysis-row',
  };
  return (
    <FolderBrowser
      source={source}
      items={sessions}
      query={query}
      folderId={folderId}
      onOpenFolder={onOpenFolder}
      onOpenItem={onOpenSession}
      toolbar={toolbar}
    />
  );
}
