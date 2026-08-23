import { useLayoutEffect, useRef } from 'preact/hooks';
import { getContext } from '../store';
import { renderTrendingList, type TrendingModuleHost } from '../trending/ui/trendingModule';

// ── Trending page (TheSession popularity explorer) ─────────────────────────────
// Same routed-page / vanilla-DOM bridge as views/sessions.tsx.

function buildTrendingPage(ctx: ReturnType<typeof getContext>): HTMLElement {
  const root = document.createElement('div');
  root.className = 'p-6';

  const header = document.createElement('div');
  const body = document.createElement('div');
  root.append(header, body);

  const host: TrendingModuleHost = {
    header, body, ctx,
    closeModal: () => { /* no-op on a page */ },
    registerCleanup: () => { /* nothing to clean up: no live audio/session state here */ },
  };

  // Restore the saved filter params (period/gain mode/threshold) from the
  // route — deliberately excludes the deck-picker target, which stays session-only.
  const route = ctx.route;
  renderTrendingList(host, route.view === 'trending' ? route : undefined);

  return root;
}

export function TrendingView() {
  const ref = useRef<HTMLDivElement>(null);

  // Built post-commit, not during render — iconElement() mounts icons via a
  // synchronous Preact render() call, unsafe mid-render (see sessions.tsx / modules.tsx history).
  useLayoutEffect(() => {
    const root = buildTrendingPage(getContext());
    ref.current!.replaceChildren(root);
  }, []);

  return <div ref={ref} class="h-full overflow-y-auto view-enter" />;
}
