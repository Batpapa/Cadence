// ── The user's own cards as a second recognition index ───────────────────────
// Next to TheSession's index (indexStore.ts), the tunes of the user's cards: each
// version of each ABC of a card of type `tune` — attached, kept out of the
// state, or linked (cardIndexSource.ts) — becomes one setting,
// its contour made exactly as FolkFriend's index builder makes TheSession's
// (abcContour.ts). The two are merged when a recognition starts (ffWorker.ts),
// each setting tagged with the index it comes from (`source`: "cards" here,
// "thesession" for TheSession's), and the user's order of the indexes decides a
// tie — the cards' first by default (set_source_order, recognitionIndexes.ts).
//
// Ids, which detections store (2026-11-15, the user's call):
//   - a card that IS a TheSession tune (`externalId` "thesession:N") adds its
//     versions to tune N — detections keep pointing at N, so everything that
//     links N to the card (rating, "open the card", thesession.org) carries on;
//   - any other tune card is a tune of its own, "card:<guid>" — the guid, not the
//     id, since a detection travels to the user's other devices through Drive;
//   - a version is "card:<guid>:<hash of its ABC>": an attachment has no stable
//     id (a list position moves), and the text names the version for good. An
//     ABC edited since gives a new id; the old one then resolves to the card's
//     score as it is now (cardSettingAbc in cardIndexSource.ts).
//
// Kept up to date by difference rather than rebuilt: contours are cached by the
// hash of their ABC (KV_CARD_CONTOURS), so a recognition only converts the
// versions added or edited since the last one, and drops the ones gone. A
// content key rather than a `lastModified` on cards: nothing has to remember to
// stamp a card on every path that edits it, and a card edited by a device on an
// older version, which would not stamp it, is caught all the same.
//
// Worker side only here (no DOM, no app state): the cards come in the init
// message, gathered by cardIndexSource.ts.

export const CARD_ID_PREFIX = 'card:';

/** One version of a card's tune, as the page reads it off the ABC. */
export interface CardIndexVersion {
  /** The tune's ABC, one `X:` block, as it is in the file. */
  abc: string;
  /** "6/8" — as the index writes meters. */
  meter: string;
  /** "Dmajor", "Edorian" — as the index writes modes (TheSession's spelling). */
  mode: string;
  /** "reel", "jig"… or empty. */
  dance: string;
}

export interface CardIndexTune {
  guid: string;
  /** The TheSession tune this card is, when it is one: its versions join that
   *  tune. Null: the card is a tune of its own, `card:<guid>`. */
  theSessionTuneId: string | null;
  name: string;
  versions: CardIndexVersion[];
}

/** The index's setting, as indexStore.ts's IndexSetting (ABC left out: matching
 *  reads the contour only, the page finds the ABC on the card). */
interface CardSetting { tune_id: string; meter: string; mode: string; abc: string; dance: string; contour: string; source: 'cards' }

export const cardTuneId = (guid: string) => `${CARD_ID_PREFIX}${guid}`;
export const cardSettingId = (guid: string, hash: string) => `${CARD_ID_PREFIX}${guid}:${hash}`;
/** The setting id of a tune named by hand from a card (ManualTunePick): no
 *  version in it, so it always shows the card's score as it is. The same string
 *  as the card's tune id — told apart by the field it sits in. */
export const cardScoreSettingId = (guid: string) => `${CARD_ID_PREFIX}${guid}`;

/** Whether a tune or setting id is one of a card's. */
export const isCardId = (id: string) => id.startsWith(CARD_ID_PREFIX);

/** The card guid in a card tune or setting id ("card:<guid>" or
 *  "card:<guid>:<hash>"), null for any other id. */
export function cardGuidOf(id: string): string | null {
  if (!isCardId(id)) return null;
  const rest = id.slice(CARD_ID_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(0, colon);
}

/** The hash part of a card setting id, null for a tune id or any other id. */
export function cardVersionHashOf(settingId: string): string | null {
  if (!isCardId(settingId)) return null;
  const rest = settingId.slice(CARD_ID_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? null : rest.slice(colon + 1);
}

/** A version's name: 53 bits of cyrb53 over its ABC, base 36 — collisions are
 *  out of reach for a few thousand versions, and the same text always gives
 *  the same id on every device. */
export function abcVersionHash(abc: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < abc.length; i++) {
    const c = abc.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The cards' index: one setting per version abc2midi makes notes of, and a
 *  name for each card tune. `contours` is the cache as it should now be kept:
 *  the versions still on the cards, whether converted now or before.
 *  `contourOf` converts one ABC (abcContour), null when it gives nothing. */
export function buildCardIndex(
  tunes: CardIndexTune[],
  cached: Record<string, string>,
  contourOf: (abc: string) => string | null,
): { settings: Record<string, CardSetting>; aliases: Record<string, string[]>; contours: Record<string, string> } {
  const settings: Record<string, CardSetting> = {};
  const aliases: Record<string, string[]> = {};
  const contours: Record<string, string> = {};
  for (const tune of tunes) {
    const tuneId = tune.theSessionTuneId ?? cardTuneId(tune.guid);
    let any = false;
    for (const v of tune.versions) {
      const hash = abcVersionHash(v.abc);
      // An empty string is cached too: abc2midi made nothing of it last time,
      // and will not this time either.
      const contour = hash in cached ? cached[hash]! : (contourOf(v.abc) ?? '');
      contours[hash] = contour;
      if (!contour) continue;
      settings[cardSettingId(tune.guid, hash)] = { tune_id: tuneId, meter: v.meter, mode: v.mode, abc: '', dance: v.dance, contour, source: 'cards' };
      any = true;
    }
    // Lower case, as the index holds every name (Detection.displayName). The
    // engine reads a tune's name off `aliases` and stops dead without one —
    // given to a TheSession tune too, in case it is newer than the index.
    if (any) aliases[tuneId] = [tune.name.toLowerCase()];
  }
  return { settings, aliases, contours };
}
