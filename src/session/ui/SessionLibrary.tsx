import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { MicIcon, FileAudioIcon, ImportTrayIcon, DeviceAudioIcon, ChevronDownIcon } from '../../components/icons';
import { CustomSelect } from '../../components/customSelect';
import { listSessions } from '../db';
import { recoverOrphanedSessions } from '../recovery';
import { canCaptureDeviceAudio, type LiveSourceKind } from '../audio/sources';
import { activeLive } from './sessionStore';
import type { RecordedSession } from '../model';

// ── Screen: library ───────────────────────────────────────────────────────────
// Past sessions + entry points into a new live recording / file import. Pure
// presentational component: every action (start live, import a file, import
// a shared session, open a past one) is a callback prop, wired up by
// sessions.tsx from sessionModule.ts's orchestration functions. No
// sessionModule.ts import here, on purpose: keeps this a leaf presentational
// component (also avoids a circular import — sessionModule.ts doesn't need
// to know about this component at all any more).

function fmtLongTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function defaultSessionName(dateIso: string | null): string {
  return dateIso
    ? t('sessions.defaultName', { date: new Date(dateIso).toLocaleDateString() })
    : t('sessions.defaultNameNoDate');
}

interface SessionLibraryProps {
  onStartLive: (source: LiveSourceKind) => void;
  onImportFile: (file: File) => void;
  onImportSession: () => void;
  onOpenSession: (sessionId: string) => void;
}

export function SessionLibrary({ onStartLive, onImportFile, onImportSession, onOpenSession }: SessionLibraryProps) {
  const [allSessions, setAllSessions] = useState<RecordedSession[]>([]);
  const [query, setQuery] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [source, setSource] = useState<LiveSourceKind>('mic');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Hidden entirely where getDisplayMedia does not exist (iOS, Android) —
  // the button then looks exactly as it always did. Firefox and Safari desktop
  // DO have the API and silently return no audio track, which no feature test
  // can predict; that case is caught after the picker, as NoCapturedAudioError.
  const canPickSource = canCaptureDeviceAudio();
  const sourceOptions = [
    { value: 'mic', label: t('sessions.source.mic') },
    { value: 'device', label: t('sessions.source.device') },
  ];

  useEffect(() => {
    void recoverOrphanedSessions(activeLive.value?.sessionId).then(() => listSessions()).then(setAllSessions);
    // eslint-disable-next-line
  }, []);

  const q = query.trim().toLowerCase();
  const sessions = q
    ? allSessions.filter(s => (s.name || defaultSessionName(s.date)).toLowerCase().includes(q))
    : allSessions;

  return (
    <div
      class={dragOver ? 'bg-accent/5' : ''}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer?.files[0];
        if (file && (file.type.startsWith('audio/') || !file.type)) onImportFile(file);
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
              onClick={() => onStartLive(source)}
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
          if (file) onImportFile(file);
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

      <input
        type="text"
        class="input text-sm mt-3"
        placeholder={t('sessions.search')}
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />

      <div class="mt-4 space-y-2">
        {sessions.length === 0 ? (
          <p class="text-xs text-dim text-center py-4">{q ? t('sessions.noSearchResults') : t('sessions.empty')}</p>
        ) : (
          sessions.map(session => (
            <div
              key={session.id}
              class="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg hover:border-accent/50 transition-colors cursor-pointer"
              onClick={() => onOpenSession(session.id)}
            >
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-primary truncate flex items-center gap-1.5">
                  <span class="truncate">{session.name || defaultSessionName(session.date)}</span>
                  {session.source === 'import' && (
                    <span class="text-dim shrink-0 flex items-center" title={t('sessions.importBadge')}>
                      <FileAudioIcon size={11} />
                    </span>
                  )}
                </div>
                <div class="text-xs text-dim">
                  {session.date ? `${new Date(session.date).toLocaleDateString()} · ` : ''}
                  {fmtLongTime(session.duration)} · {t('sessions.tunesCount', { n: session.annotations.length })}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
