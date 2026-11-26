import { useEffect, useState } from 'preact/hooks';
import { cardOfTuneId } from '../detections';
import type { Card } from '../../types';
import { primeCachedTuneNames, cachedTuneName, ensureTuneNameIndex } from '../../services/tuneNameIndexService';
import { titleCaseTuneName } from '../../services/tuneDisplayName';
import { getContext } from '../../store';

// Out of sessionUiShared.tsx since 2026-11-26.

// ── What a recognised tune is called ─────────────────────────────────────────
// A detection carries a TheSession tune id and a name from the recognition
// index — and that index holds its names ENTIRELY in lower case (0 capitals
// across its 46 867 aliases, measured on the real file), because matching
// ignores case. So "mcgoldrick's", where the same tune imported as a card
// reads "McGoldrick's".
//
// The id is the durable thing, so the name is looked UP from it, in the order
// of how much each source is worth (decided with the user, 2026-09-10):
//
//   1. The card, if one exists — it may have been renamed by hand, and then
//      it is the only name the user recognises as theirs.
//   2. TheSession's name index, if this device has it — the authoritative
//      spelling, offline, free.
//   3. Otherwise: start fetching that index, and re-case the recogniser's own
//      name in the meantime. Rules are tolerable here because nothing is
//      stored from them and they are corrected the moment the index lands.

/** Loads the cached name lookup, and fetches the index when this device has
 *  none. Re-renders its component at each step, so a name improves under the
 *  user rather than waiting for the next navigation.
 *
 *  Call it once per screen that shows detection names. */
export function useTuneNames(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    let alive = true;
    void primeCachedTuneNames().then(async (hasIndex) => {
      if (alive) bump(n => n + 1);
      if (hasIndex) return;
      // ~24 MB, once per device, and only for someone who has actually opened
      // a screen full of recognised tunes. Failure is silent on purpose: this
      // improves a label, it is not a feature anybody is waiting on.
      try { await ensureTuneNameIndex(); } catch { return; }
      if (alive) bump(n => n + 1);
    });
    return () => { alive = false; };
  }, []);
}

/** `text` is what to show; `exact` is true when it came from a card or from
 *  TheSession's index — false while it is still the re-cased guess, which is
 *  worth knowing for anything that would otherwise treat it as authoritative.
 *
 *  `cardOf` (see cardsByExternalTuneId): for a caller naming thousands of tunes
 *  in one render, which would otherwise search every card for each of them. */
export function tuneName(d: { tuneId: string; displayName: string }, cardOf?: (tuneId: string) => Card | undefined): { text: string; exact: boolean } {
  const card = cardOf ? cardOf(d.tuneId) : cardOfTuneId(d.tuneId, getContext().user.cards);
  if (card) return { text: card.name, exact: true };

  const indexed = cachedTuneName(d.tuneId);
  if (indexed) return { text: indexed, exact: true };

  return { text: titleCaseTuneName(d.displayName), exact: false };
}
