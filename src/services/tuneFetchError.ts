import { t } from './i18nService';

/** A batch fetch that aborted on one specific tune. Every batch import commits
 *  all-or-nothing — it fetches everything first and writes only once every
 *  phase has succeeded — so when one stops, the only thing the user can act on
 *  is *which* tune stopped it. A bare "fetch failed: 404" says nothing against
 *  a pasted list of fifty IDs, or a playlist of three hundred.
 *
 *  `ref` is the source-qualified externalId (`thesession:97`), not a bare
 *  number: an IrishTuneInfo batch can redirect part of itself through
 *  TheSession, and an AI-pasted package can mix both sources outright, so the
 *  number alone would be ambiguous exactly where it matters.
 *
 *  `tuneName` is only set when the batch already knew the name before
 *  fetching — a tunebook, playlist, or mapping listing carries names; a pasted
 *  list of IDs has nothing but the numbers. */
export class TuneFetchError extends Error {
  constructor(readonly ref: string, readonly tuneName: string | undefined, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TuneFetchError';
  }
}

/** HTTP 451 — TheSession answers this for a tune that is not publicly
 *  available for legal reasons (e.g. thesession:5175). It is a standing
 *  verdict on that one tune, not a failure of the batch around it: retrying
 *  never helps, and aborting a fifty-tune import over one blocked tune helps
 *  nobody. Batch paths therefore skip these and report them at the end,
 *  instead of stopping. */
export class TuneUnavailableError extends Error {
  constructor(readonly ref: string) {
    super(`${ref} is unavailable for legal reasons (451)`);
    this.name = 'TuneUnavailableError';
  }
}

/** A tune a batch went past without importing. */
export interface SkippedTune {
  id: number;
  name?: string;
}

/** "Cooley's (1)", or just "1" when the batch never learned the name. */
export function describeTune(tune: SkippedTune): string {
  return tune.name ? `${tune.name} (${tune.id})` : String(tune.id);
}

/** Runs `fetch`, labelling any failure with the tune it happened on. An
 *  already-labelled failure passes through untouched: the innermost fetch is
 *  the one that knows which tune it was actually on. */
export async function withTuneIdentity<T>(ref: string, name: string | undefined, fetch: () => Promise<T>): Promise<T> {
  try {
    return await fetch();
  } catch (e) {
    // A 451 is a verdict on the tune, not an anonymous failure: it must reach
    // the batch loop intact so that loop can decide to skip rather than abort.
    if (e instanceof TuneFetchError || e instanceof TuneUnavailableError) throw e;
    throw new TuneFetchError(ref, name, e);
  }
}

/** Status line for a failed import: names the tune when the failure was on one
 *  specific tune, otherwise the plain message under `fallbackKey` — a tunebook
 *  pagination error, a cold scraper, a network drop before the first fetch. */
export function tuneFetchStatus(e: unknown, fallbackKey: string): string {
  if (e instanceof TuneUnavailableError) return t('common.tuneUnavailable', { ref: e.ref });
  if (e instanceof TuneFetchError) {
    return t(e.tuneName ? 'common.tuneFetchErrorNamed' : 'common.tuneFetchError', {
      name: e.tuneName ?? '',
      ref: e.ref,
      message: e.message,
    });
  }
  return t(fallbackKey, { message: e instanceof Error ? e.message : String(e) });
}
