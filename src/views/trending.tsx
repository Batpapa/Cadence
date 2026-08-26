import { TrendingModule } from '../trending/ui/trendingModule';
import { routeSignal } from '../store';

// ── Trending page (TheSession popularity explorer) ─────────────────────────────
// Restores the saved filter params (period/gain mode/threshold) from the
// route at mount — deliberately excludes the deck-picker target, which stays
// session-only. No key= needed: ContentSwitch (appRoot.tsx) already remounts
// this view fresh every time route.view switches to 'trending' (navigating
// away renders a different component type entirely), matching the old
// vanilla bridge's one-shot build-per-mount.

export function TrendingView() {
  const route = routeSignal.value;
  return (
    <div class="h-full overflow-y-auto view-enter">
      <TrendingModule initial={route.view === 'trending' ? route : undefined} />
    </div>
  );
}
