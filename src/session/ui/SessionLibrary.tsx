import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { ImportTrayIcon, LibraryIcon } from '../../components/icons';
import type { LiveSourceKind } from '../audio/sources';
import { RecordingSources } from './recordingSources';
import { useTuneNames } from './tuneNames';
import { AnalysisBrowser } from './AnalysisBrowser';
import { useAnalysesList } from './useAnalysesList';
import { SearchField } from '../../components/searchField';
import { replaceRoute, replaceRouteNow, routeSignal, navEntry } from '../../store';
import { mayHoldAudio } from '../../services/audioSniff';
import { hasLibrary } from '../../services/pageMode';
import type { AppContext } from '../../types';

// ── Screen: the analyses ─────────────────────────────────────────────────────
// Past sessions + entry points into a new live recording / file import. Pure
// presentational component: every action (start live, import a file, import
// a shared session, open a past one) is a callback prop, wired up by
// sessions.tsx from sessionModule.ts's orchestration functions. No
// sessionModule.ts import here, on purpose: keeps this a leaf presentational
// component (also avoids a circular import — sessionModule.ts doesn't need
// to know about this component at all any more).
//
// The detections were this screen's second tab until 2026-11-20; they are a
// page of their own now (DetectionsLibrary), reached by the button beside the
// search box.

/** Whether a drag is carrying FILES from outside the page.
 *
 *  This whole screen is a drop target for importing an audio file, and it used
 *  to light up for any drag at all — including one of its own rows being moved
 *  in the analyses tree. Worse, the row stops that drop from bubbling (it has
 *  its own), so the handler that turns the tint back off never ran and the
 *  panel stayed blue until the next reload. Asking what the drag CARRIES is the
 *  fix and the better question: an internal row carries text, not files.
 *
 *  `types` rather than `files`, because during a drag the file list is
 *  deliberately empty — only its presence is exposed, not its contents. */
function isFileDrag(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}

interface SessionLibraryProps {
  /** Needed by the folder browser, which reads and writes the tree on the
   *  synced user blob — the one thing on this screen that is not a callback. */
  ctx: AppContext;
  /** The folder to file the new analysis in — null for the root. Decided by
   *  this component rather than read from the route: the route is written by a
   *  throttled effect, so it can still be a keystroke behind. */
  onStartLive: (source: LiveSourceKind, folderId: string | null) => void;
  onImportFile: (file: File, folderId: string | null) => void;
  /** "Import a link": the dialog that downloads a recording, then imports it. */
  onImportLink: (folderId: string | null) => void;
  onImportSession: () => void;
  /** `from`: the row left from, lit up on the way back (navOrigin.ts). */
  onOpenSession: (sessionId: string, from?: string) => void;
  /** Which folder is on screen: read from the route on every render, never
   *  copied into state. A PLACE since 2026-11-20 (S3, Aurélien: ‹ › did not
   *  climb back through the folders) — each is its own history entry, as a
   *  folder of decks is, so back and forward move the route under this
   *  component and it has to follow. */
  folder?: string;
  /** The search, from the route — so coming back to the screen restores the
   *  list that was running. Copied into state, and copied again when back or
   *  forward lands on another folder. */
  initialSearch?: string;
}

export function SessionLibrary({ ctx, onStartLive, onImportFile, onImportLink, onImportSession, onOpenSession, folder, initialSearch }: SessionLibraryProps) {
  const { sessions: allSessions, reload: reloadSessions } = useAnalysesList();
  const [query, setQuery] = useState(initialSearch ?? '');
  const [dragOver, setDragOver] = useState(false);
  /** Which folder the analyses list is showing; null is the root ("Home"). */
  const folderId = folder ?? null;

  // Back or forward onto another folder: the component stays mounted (appRoot
  // keys it on the page, not the folder — a remount would read the whole list
  // again and rerun the recovery pass at every step), so the search it copied
  // at mount is the PREVIOUS entry's. Re-read from the entry reached. A layout
  // effect, so the route-writing effect below never runs on a render that
  // pairs the new folder with the old folder's search. After this screen's own
  // navigation it changes nothing: that entry was built from this very state.
  const entry = navEntry.value;
  const seenEntry = useRef(entry);
  useLayoutEffect(() => {
    if (seenEntry.current === entry) return;
    seenEntry.current = entry;
    setQuery(initialSearch ?? '');
    // eslint-disable-next-line
  }, [entry]);

  /** A new history entry: another folder, or the detections. The entry being
   *  left gets its last keystroke written first — a trailing replaceRoute would
   *  otherwise land on the NEW entry (see replaceRouteNow). `from`: the row
   *  left from, lit up on the way back (navOrigin.ts). */
  const leaveFor = (next: (here: { search?: string; folder?: string }) => Parameters<typeof ctx.navigate>[0], from?: string) => {
    const here = routeSignal.peek();
    if (here.view !== 'sessions') return;
    replaceRouteNow(here);
    ctx.navigate(next(here), from);
  };
  // The search goes along up the breadcrumb, to widen it; a folder the search
  // found leaves it behind (AnalysisBrowser): that folder is where the user was
  // going.
  const openFolder = (id: string | null, keepSearch?: boolean, from?: string) => {
    if (id === folderId) return;
    leaveFor(here => ({ view: 'sessions', folder: id ?? undefined, search: keepSearch === false ? undefined : here.search }), from);
  };
  // Bare, like any page reached by a click in this app (the library from the
  // menu opens unfiltered); back is what returns to a state left behind
  // (2026-11-20, the user).
  const openDetections = () => leaveFor(() => ({ view: 'sessions', tab: 'tunes' }));

  useTuneNames();

  // The search lives in the route, like the card library's filters. Same
  // reasons: leaving for a session and coming back must not throw the search
  // away, and `replaceRoute` (not navigate) keeps typing out of the history —
  // it is throttled in store.ts precisely because this fires per keystroke.
  // Empty is written as absent rather than as '', so a route that carries no
  // search stays a bare `{view:'sessions'}`. The folder is copied through as
  // the route has it: it is changed by navigating, never here.
  useEffect(() => {
    replaceRoute({ view: 'sessions', search: query || undefined, folder });
    // eslint-disable-next-line
  }, [query]);

  /** Where a new analysis is filed: the folder on screen. */
  const destinationFolder = folderId;

  const q = query.trim().toLowerCase();

  return (
    <div
      class={dragOver ? 'bg-accent/5' : ''}
      onDragOver={(e) => { if (!isFileDrag(e)) return; e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer?.files[0];
        if (file && mayHoldAudio(file.type)) onImportFile(file, destinationFolder);
      }}
    >
      {/* The three ways in, one block for the walkthrough to light. */}
      <div data-tour="analyser-start">
      <RecordingSources
        onStartLive={(kind) => onStartLive(kind, destinationFolder)}
        onImportFile={(file) => onImportFile(file, destinationFolder)}
        onImportLink={() => onImportLink(destinationFolder)}
        pickerId="analysis-import"
      />

      <button class="btn-outline w-full justify-center flex items-center gap-2 mt-2" onClick={onImportSession}>
        <ImportTrayIcon size={14} />
        <span>{t('sessions.share.importSession')}</span>
      </button>
      </div>

      {/* The way to the detections: a fourth full-width button under the
          three ways in, with the long name (the user, 2026-11-20). It went
          beside the search first, then into the breadcrumb's row — both read
          as being about the open folder, which it is not. Outside the block
          above, which the walkthrough lights as "three ways to start". The
          library's icon, as they are a library of what was played. */}
      <button
        type="button"
        class="btn-outline w-full justify-center flex items-center gap-2 mt-2"
        data-tour="analyser-detections"
        onClick={openDetections}
      >
        <LibraryIcon size={14} />
        <span>{t('sessions.detectionsLibrary')}</span>
      </button>

      <AnalysisBrowser
        ctx={ctx}
        sessions={allSessions}
        query={q}
        folderId={folderId}
        onOpenFolder={openFolder}
        onOpenSession={onOpenSession}
        onSessionsChanged={reloadSessions}
        toolbar={(
          // Under the breadcrumb (2026-11-20, the user): the search runs in the
          // folder the breadcrumb names.
          <div class="mt-3 flex">
            <SearchField
              value={query}
              onInput={setQuery}
              // Folders are found too, where there are any: not on the
              // standalone page, which has no library and so no folders.
              placeholder={t(hasLibrary() ? 'sessions.searchWithFolders' : 'sessions.search')}
            />
          </div>
        )}
      />
    </div>
  );
}
