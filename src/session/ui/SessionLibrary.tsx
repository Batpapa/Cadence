import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { MicIcon, FileAudioIcon, ImportTrayIcon, DeviceAudioIcon, ChevronDownIcon } from '../../components/icons';
import { CustomSelect } from '../../components/customSelect';
import { listSessions } from '../db';
import { recoverOrphanedSessions } from '../recovery';
import { canCaptureDeviceAudio, type LiveSourceKind } from '../audio/sources';
import { activeLive } from './sessionStore';
import { useTuneNames } from './sessionUiShared';
import { AnalysisBrowser } from './AnalysisBrowser';
import { TuneRankingPanel, type TuneViewState } from './TuneRankingPanel';
import { TUNE_SORT_DEFAULT_ASC } from './tuneRanking';
import { replaceRoute } from '../../store';
import type { AppContext, FilterState, TuneSort } from '../../types';
import type { Analysis } from '../model';

// ── Screen: library ───────────────────────────────────────────────────────────
// Past sessions + entry points into a new live recording / file import. Pure
// presentational component: every action (start live, import a file, import
// a shared session, open a past one) is a callback prop, wired up by
// sessions.tsx from sessionModule.ts's orchestration functions. No
// sessionModule.ts import here, on purpose: keeps this a leaf presentational
// component (also avoids a circular import — sessionModule.ts doesn't need
// to know about this component at all any more).


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
  onImportSession: () => void;
  onOpenSession: (sessionId: string) => void;
  /** What the screen starts as, from the route — so coming back to it restores
   *  the list that was running, exactly as the card library restores its
   *  filters. All optional: absent means the default. */
  initialSearch?: string;
  initialTab?: 'sessions' | 'tunes';
  initialFolder?: string;
  initialSort?: TuneSort;
  initialSortAsc?: boolean;
  initialOthers?: [string, FilterState][];
  initialOthersOr?: boolean;
  initialAnalyses?: [string, FilterState][];
  initialAnalysesOr?: boolean;
}

export function SessionLibrary({ ctx, onStartLive, onImportFile, onImportSession, onOpenSession, initialSearch, initialTab, initialFolder, initialSort, initialSortAsc, initialAnalyses, initialAnalysesOr, initialOthers, initialOthersOr }: SessionLibraryProps) {
  const [allSessions, setAllSessions] = useState<Analysis[]>([]);
  const [query, setQuery] = useState(initialSearch ?? '');
  const [dragOver, setDragOver] = useState(false);
  /** Which way the same material is being read: by evening, or by tune. */
  const [tab, setTab] = useState<'sessions' | 'tunes'>(initialTab ?? 'sessions');
  /** Which folder the analyses list is showing; null is the root ("Home").
   *  In the route like everything else here, so that opening an analysis and
   *  coming back lands in the folder you left rather than at the top. */
  const [folderId, setFolderId] = useState<string | null>(initialFolder ?? null);
  /** The tune list's own settings, held here rather than inside the panel so
   *  that ONE effect writes the route. Two writers would take turns erasing
   *  each other's fields, which is the whole failure mode this avoids. */
  const [tuneView, setTuneView] = useState<TuneViewState>(() => ({
    sort: initialSort ?? 'alpha',
    sortAsc: initialSortAsc ?? TUNE_SORT_DEFAULT_ASC,
    analyses: new Map(initialAnalyses ?? []),
    analysesOr: initialAnalysesOr ?? true,
    others: new Map(initialOthers ?? []),
    othersOr: initialOthersOr ?? false,
  }));
  const [source, setSource] = useState<LiveSourceKind>('mic');
  const fileInputRef = useRef<HTMLInputElement>(null);
  useTuneNames();

  // Hidden entirely where getDisplayMedia does not exist (iOS, Android) —
  // the button then looks exactly as it always did. Firefox and Safari desktop
  // DO have the API and silently return no audio track, which no feature test
  // can predict; that case is caught after the picker, as NoCapturedAudioError.
  const canPickSource = canCaptureDeviceAudio();
  const sourceOptions = [
    { value: 'mic', label: t('sessions.source.mic') },
    { value: 'device', label: t('sessions.source.device') },
  ];

  // Deleting a folder deletes the recordings it holds, and that is the only
  // action on this screen that changes what EXISTS rather than how it is
  // arranged — so the list has to be re-read rather than re-derived.
  const reloadSessions = () => { void listSessions().then(setAllSessions); };

  useEffect(() => {
    void recoverOrphanedSessions(activeLive.value?.sessionId).then(() => listSessions()).then(setAllSessions);
    // eslint-disable-next-line
  }, []);

  // The search lives in the route, like the card library's filters. Same
  // reasons: leaving for a session and coming back must not throw the search
  // away, and `replaceRoute` (not navigate) keeps typing out of the history —
  // it is throttled in store.ts precisely because this fires per keystroke.
  // Empty is written as absent rather than as '', so a route that carries no
  // search stays a route that carries no search.
  //
  // Everything that shapes the list travels with it, not just the search: the
  // tab, the ordering, the chips. A default is written as ABSENT rather than
  // as its value, so a route that was never touched stays a bare
  // `{view:'sessions'}` instead of accumulating the defaults it already has.
  useEffect(() => {
    replaceRoute({
      view: 'sessions',
      search: query || undefined,
      tab: tab === 'sessions' ? undefined : tab,
      folder: folderId ?? undefined,
      sort: tuneView.sort === 'alpha' ? undefined : tuneView.sort,
      sortAsc: tuneView.sortAsc === TUNE_SORT_DEFAULT_ASC ? undefined : tuneView.sortAsc,
      others: tuneView.others.size > 0 ? [...tuneView.others] : undefined,
      othersOr: tuneView.othersOr || undefined,
      analyses: tuneView.analyses.size > 0 ? [...tuneView.analyses] : undefined,
      analysesOr: tuneView.analysesOr ? undefined : false,
    });
  }, [query, tab, folderId, tuneView]);

  /** Where a new analysis is filed: the folder on screen — but only while the
   *  analyses tab is the one being looked at. The entry buttons sit ABOVE the
   *  tabs and work from the tunes side too, where "the open folder" is not
   *  something the user can see, and filing into it would be a surprise rather
   *  than a convenience. */
  const destinationFolder = tab === 'sessions' ? folderId : null;

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
        if (file && (file.type.startsWith('audio/') || !file.type)) onImportFile(file, destinationFolder);
      }}
    >
      {/* Split button: pressing it starts a session on the source shown by its
         own icon, and the chevron half changes that source. CustomSelect is
         driving it — its trigger is the WHOLE control, so its portaled panel
         lands under the full width rather than under the chevron, and it
         brings the outside-click, scroll-close and zoom handling with it.
         The choice lives in this component's state and nowhere else: which
         source to record from is a decision about right now, not a
         preference, exactly like the pinned decks. */}
      <CustomSelect
        value={source}
        options={sourceOptions}
        onChange={(v) => setSource(v as LiveSourceKind)}
        renderTrigger={(_label, open, toggle) => (
          <>
            <button
              class="btn-primary w-full justify-center flex items-center gap-2"
              // "Appareil" is short enough to fit the selector but vague on its
              // own — the tooltip says which sounds it actually covers.
              title={source === 'device' ? t('sessions.source.device.hint') : undefined}
              onClick={() => onStartLive(source, destinationFolder)}
            >
              {source === 'device' ? <DeviceAudioIcon size={14} /> : <MicIcon size={14} />}
              <span>{t('sessions.start')}</span>
            </button>
            {/* Laid OVER the button's right edge rather than beside it: as a
               flex sibling it took width off the main half, and the label was
               then centred in what was left instead of in the button. Absolute
               keeps the button one full-width box whose label sits dead centre,
               chevron or no chevron. It is a sibling, never a child — a button
               inside a button is invalid HTML — and it covers the button's own
               right padding, so it steals no room from the label.
               Positioned against CustomSelect's own `relative` root. */}
            {canPickSource && (
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-2.5 flex items-center rounded-r
                       border-l border-white/25 text-white hover:bg-black/10 transition-colors cursor-pointer"
                title={t('sessions.source')}
                aria-label={t('sessions.source')}
                aria-expanded={open}
                onClick={toggle}
              >
                <ChevronDownIcon size={10} />
              </button>
            )}
          </>
        )}
      />

      {/* No `accept` filter: on iOS Safari it's known to hide some m4a containers
         depending on provenance (iCloud/Messages/third-party apps) — the card
         attachment picker (attachmentList.tsx) has never had this filter either. */}
      <input
        ref={fileInputRef}
        type="file"
        class="hidden"
        onChange={() => {
          const input = fileInputRef.current;
          const file = input?.files?.[0];
          // Cleared straight away, or picking the SAME file again fires no
          // change event at all — the value has not changed — and the second
          // attempt does nothing, with nothing to say why. Which is exactly
          // what a user does after a first import that did not go their way.
          if (input) input.value = '';
          if (file) onImportFile(file, destinationFolder);
        }}
      />
      <button
        class="btn-ghost w-full justify-center flex items-center gap-2 mt-2 border border-border"
        title={t('sessions.importHint')}
        onClick={() => fileInputRef.current?.click()}
      >
        <FileAudioIcon size={13} />
        <span>{t('sessions.import')}</span>
      </button>

      <button class="btn-ghost w-full justify-center flex items-center gap-2 mt-2 border border-border" onClick={onImportSession}>
        <ImportTrayIcon size={13} />
        <span>{t('sessions.share.importSession')}</span>
      </button>
      {/* Two readings of the same material, side by side: the evenings, and
          what was played across them. A tab rather than a second module —
          the ranking is derived from these sessions and means nothing without
          them. The search box below serves both. */}
      {/* The ABC viewer's segmented control, to the class: a background pill
          holding the two choices, rather than two loose buttons. Same gesture
          in two places, so it should look like the same gesture. */}
      <div class="flex gap-1 p-1 mt-3 bg-bg rounded-lg w-fit">
        {([['sessions', 'sessions.tab.sessions'], ['tunes', 'sessions.tab.tunes']] as const).map(([id, key]) => (
          <button
            key={id}
            class={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
              tab === id ? 'bg-accent text-white' : 'text-muted hover:text-primary hover:bg-elevated'}`}
            onClick={() => setTab(id)}
          >
            {t(key)}
          </button>
        ))}
      </div>


      {/* Outside the tabs: one search box, whichever way the list is being
          read. On the tunes side it filters tune names, on this side session
          names — the same question either way, "where is the Kesh". */}
      <input
        type="text"
        class="input text-sm mt-3"
        placeholder={t(tab === 'tunes' ? 'sessions.ranking.search' : 'sessions.search')}
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />

      {tab === 'tunes' && <div class="mt-3"><TuneRankingPanel sessions={allSessions} query={q} view={tuneView} onView={(patch) => setTuneView(v => ({ ...v, ...patch }))} /></div>}

      {tab === 'sessions' && (
        <AnalysisBrowser
          ctx={ctx}
          sessions={allSessions}
          query={q}
          folderId={folderId}
          onOpenFolder={setFolderId}
          onOpenSession={onOpenSession}
          onSessionsChanged={reloadSessions}
        />
      )}
    </div>
  );
}