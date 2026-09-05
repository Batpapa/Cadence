import { useEffect, useState } from 'preact/hooks';
import { getContext } from '../store';
import { t } from '../services/i18nService';
import type { AppContext } from '../types';
import { loadSessionMeta } from '../session/db';
import type { RecordedSession } from '../session/model';
import { activeLive, activeImport } from '../session/ui/sessionStore';
import { SessionLibrary } from '../session/ui/SessionLibrary';
import { LiveSessionScreen } from '../session/ui/LiveSession';
import { ImportAnalysis } from '../session/ui/ImportAnalysis';
import { SessionSummary } from '../session/ui/SessionSummary';
import { startLiveSession, startImport, showImportSessionModal, startReanalyze, liveScreenActive, importScreenActive } from '../session/ui/sessionModule';

// ── Sessions page (the tune analyzer) ───────────────────────────────────────────
// Route `{ view: 'sessions' }` = past-sessions library, or whichever local
// screen (live recording / file import) is currently running — activeLive/
// activeImport are module-level signals (sessionStore.ts) read directly
// below, so this tree re-renders on its own as they change; nothing here
// imperatively triggers a screen switch.
// Route `{ view: 'sessions', sessionId }` = a particular session, rendered
// directly via <SessionSummary> — deliberately bypassing the live/import
// auto-redirect above so viewing session history doesn't get hijacked by an
// unrelated recording running in the background.


function SessionByIdScreen({ ctx, sessionId }: { ctx: AppContext; sessionId: string }) {
  const [session, setSession] = useState<RecordedSession | null>(null);

  // Keyed on sessionId alone (not e.g. a generation counter) is deliberate:
  // re-analyzing an existing session can navigate here again with the SAME
  // id once it's done — see finishImportRun's own doc on why that always
  // goes through a real navigate() via a different intermediate route
  // rather than landing on this exact id twice in a row.
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    void loadSessionMeta(sessionId).then(s => {
      if (cancelled) return;
      if (!s) { ctx.navigate({ view: 'sessions' }); return; }
      setSession(s);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [sessionId]);

  if (!session) return null;

  return (
    <SessionSummary
      session={session}
      ctx={ctx}
      onOpenCard={(cardId) => ctx.navigate({ view: 'card', cardId })}
      onReanalyze={() => { void startReanalyze(ctx, session); }}
    />
  );
}

export function SessionsView({ sessionId }: { sessionId?: string }) {
  const ctx = getContext();
  const onOpenCard = (cardId: string) => ctx.navigate({ view: 'card', cardId });

  // Read once, so the null check that narrows the type and the predicate that
  // decides the screen look at the very same object.
  const live = activeLive.value;
  const imp = activeImport.value;

  let content;
  if (sessionId) {
    content = <SessionByIdScreen ctx={ctx} sessionId={sessionId} />;
  } else if (live && liveScreenActive()) {
    content = <LiveSessionScreen live={live} ctx={ctx} onOpenCard={onOpenCard} />;
  } else if (imp && importScreenActive()) {
    content = <ImportAnalysis imp={imp} ctx={ctx} onOpenCard={onOpenCard} />;
  } else {
    content = (
      <>
        <h1 class="text-xl font-semibold text-primary mb-4">{t('sessions.moduleTitle')}</h1>
        <SessionLibrary
          onStartLive={startLiveSession}
          onImportFile={(file) => { void startImport(ctx, file); }}
          onImportSession={() => showImportSessionModal(ctx)}
          onOpenSession={(id) => ctx.navigate({ view: 'sessions', sessionId: id })}
        />
      </>
    );
  }

  return (
    <div class="h-full overflow-y-auto view-enter">
      <div class="p-6">{content}</div>
    </div>
  );
}
