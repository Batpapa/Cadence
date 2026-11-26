import { appState, getContext } from '../store';
import { t } from '../services/i18nService';
import type { AppContext, Route } from '../types';
import { analysisWithDefaults } from '../session/db';
import { sessionsOf } from '../session/detections';
import { activeLive, activeImport } from '../session/ui/sessionStore';
import { SessionLibrary } from '../session/ui/SessionLibrary';
import { DetectionsLibrary } from '../session/ui/DetectionsLibrary';
import { LiveSessionScreen } from '../session/ui/LiveSession';
import { ImportAnalysis } from '../session/ui/ImportAnalysis';
import { SessionSummary } from '../session/ui/SessionSummary';
import { startLiveSession, startImport, startLinkImport, showImportSessionModal, showSessionSettingsModal, startReanalyze, liveScreenActive, importScreenActive } from '../session/ui/sessionModule';
import { LiveTempoBar } from '../session/ui/LiveTempo';
import { analysisTempo } from '../session/ui/analysisView';
import { GearIcon, WaveformIcon } from '../components/icons';
import { IconButton } from '../components/ui';

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


function SessionByIdScreen({ ctx, sessionId, annotationId }: { ctx: AppContext; sessionId: string; annotationId?: string }) {
  // Read off the state at every render (2026-11-26), so an edit — the
  // summary's own (mutateAnalysis), or one arriving from Drive — is on screen
  // as soon as it is committed. Until then the analysis was loaded once and
  // the summary edited that very object, the state's own, in place. Every way
  // here (a recording stopped, an import, a recovery) commits the finished
  // analysis before navigating, and an analysis still being recorded is never
  // shown here.
  const stored = sessionsOf(appState.value)[sessionId];

  // Said on the spot, as a deleted card is — never a redirect. Back lands
  // here after a deletion, and a navigate() from this point pushed a fresh
  // library entry on top of it: each back landed on the deleted analysis,
  // which pushed the library again, and nothing before it could be reached
  // any more (reported 2026-10-15).
  if (!stored) return <p class="text-sm text-dim">{t('sessions.notFound')}</p>;
  const session = analysisWithDefaults(stored);

  // Keyed on the id: the summary keeps a whole visit in its own state (the
  // recording loaded, the head), which belongs to one analysis. Re-analyzing
  // lands on the SAME id again — through a different route in between (see
  // finishImportRun), which remounts it all the same.
  return (
    <SessionSummary
      key={sessionId}
      session={session}
      ctx={ctx}
      annotationId={annotationId}
      onOpenCard={(cardId, from) => ctx.navigate({ view: 'card', cardId }, from)}
      onReanalyze={(audio) => { void startReanalyze(ctx, session, audio); }}
    />
  );
}

export function SessionsView(route: Extract<Route, { view: 'sessions' }>) {
  const { sessionId, annotationId, search, tab, folder } = route;
  const ctx = getContext();
  const onOpenCard = (cardId: string) => ctx.navigate({ view: 'card', cardId });

  // Read once, so the null check that narrows the type and the predicate that
  // decides the screen look at the very same object.
  const live = activeLive.value;
  const imp = activeImport.value;

  let content;
  if (sessionId) {
    content = <SessionByIdScreen ctx={ctx} sessionId={sessionId} annotationId={annotationId} />;
  } else if (live && liveScreenActive()) {
    content = <LiveSessionScreen live={live} ctx={ctx} onOpenCard={onOpenCard} />;
  } else if (imp && importScreenActive()) {
    content = <ImportAnalysis imp={imp} ctx={ctx} onOpenCard={onOpenCard} />;
  } else {
    // `tab: 'tunes'` is the detections, a page of their own since 2026-11-20
    // (DetectionsLibrary), with its own title — titled as the card library
    // is, and without the analyser's settings (the user, same day). The name
    // `tunes` stays, written in saved routes and in history entries.
    content = tab === 'tunes' ? <DetectionsLibrary ctx={ctx} route={route} /> : (
      <>
        <div class="flex items-center justify-between mb-4">
          {/* The module's own icon before its name, as Trending has it. */}
          <h1 class="text-xl font-semibold text-primary flex items-center gap-2">
            <WaveformIcon size={18} />
            {t('sessions.moduleTitle')}
          </h1>
          <div class="flex items-center gap-2">
            <IconButton
              label={t('sessions.settings.title')}
              variant="outline"
              class="hover:text-accent"
              data-tour="analyser-gear"
              onClick={showSessionSettingsModal}
            >
              <GearIcon size={14} />
            </IconButton>
          </div>
        </div>
        <SessionLibrary
          ctx={ctx}
          onStartLive={(kind, destination) => startLiveSession(ctx, kind, destination)}
          onImportFile={(file, destination) => { void startImport(ctx, file, destination); }}
          onImportLink={(destination) => startLinkImport(ctx, destination)}
          onImportSession={() => showImportSessionModal(ctx)}
          onOpenSession={(id, from) => ctx.navigate({ view: 'sessions', sessionId: id }, from)}
          initialSearch={search}
          folder={folder}
        />
      </>
    );
  }

  // The live tempo (the "BPM" switch, analysisView.ts): a line of its own at
  // the very bottom of the screen, however short the page (2026-11-01) —
  // after the page in a column, which the page fills, and sticky when the
  // page is longer. The page's own content keeps its block flow: only its box
  // is a flex item.
  const tempoBar = !sessionId && live && liveScreenActive() && analysisTempo.value ? live : null;
  return (
    <div class={`h-full overflow-y-auto view-enter ${tempoBar ? 'flex flex-col' : ''}`}>
      <div class={tempoBar ? 'p-6 flex-1' : 'p-6'}>{content}</div>
      {tempoBar && <LiveTempoBar live={tempoBar} />}
    </div>
  );
}
