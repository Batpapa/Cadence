import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { MicIcon, FileAudioIcon, ImportTrayIcon, DeviceAudioIcon, ChevronDownIcon, ExternalLinkIcon } from '../../components/icons';
import { CustomSelect } from '../../components/customSelect';
import { Segmented } from '../../components/ui';
import { listSessions } from '../db';
import { recoverOrphanedSessions } from '../recovery';
import { showRecoveryFailures } from './RecoveryFailureModal';
import { showLiveBackupOffers } from './LiveBackupOfferModal';
import { sweepLiveBackups } from '../liveBackup';
import { canCaptureDeviceAudio, type LiveSourceKind } from '../audio/sources';
import { isNative } from '../../native/platform';
import { activeLive } from './sessionStore';
import { useTuneNames } from './sessionUiShared';
import { AnalysisBrowser } from './AnalysisBrowser';
import { TuneRankingPanel, tuneFilterCount, type TuneViewState } from './TuneRankingPanel';
import { FiltersButton, useFiltersPanel } from '../../components/filterSection';
import { SearchField } from '../../components/searchField';
import { TUNE_SORT_DEFAULT_ASC } from './tuneRanking';
import { replaceRoute, replaceRouteNow, routeSignal, navEntry } from '../../store';
import { mayHoldAudio } from '../../services/audioSniff';
import { hasLibrary } from '../../services/pageMode';
import { pickFiles } from '../../services/filePicker';
import type { AppContext, FilterState, Route, TuneSort } from '../../types';
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
  /** "Import a link": the dialog that downloads a recording, then imports it. */
  onImportLink: (folderId: string | null) => void;
  onImportSession: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Which tab and which folder are on screen: read from the route on every
   *  render, never copied into state. Both are PLACES since 2026-11-20 (S3,
   *  Aurélien: ‹ › did not climb back through the folders) — each is its own
   *  history entry, as a folder of decks is, so back and forward move the
   *  route under this component and it has to follow. */
  tab?: 'sessions' | 'tunes';
  folder?: string;
  /** What the rest of the screen starts as, from the route — so coming back to
   *  it restores the list that was running, exactly as the card library
   *  restores its filters. All optional: absent means the default. Copied into
   *  state, and copied again when back or forward lands on another entry. */
  initialSearch?: string;
  initialSort?: TuneSort;
  initialSortAsc?: boolean;
  initialOthers?: [string, FilterState][];
  initialOthersOr?: boolean;
  initialAnalyses?: [string, FilterState][];
  initialAnalysesOr?: boolean;
  initialDances?: [string, FilterState][];
  initialKinds?: [string, FilterState][];
  initialTags?: [string, FilterState][];
  initialTagsOr?: boolean;
  initialModes?: [string, FilterState][];
  initialDetectedFrom?: string;
  initialDetectedTo?: string;
  initialDecks?: [string, FilterState][];
  initialDecksOr?: boolean;
  initialCardTags?: [string, FilterState][];
  initialCardTagsOr?: boolean;
}

/** The tune list's settings as the route carries them. */
function tuneViewFromRoute(p: SessionLibraryProps): TuneViewState {
  return {
    sort: p.initialSort ?? 'alpha',
    sortAsc: p.initialSortAsc ?? TUNE_SORT_DEFAULT_ASC,
    analyses: new Map(p.initialAnalyses ?? []),
    analysesOr: p.initialAnalysesOr ?? true,
    others: new Map(p.initialOthers ?? []),
    othersOr: p.initialOthersOr ?? false,
    // A route saved while types and keys were two sections lands in Tags.
    tags: new Map(p.initialTags ?? [...(p.initialDances ?? []), ...(p.initialModes ?? [])]),
    tagsOr: p.initialTagsOr ?? false,
    kinds: new Map(p.initialKinds ?? []),
    detectedFrom: p.initialDetectedFrom ?? '',
    detectedTo: p.initialDetectedTo ?? '',
    decks: new Map(p.initialDecks ?? []),
    decksOr: p.initialDecksOr ?? false,
    cardTags: new Map(p.initialCardTags ?? []),
    cardTagsOr: p.initialCardTagsOr ?? false,
  };
}

export function SessionLibrary(props: SessionLibraryProps) {
  const { ctx, onStartLive, onImportFile, onImportLink, onImportSession, onOpenSession, tab: routeTab, folder } = props;
  const [allSessions, setAllSessions] = useState<Analysis[]>([]);
  /** Whether `allSessions` has been read at least once. The tunes tab waits for
   *  it: its chips ignore any analysis they cannot find, and before the first
   *  read that is every one of them — the sections would open collapsed, as if
   *  the route had carried no filter at all. */
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [query, setQuery] = useState(props.initialSearch ?? '');
  const [dragOver, setDragOver] = useState(false);
  /** Which way the same material is being read: by evening, or by tune. */
  const tab = routeTab ?? 'sessions';
  /** Which folder the analyses list is showing; null is the root ("Home"). */
  const folderId = folder ?? null;
  /** The tune list's own settings, held here rather than inside the panel so
   *  that ONE effect writes the route. Two writers would take turns erasing
   *  each other's fields, which is the whole failure mode this avoids. */
  const [tuneView, setTuneView] = useState<TuneViewState>(() => tuneViewFromRoute(props));

  // Back or forward onto another entry of this same screen (a folder, a tab):
  // the component stays mounted (appRoot keys it on the analysis alone), so
  // what it copied from the route at mount is the PREVIOUS entry's — the
  // search typed there, the chips set there. Re-read from the entry reached.
  // A layout effect, so the route-writing effect below never runs on a render
  // that pairs the new entry with the old entry's search. After one of this
  // screen's own navigations it changes nothing: that entry was built from
  // this very state.
  const entry = navEntry.value;
  const seenEntry = useRef(entry);
  useLayoutEffect(() => {
    if (seenEntry.current === entry) return;
    seenEntry.current = entry;
    setQuery(props.initialSearch ?? '');
    setTuneView(tuneViewFromRoute(props));
    // eslint-disable-next-line
  }, [entry]);

  /** A new history entry for another folder or tab, carrying the rest of the
   *  screen along — the search and the chips are the same visit, and the
   *  entry being left gets its last keystroke written first (a trailing
   *  replaceRoute would otherwise land on the NEW entry, see replaceRouteNow). */
  const go = (patch: (here: Extract<Route, { view: 'sessions' }>) => Partial<Extract<Route, { view: 'sessions' }>>) => {
    const here = routeSignal.peek();
    if (here.view !== 'sessions') return;
    replaceRouteNow(here);
    // The entry reached copies its search back into the box (the layout
    // effect above).
    ctx.navigate({ ...here, ...patch(here) });
  };
  // A folder the search found leaves the search behind (AnalysisBrowser):
  // that folder is where the user was going.
  const openFolder = (id: string | null, keepSearch?: boolean) => {
    if (id !== folderId) go(here => ({ folder: id ?? undefined, search: keepSearch === false ? undefined : here.search }));
  };
  // A tab opens BARE — the root, no search, no chips, the default order —
  // like any page reached by a click in this app (the library from the menu
  // opens unfiltered); back is what returns to a state left behind
  // (2026-11-20, the user: "le sauvegarder en entier, ou pas du tout", then
  // "nowhere else does the app keep the last state met"). Half of it used to
  // follow: the folder and the tunes' chips did, the search did not.
  const openTab = (next: 'sessions' | 'tunes') => {
    if (next === tab) return;
    const here = routeSignal.peek();
    if (here.view !== 'sessions') return;
    replaceRouteNow(here);
    ctx.navigate({ view: 'sessions', tab: next === 'sessions' ? undefined : next });
  };
  /** The tune list's funnel, beside the search box both tabs share — shown on
   *  the tunes tab only, the analyses having no filter sections. Held here with
   *  the view it clears (which a tab switch resets, see openTab). Counted
   *  before the first read too: the analyses chips then count for nothing,
   *  and the sections open once the read brings them in (useFiltersPanel). */
  const tuneFilters = tuneFilterCount(tuneView, allSessions, ctx.user);
  const filters = useFiltersPanel(tuneFilters, () => setTuneView(v => ({
    ...v, analyses: new Map(), tags: new Map(), others: new Map(), kinds: new Map(),
    detectedFrom: '', detectedTo: '', decks: new Map(), cardTags: new Map(),
  })), entry);
  const [source, setSource] = useState<LiveSourceKind>('mic');
  // Where an import comes from, chosen the same way and kept the same way:
  // for now, not as a preference (see the live source's split button below).
  const [importFrom, setImportFrom] = useState<'file' | 'link'>('file');
  useTuneNames();

  // Hidden entirely where getDisplayMedia does not exist (iOS, Android's
  // browsers; the Android app has its own capture, see canCaptureDeviceAudio) —
  // the button then looks exactly as it always did. Firefox and Safari desktop
  // DO have the API and silently return no audio track, which no feature test
  // can predict; that case is caught after the picker, as NoCapturedAudioError.
  const canPickSource = canCaptureDeviceAudio();
  const sourceOptions = [
    { value: 'mic', label: t('sessions.source.mic') },
    { value: 'device', label: t('sessions.source.device') },
  ];
  const importOptions = [
    { value: 'file', label: t('sessions.importFrom.file') },
    { value: 'link', label: t('sessions.importFrom.link') },
  ];

  // Deleting a folder deletes the recordings it holds, and that is the only
  // action on this screen that changes what EXISTS rather than how it is
  // arranged — so the list has to be re-read rather than re-derived.
  const reloadSessions = () => { void listSessions().then(setAllSessions); };

  useEffect(() => {
    // The list loads whatever recovery did. It used to wait on recovery
    // succeeding outright, so a single orphan that threw left the library empty
    // on every visit, silently (2026-09-17). Recordings that could not be
    // recovered are put in front of the user instead, once the list is up.
    void recoverOrphanedSessions(activeLive.value?.sessionId)
      .catch((err: unknown) => {
        console.error('[sessions] recovery pass failed', err);
        return [];
      })
      .then(async failures => {
        setAllSessions(await listSessions());
        setSessionsLoaded(true);
        // Then the Drive backups, once the local failures have all been
        // decided — a recording this device lost entirely only exists there.
        showRecoveryFailures(failures, reloadSessions, () => {
          void sweepLiveBackups(activeLive.value?.sessionId).then(offers => showLiveBackupOffers(offers, reloadSessions));
        });
      });
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
  // ordering, the chips. A default is written as ABSENT rather than as its
  // value, so a route that was never touched stays a bare `{view:'sessions'}`
  // instead of accumulating the defaults it already has. The tab and the folder
  // are copied through as the route has them: they are changed by navigating
  // (`go`), never here.
  useEffect(() => {
    replaceRoute({
      view: 'sessions',
      search: query || undefined,
      tab: routeTab,
      folder,
      sort: tuneView.sort === 'alpha' ? undefined : tuneView.sort,
      sortAsc: tuneView.sortAsc === TUNE_SORT_DEFAULT_ASC ? undefined : tuneView.sortAsc,
      others: tuneView.others.size > 0 ? [...tuneView.others] : undefined,
      othersOr: tuneView.othersOr || undefined,
      analyses: tuneView.analyses.size > 0 ? [...tuneView.analyses] : undefined,
      analysesOr: tuneView.analysesOr ? undefined : false,
      tags: tuneView.tags.size > 0 ? [...tuneView.tags] : undefined,
      tagsOr: tuneView.tagsOr || undefined,
      kinds: tuneView.kinds.size > 0 ? [...tuneView.kinds] : undefined,
      detectedFrom: tuneView.detectedFrom || undefined,
      detectedTo: tuneView.detectedTo || undefined,
      decks: tuneView.decks.size > 0 ? [...tuneView.decks] : undefined,
      decksOr: tuneView.decksOr || undefined,
      cardTags: tuneView.cardTags.size > 0 ? [...tuneView.cardTags] : undefined,
      cardTagsOr: tuneView.cardTagsOr || undefined,
    });
    // eslint-disable-next-line
  }, [query, tuneView]);

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
        if (file && mayHoldAudio(file.type)) onImportFile(file, destinationFolder);
      }}
    >
      {/* The three ways in, one block for the walkthrough to light. */}
      <div data-tour="analyser-start">
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
              title={source === 'device' ? t(isNative() ? 'sessions.source.device.hintApp' : 'sessions.source.device.hint') : undefined}
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
                <ChevronDownIcon size={12} />
              </button>
            )}
          </>
        )}
      />

      {/* The live button's split shape, on the import (2026-10-15, the user:
         "exactly like mic vs capture"): the main half imports from the source
         its icon shows, the chevron changes it. Offered everywhere, unlike the
         live source — a download works on every device. */}
      <div class="mt-2">
        <CustomSelect
          value={importFrom}
          options={importOptions}
          onChange={(v) => setImportFrom(v as 'file' | 'link')}
          renderTrigger={(_label, open, toggle) => (
            <>
              <button
                class="btn-outline w-full justify-center flex items-center gap-2"
                title={t(importFrom === 'link' ? 'sessions.importLinkHint' : 'sessions.importHint')}
                onClick={() => {
                  if (importFrom === 'link') onImportLink(destinationFolder);
                  // Back in the folder used last, where the browser can
                  // (filePicker.ts). No type filter: on iOS Safari one hides
                  // some m4a depending on where they came from. A fresh picker
                  // each time, so the same file can be picked again after an
                  // import that did not go well.
                  else void pickFiles({ id: 'analysis-import', startIn: 'music' })
                    .then(([file]) => { if (file) onImportFile(file, destinationFolder); });
                }}
              >
                {importFrom === 'link' ? <ExternalLinkIcon size={14} /> : <FileAudioIcon size={14} />}
                <span>{t(importFrom === 'link' ? 'sessions.importLink' : 'sessions.import')}</span>
              </button>
              {/* Over the right edge, for the reason the live button's says. */}
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-2.5 flex items-center rounded-r
                       border-l border-border text-dim hover:text-primary hover:bg-elevated transition-colors cursor-pointer"
                title={t('sessions.importFrom')}
                aria-label={t('sessions.importFrom')}
                aria-expanded={open}
                onClick={toggle}
              >
                <ChevronDownIcon size={12} />
              </button>
            </>
          )}
        />
      </div>

      <button class="btn-outline w-full justify-center flex items-center gap-2 mt-2" onClick={onImportSession}>
        <ImportTrayIcon size={14} />
        <span>{t('sessions.share.importSession')}</span>
      </button>
      </div>
      {/* Two readings of the same material, side by side: the evenings, and
          what was played across them. A tab rather than a second module —
          the ranking is derived from these sessions and means nothing without
          them. The search box below serves both. */}
      {/* The app's segmented control (Segmented), the ABC viewer's and the
          analysis views': a background pill holding the two choices, rather
          than two loose buttons. Same gesture everywhere, so the same look. */}
      <div class="mt-3 w-fit" data-tour="analyser-tabs">
        <Segmented
          value={tab}
          options={([['sessions', 'sessions.tab.sessions'], ['tunes', 'sessions.tab.tunes']] as const).map(([id, key]) => ({
            value: id, label: t(key), tour: `analyser-tab-${id}`,
          }))}
          onChange={openTab}
        />
      </div>


      {/* One box for both tabs, but not one search: on the tunes side it
          filters tune names, on this side analyses and folders, and each tab
          keeps its own (openTab swaps them). */}
      <div class="flex gap-2 mt-3">
        <SearchField
          value={query}
          onInput={setQuery}
          // Folders are found too, where there are any: not on the standalone
          // page, which has no library and so no folders (AnalysisBrowser).
          placeholder={t(tab === 'tunes' ? 'sessions.ranking.search' : hasLibrary() ? 'sessions.searchWithFolders' : 'sessions.search')}
        />
        {tab === 'tunes' && <FiltersButton shown={filters.shown} count={tuneFilters} onPress={filters.press} />}
      </div>

      {tab === 'tunes' && sessionsLoaded && <div class="mt-3"><TuneRankingPanel sessions={allSessions} query={q} view={tuneView} onView={(patch) => setTuneView(v => ({ ...v, ...patch }))} filtersShown={filters.shown} /></div>}

      {tab === 'sessions' && (
        <AnalysisBrowser
          ctx={ctx}
          sessions={allSessions}
          query={q}
          folderId={folderId}
          onOpenFolder={openFolder}
          onOpenSession={onOpenSession}
          onSessionsChanged={reloadSessions}
        />
      )}
    </div>
  );
}