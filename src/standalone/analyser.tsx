// FIRST: the page is one folder down from the bundles, the worker and the WASM.
import '../thesessionEmbed/publicPath';
import '../styles.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { setLanguage, tIn, type Lang } from '../services/i18nService';
import { welcomeLanguage, ensureCurrentUser, ensureCurrentProfile } from '../services/userService';
import { applyTheme } from '../services/themeService';
import { applyZoom } from '../services/zoomService';
import { initPWA } from '../services/pwaService';
import { emptyState } from '../utils';
import { openEphemeralUser, routeSignal, canGoBack, goBack, navigate, appState } from '../store';
import { sessionsOf } from '../session/detections';
import { runWithoutLibrary } from '../services/pageMode';
import { initSessionDbStandalone, deleteLocalSessionData, listSessions, loadSessionAudio, deleteSession } from '../session/db';
import { initAttachmentDbForUser, deleteLocalAttachmentData } from '../services/attachmentDb';
import { stageAnalyses } from '../services/standaloneHandoff';
import { sessionRecordingSignal } from '../session/ui/sessionStore';
import { ModalHost, alertModal } from '../components/modal';
import { closeTopOverlay } from '../components/overlayStack';
import { SessionsView } from '../views/sessions';
import { StandaloneShell } from './shell';

// ── TuneAnalyser/: the app's analyser, for using once (2026-10-26) ───────────
// The Tune analyser module itself, full page, for a user who lives in memory
// (store.ts's openEphemeralUser): nothing to sign in to, nothing kept — no
// library behind it (pageMode.ts), so no card to add or rate. The analyses
// go on to the app, into whatever user is opened there, through the "sign in
// to keep them" link at the foot of the page (handOver, below).
//
// Its recordings go where the analyser always puts them — the local database
// of this page's own user — and that is the safety net: a listening cut short
// by a crash is found again by the analyser's own recovery on the next visit.
// A page left normally marks it, and the next visit starts empty.

// At once, not in the async boot: the browser's install offer comes once per
// page, and is lost if nobody is listening yet (main.ts does the same).
initPWA();

const USER_ID = 'standalone-analyser';
/** The app, one folder up. */
const APP_URL = new URL('../', location.href).href;
const LEFT_NORMALLY = 'cadence_standalone_analyser_left';

async function boot(): Promise<void> {
  const lang = welcomeLanguage();
  setLanguage(lang);
  applyTheme();
  applyZoom();
  runWithoutLibrary();

  // The previous visit ended normally: what it recorded is not kept. After a
  // crash the flag is missing, and the analyser's recovery finds the draft.
  let leftNormally = false;
  try { leftNormally = localStorage.getItem(LEFT_NORMALLY) === '1'; localStorage.removeItem(LEFT_NORMALLY); } catch { /* no storage: nothing to keep either */ }
  if (leftNormally) {
    await deleteLocalSessionData(USER_ID);
    await deleteLocalAttachmentData(USER_ID);
  }
  addEventListener('pagehide', e => {
    if (!e.persisted) { try { localStorage.setItem(LEFT_NORMALLY, '1'); } catch { /* see above */ } }
  });

  const user = emptyState();
  user.id = USER_ID;
  user.name = 'Cadence';
  user.language = lang;
  ensureCurrentUser(user);
  ensureCurrentProfile(user);
  initSessionDbStandalone(USER_ID);
  initAttachmentDbForUser(USER_ID);
  openEphemeralUser(user, { view: 'sessions' });

  // Escape closes the topmost layer, as in the app (main.ts).
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && closeTopOverlay()) e.preventDefault();
  });

  render(<AnalyserPage />, document.getElementById('app')!);
}

/** "Sign in to keep them": the finished analyses, what they found and their
 *  sound, staged for the app (services/standaloneHandoff.ts), which takes
 *  them into whichever user is opened next. Then they leave this page — they
 *  are the app's now, and going back here must not offer them twice — and
 *  the app opens. A recording or an import still running would be lost by
 *  leaving: it has to finish first. */
async function handOver(lang: Lang, setHanding: (v: boolean) => void): Promise<void> {
  if (sessionRecordingSignal.value) {
    alertModal(tIn(lang, 'standalone.analyser.signIn'), tIn(lang, 'standalone.analyser.busy'));
    return;
  }
  setHanding(true);
  try {
    const sessions = await listSessions();
    if (sessions.length > 0) {
      await stageAnalyses(await Promise.all(sessions.map(async session => ({
        session,
        audio: (await loadSessionAudio(session.id)) ?? null,
      }))));
      for (const s of sessions) await deleteSession(s.id);
    }
    location.href = APP_URL;
  } catch (e) {
    setHanding(false);
    alertModal(tIn(lang, 'standalone.analyser.signIn'), e instanceof Error ? e.message : String(e));
  }
}

function AnalyserPage() {
  const [lang, setLang] = useState<Lang>(welcomeLanguage);
  // The module's strings are read through t(): it is mounted again in the
  // new language rather than told about it.
  const [key, setKey] = useState(0);
  const [handing, setHanding] = useState(false);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = `${tIn(lang, 'standalone.analyser.title')} — Cadence`;
  }, [lang]);

  // WelcomePrefs, in the header, has already switched the language.
  const onLanguageChange = () => {
    setLang(welcomeLanguage());
    setKey(k => k + 1);
  };

  // The analyser's own routes only: its library, an analysis. Nothing here
  // leads anywhere else — there are no cards to open.
  const route = routeSignal.value;
  const params = route.view === 'sessions' ? route : { view: 'sessions' as const };
  // Finished ones — through the user's signal, so the banner comes with the
  // first and goes when the last is deleted.
  const hasAnalyses = Object.keys(sessionsOf(appState.value)).length > 0;

  return (
    <StandaloneShell
      lang={lang}
      onLanguageChange={onLanguageChange}
      // An analysis open: back to the list of them — the history's own back
      // when there is one (the app's bridge, as the browser's button), the
      // list itself when the page was opened straight on the analysis.
      onBack={params.sessionId ? () => { if (canGoBack.value) goBack(); else navigate({ view: 'sessions' }); } : undefined}
      // Said on every screen, at the foot (2026-10-26): an analysis looks like
      // the app's, and nothing else tells that it goes with the page. Only
      // once there is one: before that, there is nothing to lose or to keep.
      notice={hasAnalyses && <>
        {tIn(lang, 'standalone.analyser.notSaved')}{' '}
        <a href={APP_URL} onClick={e => { e.preventDefault(); if (!handing) void handOver(lang, setHanding); }}>
          {tIn(lang, handing ? 'standalone.analyser.handingOver' : 'standalone.analyser.signIn')}
        </a>
      </>}
    >
      <SessionsView key={key} {...params} />
      <ModalHost />
    </StandaloneShell>
  );
}

void boot();
