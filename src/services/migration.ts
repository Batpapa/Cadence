import type { AppState, Card, User } from '../types';
import { ensureCurrentUser, ensureCurrentProfile } from './userService';
import { migrateClipTags } from './attachmentNames';
import { migrateAudioMimeTypes } from './audioSniff';
import { t } from './i18nService';
import { stripSourceTag } from './cardSourceService';
import { groupImportTags } from './tagGroups';

export const SCHEMA_VERSION = 10;

/** A state with nothing in it yet, at the schema version this build writes —
 *  out of utils.ts since 2026-11-26, beside the version it is written at. */
export function emptyState(): AppState {
  return {
    id: '',
    name: 'Default',
    language: 'en',
    availabilityThreshold: 0.9,
    weightByImportance: true,
    forgettingRate: 1,
    profileIds: [],
    currentProfileId: '',
    profiles: {},
    cards: {},
    decks: {},
    cardWorks: {},
    folders: {},
    rootFolderIds: [],
    rootDeckIds: [],
    schemaVersion: SCHEMA_VERSION,
  };
}

/** The oldest version still migrated. V0 → V1 (a no-op), V1 → V2 (files/embeds
 *  into attachments, 2026-04-20), V2 → V3 (profiles, 2026-04-20), V3 → V4
 *  (TheSession tag casing, 2026-05-14), V4 → V5 (card guids, 2026-06-12) and
 *  V5 → V6 (importance renamed, 2026-07-02) went on 2026-11-26 — not by the
 *  rule below, which would have kept them, but because Cadence had two users
 *  before July 2026, both known and long past them. The multi-user AppState of
 *  before 2026-06-01 stopped at v4, so it is refused by its version too.
 *
 *  The steps left STAY, with no deadline (the user's rule, 2026-11-26): they
 *  convert data that sleeps for as long as it likes — a device put away, a
 *  backup on a disk, a Drive nobody opened — at the border, once, and cost
 *  nothing elsewhere. What goes after six months is the rest of the old-format
 *  support: compatibility with old clients and fallbacks spread through the
 *  app (legacyDeadlines.test.ts).
 *
 *  A state below it is REFUSED, never read: run through the later steps as if
 *  it were current it would come out corrupted — cards with no guid, an
 *  importance under its old name, and older still, attachments under
 *  `files`/`embeds` and reviews keyed by user rather than profile. The
 *  refusal throws before anything is written, so the data stays as it was; an
 *  import says why, a boot falls to the recovery screen. The welcome screen's
 *  Drive recovery and the conflict modal's "use Drive" do not catch it — no
 *  such data exists to reach them (see above).
 *
 *  importExport.ts's `migrateRawCards` keeps its own copies of the card steps:
 *  a .cdc written by hand or by an AI carries no version at all and is read as
 *  v0, a format kept for good. */
export const OLDEST_SCHEMA = 6;

/** V6 → V7's rule, shared with importExport.ts's `migrateRawCards` so a card
 *  arriving through a .cdc package is stamped exactly like one already in the
 *  library. Two migration paths exist (whole state vs. bare cards) and this is
 *  the only thing keeping them from drifting.
 *
 *  Deliberately conservative: an external id from a tune source is proof, so
 *  it stamps. A hand-made tune card has no such proof and stays untyped — the
 *  user types it from the card page, or in bulk from the library's ⋯ menu.
 *  Never overwrites an existing type. */
export function stampTuneType(card: Record<string, unknown>): void {
  if (typeof card['type'] === 'string' && card['type']) return;
  const externalId = card['externalId'];
  if (typeof externalId !== 'string') return;
  if (externalId.startsWith('thesession:') || externalId.startsWith('irishtuneinfo:')) {
    card['type'] = 'tune';
  }
}

/** V9 → V10's rule, shared with importExport.ts's `migrateRawCards` like
 *  stampTuneType: the tag naming a card's own source goes (its externalId
 *  carries it alone since 2026-11-09), and the type and key an import wrote
 *  flat ("reel", "Aminor") move into their groups. Both only on a card from a
 *  tune source, and only in the importers' exact formats (cardSourceService,
 *  tagGroups) — a user's own tag is never touched. */
export function settleImportTags(card: Record<string, unknown>): void {
  stripSourceTag(card as unknown as Card);
  groupImportTags(card as unknown as Card);
}

// Keyed by the version each step migrates FROM, to the next: OLDEST_SCHEMA up
// to SCHEMA_VERSION - 1, none missing (migration.test.ts checks it).
// `Record<string, unknown>` handles partially-typed legacy shapes.
const migrations: Record<number, (s: Record<string, unknown>) => void> = {
  // V6 → V7: stamp `type: 'tune'` on cards imported from a tune source, so a
  //          library built before card types existed can populate a tuneset.
  //          Writes one optional field; moves and deletes nothing.
  6: (s) => {
    const cards = s['cards'] as Record<string, Record<string, unknown>>;
    for (const card of Object.values(cards ?? {})) stampTuneType(card);
  },
  // V7 → V8: a clip's "already attached" tag moves out of its file name into
  //          `clipOf`, so names can be renamed freely and read cleanly.
  7: (s) => {
    const cards = s['cards'] as Record<string, Record<string, unknown>>;
    for (const card of Object.values(cards ?? {})) migrateClipTags(card);
  },
  // V8 → V9: attachments the browser typed from their extension get the type
  //          their CONTENT proves — a hand-attached `.webm` recording was
  //          stored as video/webm and so opened in a bare <video> element
  //          rather than the custom player. Reads a head per candidate file,
  //          rewrites one string, and touches nothing it cannot prove.
  8: (s) => {
    const cards = s['cards'] as Record<string, Record<string, unknown>>;
    for (const card of Object.values(cards ?? {})) migrateAudioMimeTypes(card);
  },
  // V9 → V10: the tags imports wrote until 2026-11-09 — the source's name, and
  //           type and key flat — settled once, at the border (2026-11-26).
  //           stateNormalise.ts still does it on every commit for the cards a
  //           bundle from before 2026-11-09 may still write; this is what stays
  //           once that has gone.
  9: (s) => {
    const cards = s['cards'] as Record<string, Record<string, unknown>>;
    for (const card of Object.values(cards ?? {})) settleImportTags(card);
  },
};

/** The steps, for migration.test.ts to check that none is missing. */
export const MIGRATION_STEPS: readonly number[] = Object.keys(migrations).map(Number);

/**
 * Runs all pending migrations on `state` in place, then stamps schemaVersion.
 * Safe to call on IndexedDB data, Drive data, and imported JSON files.
 */
export function migrateState(user: AppState): void {
  const from = user.schemaVersion ?? 0;
  // A state written by a LATER build is not this one's to relabel.
  //
  // The loop below already does nothing for it — there is no migration to run
  // forwards — but the line after it used to stamp SCHEMA_VERSION over the
  // number unconditionally. So a v10 state opened on a v9 device came out
  // labelled v9 and was pushed to Drive saying so, and the device that DOES
  // understand v10 would then read it as v9 and run the v9 → v10 migration a
  // second time, over data already migrated. Depending on the migration that
  // ranges from harmless to destructive.
  //
  // Leaving the number alone keeps the truth in the blob. Nothing else
  // changes: this build goes on reading what it can, which for a purely
  // additive change is everything — verified for the attachment
  // externalisation, whose fields survive a full round trip through the
  // previous build untouched.
  if (from > SCHEMA_VERSION) {
    console.warn(`[migration] this state comes from a later build (v${from} > v${SCHEMA_VERSION}) — reading it as it is, and leaving its version alone`);
    return;
  }
  // Too old to be read any more: refused before anything is touched (see
  // OLDEST_SCHEMA). A missing version is v0 — every state written since
  // versions exist carries one.
  if (from < OLDEST_SCHEMA) {
    throw new Error(t('migration.tooOld', { from, oldest: OLDEST_SCHEMA }));
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    migrations[v]?.(user as unknown as Record<string, unknown>);
  }
  user.schemaVersion = SCHEMA_VERSION;
}

/**
 * Applies external data (Drive or file import) onto the current user.
 * Always preserves the current user's id.
 */
export function applyExternalData(raw: Record<string, unknown>, currentId: string): User {
  // A state too old is refused here (migrateState, OLDEST_SCHEMA) — the
  // multi-user AppState of before 2026-06-01 included, which stopped at v4.
  migrateState(raw as unknown as AppState);
  const user = raw as unknown as User;
  const result = { ...user, id: currentId };
  ensureCurrentUser(result);
  ensureCurrentProfile(result);
  return result;
}

