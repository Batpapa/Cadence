import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { MicIcon, FileAudioIcon, ImportTrayIcon } from '../../components/icons';
import { listSessions } from '../db';
import { recoverOrphanedSessions } from '../recovery';
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
  onStartLive: () => void;
  onImportFile: (file: File) => void;
  onImportSession: () => void;
  onOpenSession: (sessionId: string) => void;
}

export function SessionLibrary({ onStartLive, onImportFile, onImportSession, onOpenSession }: SessionLibraryProps) {
  const [allSessions, setAllSessions] = useState<RecordedSession[]>([]);
  const [query, setQuery] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      <button class="btn-primary w-full justify-center flex items-center gap-2" onClick={onStartLive}>
        <MicIcon size={14} />
        <span>{t('sessions.start')}</span>
      </button>

      {/* No `accept` filter: on iOS Safari it's known to hide some m4a containers
         depending on provenance (iCloud/Messages/third-party apps) — the card
         attachment picker (attachmentList.ts) has never had this filter either. */}
      <input
        ref={fileInputRef}
        type="file"
        class="hidden"
        onChange={() => {
          const file = fileInputRef.current?.files?.[0];
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
