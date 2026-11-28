import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { appState, mutate, navigate, replaceRoute, replaceRouteNow, routeSignal, navEntry } from '../../store';
import { TranscribeIcon, GearIcon } from '../../components/icons';
import { IconButton } from '../../components/ui';
import { isDriveConnected } from '../../services/driveService';
import { showTranscriptionSettingsModal } from './settingsModal';
import { SearchField } from '../../components/searchField';
import { FolderBrowser, type FolderItem, type FolderSource } from '../../components/folderBrowser';
import { mayHoldAudio } from '../../services/audioSniff';
import { showLinkImportModal } from '../../session/ui/LinkImportModal';
import { RecordingSources } from '../../session/ui/recordingSources';
import { fmtTime } from '../../session/ui/sessionUiShared';
import { fmtDate } from '../../services/dateFormat';
import type { Route } from '../../types';
import { currentAbc, editTranscriptionTree, transcriptionTreeOf, transcriptionsOf, type TranscriptionRecord } from '../model';
import { deleteTranscriptions } from '../actions';
import { showRecordForTranscription } from './record';
import { startSetup } from './state';
import { SOURCE_ICON, sourceName } from './setup';

// ── The module's page ────────────────────────────────────────────────────────
// Laid out as the analyser's (views/sessions.tsx, SessionLibrary): its title,
// the ways in (recordingSources.tsx), then its folders and transcriptions in
// the analyser's folder browser (components/folderBrowser.tsx — "des dossiers
// comme pour l'analyse", the user, 2026-11-28), the search under the
// breadcrumb. A folder is a place, as the analyser's: each its own history
// entry; the search in the route (a place one was, which back returns to). A
// new transcription is filed in the folder on screen. A file dropped on the
// page is a file chosen.

/** A header field of an ABC text (its first): "M", "K"… */
export const abcHeader = (abc: string, field: string): string | undefined => new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(abc)?.[1]?.trim();

/** A row's second line: when, how long, the metre and key the score has now,
 *  corrected or not. */
function detailOf(r: TranscriptionRecord): string {
  const abc = currentAbc(r);
  // the user's date format (Settings), as everywhere else
  return [fmtDate(r.createdAt), fmtTime(r.to - r.from), abcHeader(abc, 'M'), abcHeader(abc, 'K'), r.abc !== undefined ? t('transcription.corrected') : undefined]
    .filter(Boolean).join(' · ');
}

export function TranscriptionLibrary({ initialSearch, folder }: { initialSearch?: string; folder?: string }) {
  const [query, setQuery] = useState(initialSearch ?? '');
  const [dragOver, setDragOver] = useState(false);
  /** Which folder is on screen; null is the root. Read from the route. */
  const folderId = folder ?? null;

  // Back or forward onto another folder: the search copied at mount is the
  // previous entry's — re-read from the entry reached (SessionLibrary's rule).
  const entry = navEntry.value;
  const seenEntry = useRef(entry);
  useLayoutEffect(() => {
    if (seenEntry.current === entry) return;
    seenEntry.current = entry;
    setQuery(initialSearch ?? '');
    // eslint-disable-next-line
  }, [entry]);

  // The search in the route, the folder copied through as it is.
  useEffect(() => {
    replaceRoute({ view: 'transcriptions', search: query || undefined, folder });
    // eslint-disable-next-line
  }, [query]);

  /** Another folder: a history entry of its own, the one left getting its
   *  last keystroke first (replaceRouteNow). The search goes along up the
   *  breadcrumb; a folder the search found leaves it behind. */
  const openFolder = (id: string | null, keepSearch?: boolean, from?: string) => {
    if (id === folderId) return;
    const here = routeSignal.peek();
    if (here.view !== 'transcriptions') return;
    replaceRouteNow(here);
    const next: Route = { view: 'transcriptions', folder: id ?? undefined, search: keepSearch === false ? undefined : here.search };
    navigate(next, from);
  };

  const all = transcriptionsOf(appState.value);
  const byId = new Map(all.map(r => [r.id, r]));
  const items: FolderItem[] = all.map(r => ({ id: r.id, name: r.name, date: new Date(r.createdAt).toISOString() }));
  const source: FolderSource = {
    tree: transcriptionTreeOf(appState.value),
    edit: (fn) => { void mutate(s => editTranscriptionTree(s, fn)); },
    deleteItems: (ids) => deleteTranscriptions(ids),
    icon: (id) => { const Icon = SOURCE_ICON[byId.get(id)!.source]; return <Icon size={12} />; },
    iconTitle: (id) => sourceName(byId.get(id)!.source),
    detail: (id) => detailOf(byId.get(id)!),
    key: 'transcription',
    count: (n) => t(n === 1 ? 'transcription.folder.count' : 'transcription.folder.countPlural', { n }),
    empty: t('transcription.empty'),
    noResults: t('transcription.noMatch'),
    tour: 'transcription-row',
  };

  return (
    <div
      class={dragOver ? 'bg-accent/5' : ''}
      onDragOver={(e) => { if (!e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file && mayHoldAudio(file.type)) void startSetup(file, file.name, 'file', folderId);
      }}
    >
      {/* The module's own icon before its name, and its gear, as the
          analyser has them — the gear with Drive only: the recordings and
          Drive are all it holds (settingsModal.tsx). */}
      <div class="flex items-center justify-between min-h-8 mb-4">
        <h1 class="text-xl font-semibold text-primary flex items-center gap-2">
          <TranscribeIcon size={18} />
          {t('transcription.moduleTitle')}
        </h1>
        {isDriveConnected() && (
          <IconButton
            label={t('transcription.settings.title')}
            variant="outline"
            class="hover:text-accent"
            data-tour="transcription-gear"
            onClick={showTranscriptionSettingsModal}
          >
            <GearIcon size={14} />
          </IconButton>
        )}
      </div>
      {/* The ways in, one block for the walkthrough to light. */}
      <div data-tour="transcription-start">
        <RecordingSources
          onStartLive={(kind) => showRecordForTranscription(kind, folderId)}
          onImportFile={(file) => void startSetup(file, file.name, 'file', folderId)}
          onImportLink={() => showLinkImportModal((file) => void startSetup(file, file.name, 'link', folderId))}
          pickerId="transcription"
        />
      </div>
      <FolderBrowser
        source={source}
        items={items}
        query={query.trim().toLowerCase()}
        folderId={folderId}
        onOpenFolder={openFolder}
        onOpenItem={(id, from) => navigate({ view: 'transcriptions', id }, from)}
        toolbar={(
          <div class="mt-3 flex">
            <SearchField value={query} onInput={setQuery} placeholder={t('transcription.search')} />
          </div>
        )}
      />
    </div>
  );
}
