import { useLayoutEffect, useRef } from 'preact/hooks';
import { getContext } from '../store';
import { loadSessionMeta } from '../session/db';
import { renderSessionModule, renderSummary, type SessionModuleHost } from '../session/ui/sessionModule';

// ── Sessions page (the tune analyzer) ───────────────────────────────────────────
// Route `{ view: 'sessions' }` = past-sessions library (or whichever local
// screen — live/import — is currently running; see renderSessionModule).
// Route `{ view: 'sessions', sessionId }` = a particular session, rendered
// directly via renderSummary — deliberately bypassing the live/import
// auto-redirect so viewing session history doesn't get hijacked by an
// unrelated recording running in the background.

function buildSessionsPage(ctx: ReturnType<typeof getContext>, sessionId: string | undefined): { root: HTMLElement; cleanup: () => void } {
  const root = document.createElement('div');
  root.className = 'p-6';

  const header = document.createElement('div');
  const body = document.createElement('div');
  root.append(header, body);

  const cleanups: (() => void)[] = [];
  const host: SessionModuleHost = {
    header, body, ctx,
    closeModal: () => { /* no-op on a page — callers navigate() right after */ },
    registerCleanup: fn => cleanups.push(fn),
  };

  if (sessionId) {
    void loadSessionMeta(sessionId).then(session => {
      if (!session) { ctx.navigate({ view: 'sessions' }); return; }
      renderSummary(host, session);
    });
  } else {
    renderSessionModule(host);
  }

  return { root, cleanup: () => cleanups.forEach(fn => fn()) };
}

export function SessionsView({ sessionId }: { sessionId?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  // Built post-commit, not during render: sessionModule.ts's `iconElement()`
  // mounts icons via a synchronous Preact `render()` call — safe from an
  // effect, but corrupts hook state if run mid-render (see modules.tsx history).
  useLayoutEffect(() => {
    const { root, cleanup } = buildSessionsPage(getContext(), sessionId);
    ref.current!.replaceChildren(root);
    return cleanup;
  }, [sessionId]);

  return <div ref={ref} class="h-full overflow-y-auto view-enter" />;
}
