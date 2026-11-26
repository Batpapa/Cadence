import { useEffect, useState } from 'preact/hooks';
import { t } from '../../services/i18nService';
import { useTuneNames } from './tuneNames';
import { TuneRankingPanel, tuneFilterCount, type TuneViewState } from './TuneRankingPanel';
import { FiltersButton, useFiltersPanel } from '../../components/filterSection';
import { SearchField } from '../../components/searchField';
import { FitText } from '../../components/fitText';
import { TUNE_SORT_DEFAULT_ASC } from './tuneRanking';
import { replaceRoute } from '../../store';
import { useAnalysesList } from './useAnalysesList';
import type { AppContext, Route } from '../../types';

// ── Screen: the detections ───────────────────────────────────────────────────
// Every tune and set recognised, across all the analyses. A page of its own
// since 2026-11-20 — the second tab of the analyses screen before (the user:
// "fundamentally two different pages"), reached now by the "Détections"
// button beside the analyses' search. Its route is still the analyser's with
// `tab: 'tunes'`, so routes saved and history written before still land here.
//
// Remounted on each arrival (appRoot keys it apart from the analyses), like
// the card library: what the route carries is read once, at mount, and a
// click that brings the user here brings them to a bare page — back is what
// returns to a state left behind.

type DetectionsRoute = Extract<Route, { view: 'sessions' }>;

/** The tune list's settings as the route carries them. */
function tuneViewFromRoute(r: DetectionsRoute): TuneViewState {
  return {
    sort: r.sort ?? 'alpha',
    sortAsc: r.sortAsc ?? TUNE_SORT_DEFAULT_ASC,
    analyses: new Map(r.analyses ?? []),
    analysesOr: r.analysesOr ?? true,
    others: new Map(r.others ?? []),
    othersOr: r.othersOr ?? false,
    // A route saved while types and keys were two sections lands in Tags.
    tags: new Map(r.tags ?? [...(r.dances ?? []), ...(r.modes ?? [])]),
    tagsOr: r.tagsOr ?? false,
    kinds: new Map(r.kinds ?? []),
    detectedFrom: r.detectedFrom ?? '',
    detectedTo: r.detectedTo ?? '',
    decks: new Map(r.decks ?? []),
    decksOr: r.decksOr ?? false,
    cardTags: new Map(r.cardTags ?? []),
    cardTagsOr: r.cardTagsOr ?? false,
    open: r.open ?? null,
  };
}

export function DetectionsLibrary({ ctx, route }: { ctx: AppContext; route: DetectionsRoute }) {
  const { sessions, loaded } = useAnalysesList();
  const [query, setQuery] = useState(route.search ?? '');
  /** The list's own settings, held here rather than inside the panel so that
   *  ONE effect writes the route. Two writers would take turns erasing each
   *  other's fields, which is the whole failure mode this avoids. */
  const [view, setView] = useState<TuneViewState>(() => tuneViewFromRoute(route));
  /** The funnel beside the search box. Counted before the first read too: the
   *  analyses chips then count for nothing, and the sections open once the
   *  read brings them in (useFiltersPanel). */
  const filterCount = tuneFilterCount(view, sessions, ctx.user);
  const filters = useFiltersPanel(filterCount, () => setView(v => ({
    ...v, analyses: new Map(), tags: new Map(), others: new Map(), kinds: new Map(),
    detectedFrom: '', detectedTo: '', decks: new Map(), cardTags: new Map(),
  })));
  useTuneNames();

  // Everything that shapes the list lives in the route, like the card
  // library's filters: leaving for a card and coming back must land on the
  // list that was running. `replaceRoute`, not navigate, keeps typing out of
  // the history (throttled in store.ts, since this fires per keystroke). A
  // default is written as ABSENT rather than as its value, so a route that was
  // never touched stays bare instead of accumulating the defaults it has.
  useEffect(() => {
    replaceRoute({
      view: 'sessions',
      tab: 'tunes',
      search: query || undefined,
      sort: view.sort === 'alpha' ? undefined : view.sort,
      sortAsc: view.sortAsc === TUNE_SORT_DEFAULT_ASC ? undefined : view.sortAsc,
      others: view.others.size > 0 ? [...view.others] : undefined,
      othersOr: view.othersOr || undefined,
      analyses: view.analyses.size > 0 ? [...view.analyses] : undefined,
      analysesOr: view.analysesOr ? undefined : false,
      tags: view.tags.size > 0 ? [...view.tags] : undefined,
      tagsOr: view.tagsOr || undefined,
      kinds: view.kinds.size > 0 ? [...view.kinds] : undefined,
      detectedFrom: view.detectedFrom || undefined,
      detectedTo: view.detectedTo || undefined,
      decks: view.decks.size > 0 ? [...view.decks] : undefined,
      decksOr: view.decksOr || undefined,
      cardTags: view.cardTags.size > 0 ? [...view.cardTags] : undefined,
      cardTagsOr: view.cardTagsOr || undefined,
      open: view.open ?? undefined,
    });
  }, [query, view]);

  /** Every detection of a tune, across every analysis and whatever the filters
   *  — what the rows' own counts add up to (rankDetectedTunes counts the
   *  same). The card library's subtitle counts all its cards the same way. */
  const total = sessions.reduce((n, s) => n + (s.annotations ?? []).filter(a => a.tuneId).length, 0);

  return (
    <div>
      {/* Titled as the card library is: its name, no icon, the total below
          (the user, 2026-11-20). No settings: those are the analyser's. The
          count waits for the read rather than showing a passing "0". */}
      <div class="mb-4">
        <h1 class="text-xl font-semibold text-primary"><FitText long={t('sessions.detectionsLibrary')} short={t('sessions.detections')} /></h1>
        <p class="text-xs text-muted mt-0.5">
          {loaded ? t(total !== 1 ? 'sessions.detectionCountPlural' : 'sessions.detectionCount', { count: total }) : ' '}
        </p>
      </div>
      <div class="flex gap-2">
        <SearchField value={query} onInput={setQuery} placeholder={t('sessions.ranking.search')} />
        <FiltersButton shown={filters.shown} count={filterCount} onPress={filters.press} />
      </div>
      {loaded && (
        <div class="mt-3">
          <TuneRankingPanel
            sessions={sessions}
            query={query.trim().toLowerCase()}
            view={view}
            onView={(patch) => setView(v => ({ ...v, ...patch }))}
            filtersShown={filters.shown}
          />
        </div>
      )}
    </div>
  );
}
