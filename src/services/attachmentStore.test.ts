import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  attachmentThresholdBytes, isAboveThreshold, isExternal, DEFAULT_THRESHOLD_KB,
  inlineExternalAttachments, externalAttachmentBlobs, externalAttachmentBytes,
  restoreExternalAttachments, conversionPlan, applyConversion, freeableAttachments,
  sweepLocalAttachments, purgeCondemnedFiles,
} from './attachmentStore';
import type { AppState, Attachment, Card, ResolvableFile } from '../types';

// The local database stands in as a plain Map, so the export half of the module
// can be exercised without IndexedDB — what is being pinned down here is which
// bytes end up where, not the storage underneath.
const held = vi.hoisted(() => new Map<string, Blob>());
/** A foothold inside the async work, so a test can change the world at a
 *  moment it chooses rather than hoping to land between two awaits. */
const hooks = vi.hoisted(() => ({ onPut: null as null | (() => void | Promise<void>) }));
vi.mock('./attachmentDb', () => ({
  getAttachmentBlob: (id: string) => Promise.resolve(held.get(id) ?? null),
  // The hook's own promise is awaited, so a test can run a whole pass — a
  // sweep, say — at a moment the real code is genuinely in the middle of.
  putAttachmentBlob: (id: string, blob: Blob) => { held.set(id, blob); return Promise.resolve(hooks.onPut?.()); },
  deleteAttachmentBlob: (id: string) => { held.delete(id); return Promise.resolve(); },
  heldAttachmentIds: () => Promise.resolve([...held.keys()]),
  condemnDriveFile: () => Promise.resolve(),
  condemnedFiles: () => Promise.resolve([...graveyard.values()]),
  forgetCondemned: (driveFileId: string) => { graveyard.delete(driveFileId); return Promise.resolve(); },
}));
/** The journal of Drive files waiting to be deleted, keyed like the real one. */
const graveyard = vi.hoisted(() => new Map<string, { driveFileId: string; attachmentId: string; at: number }>());

// Drive and the running state, likewise: the conversion is a rule, and a rule
// is worth testing without a network or a browser.
const drive = vi.hoisted(() => ({ connected: false, unreachable: false, downloads: 0, deleted: [] as string[] }));
vi.mock('./driveService', () => ({
  isDriveConnected: () => drive.connected,
  hasDriveToken: () => true,
  downloadCompanionFile: () => {
    drive.downloads++;
    // Rejecting is what an unreachable Drive (or a dead token) does; a null
    // is the narrower 'the file is gone'.
    return drive.unreachable ? Promise.reject(new Error('auth_failed')) : Promise.resolve(null);
  },
  companionPathId: () => Promise.resolve('folder-id'),
  uploadCompanionFileInto: () => Promise.resolve('drive-new'),
  deleteCompanionFile: (id: string) => { drive.deleted.push(id); return Promise.resolve(true); },
  registerDrivePendingWork: () => {},
}));

const store = vi.hoisted(() => ({ state: null as unknown as AppState }));
vi.mock('../store', () => ({
  appState: { get value() { return store.state; } },
  mutate: (fn: (s: AppState) => void) => { fn(store.state); return Promise.resolve(); },
}));

// The resolving half of this module needs IndexedDB and is exercised in the
// browser; what is worth pinning down here is the RULE — the half that decides
// whether a file's bytes belong in the synced blob, since getting it wrong is
// what would either bloat the state again or quietly externalise a 3 KB score.

const file = (over: Partial<ResolvableFile> = {}): ResolvableFile =>
  ({ name: 'x.abc', mimeType: 'text/plain', data: '', ...over });

describe('the threshold', () => {
  it('defaults to 50 KB when the user has set nothing', () => {
    expect(attachmentThresholdBytes({})).toBe(50 * 1024);
    expect(DEFAULT_THRESHOLD_KB).toBe(50);
  });

  it('honours a value the user chose', () => {
    expect(attachmentThresholdBytes({ attachmentThresholdKb: 200 })).toBe(200 * 1024);
  });

  it('takes zero literally: keep nothing in the blob', () => {
    // A real answer, not a slip. Every reader waits for bytes that are
    // elsewhere, so "all of it outside" is a choice someone may legitimately
    // make — including for the scores, which then arrive a moment later.
    expect(attachmentThresholdBytes({ attachmentThresholdKb: 0 })).toBe(0);
    expect(isAboveThreshold(1, { attachmentThresholdKb: 0 })).toBe(true);
    expect(isAboveThreshold(3_600, { attachmentThresholdKb: 0 })).toBe(true);
  });

  it('never sends out a file with no bytes, zero threshold included', () => {
    // `0 >= 0` is true, and that alone externalised every EMPTY attachment as
    // soon as someone chose "keep nothing in the blob" — one 0-byte Drive
    // file per set, since a set's score is stored as an empty placeholder and
    // rebuilt at display time. There is nothing to externalise about no bytes.
    expect(isAboveThreshold(0, { attachmentThresholdKb: 0 })).toBe(false);
    expect(isAboveThreshold(0, {})).toBe(false);
    expect(isAboveThreshold(1, { attachmentThresholdKb: 0 })).toBe(true);
  });

  it('still refuses what is not a size at all', () => {
    expect(attachmentThresholdBytes({ attachmentThresholdKb: -1 })).toBe(50 * 1024);
    expect(attachmentThresholdBytes({ attachmentThresholdKb: NaN })).toBe(50 * 1024);
  });
});

describe('what the rule keeps in the blob', () => {
  it('leaves a typical ABC where it is', () => {
    // Real figures from the measured library: median attachment 3.6 KB,
    // largest score 30 KB.
    expect(isAboveThreshold(3_600, {})).toBe(false);
    expect(isAboveThreshold(30_000, {})).toBe(false);
  });

  it('takes the audio out', () => {
    // Smallest clip measured in that same library: 1.22 MB.
    expect(isAboveThreshold(1_280_000, {})).toBe(true);
    expect(isAboveThreshold(6_900_000, {})).toBe(true);
  });

  it('splits the measured library exactly where the analysis said it would', () => {
    // The population is bimodal: every threshold from 64 KB to 1 MB picked the
    // same ten files. A regression here would mean the rule stopped being the
    // insensitive one the default rests on.
    const sizes = [3_600, 8_600, 17_300, 30_000, 1_220_000, 2_480_000, 6_900_000];
    for (const kb of [64, 128, 256, 512, 1024]) {
      const out = sizes.filter(b => isAboveThreshold(b, { attachmentThresholdKb: kb }));
      expect(out).toEqual([1_220_000, 2_480_000, 6_900_000]);
    }
  });

  it('is inclusive at the boundary, so the threshold is a size that DOES move', () => {
    expect(isAboveThreshold(50 * 1024, {})).toBe(true);
    expect(isAboveThreshold(50 * 1024 - 1, {})).toBe(false);
  });
});

describe('isExternal', () => {
  it('reads the field and nothing else — there is no mode to disagree with', () => {
    expect(isExternal(file())).toBe(false);
    expect(isExternal(file({ data: 'AAAA' }))).toBe(false);
    expect(isExternal(file({ external: { id: 'a', bytes: 10 } }))).toBe(true);
  });

  it('counts a file awaiting upload as external — its bytes are still not in the blob', () => {
    // driveFileId absent is the upload backlog, not a reason to read `data`:
    // `data` is empty, and reading it would show an empty file.
    expect(isExternal(file({ external: { id: 'a', bytes: 10 } }))).toBe(true);
    expect(isExternal(file({ external: { id: 'a', bytes: 10, driveFileId: 'd' } }))).toBe(true);
  });
});

// ── Phase 3: what an export has to put back ─────────────────────────────────

const ext = (id: string, over: Partial<Attachment> = {}): Attachment =>
  ({ type: 'file', name: `${id}.mp3`, mimeType: 'audio/mpeg', data: '',
    external: { id, bytes: 3, driveFileId: 'drive-' + id }, ...over }) as Attachment;

const card = (name: string, attachments: Attachment[]): Card =>
  ({ id: name, guid: name, name, defaultImportance: 1, tags: [],
    content: { notes: '', attachments } }) as unknown as Card;

const threeBytes = () => new Blob([new Uint8Array([1, 2, 3])]);   // base64: AQID

beforeEach(() => { held.clear(); });

describe('inlining for an export', () => {
  it('puts the bytes back and removes every trace of the externalisation', async () => {
    held.set('e1', threeBytes());
    const cards = [card('Cooley', [ext('e1')])];

    expect(await inlineExternalAttachments(cards)).toEqual([]);
    // No `external` left: what leaves the app is a card in the shape every
    // build has always read, including the ones that predate all of this.
    expect(cards[0]!.content.attachments[0]).toEqual({
      type: 'file', name: 'e1.mp3', mimeType: 'audio/mpeg', data: 'AQID',
    });
  });

  it('reports what it could not fetch instead of writing an empty file', async () => {
    // No local bytes and no driveFileId: another device attached it and has
    // not sent it up. Nothing to fetch, and `data` must stay empty rather
    // than quietly exporting a zero-byte attachment under the right name.
    const orphan = ext('e2', { external: { id: 'e2', bytes: 3 } } as Partial<Attachment>);
    const cards = [card('Cooley', [orphan])];

    expect(await inlineExternalAttachments(cards)).toEqual([
      { card: 'Cooley', name: 'e2.mp3', reason: 'not-uploaded' },
    ]);
    expect(cards[0]!.content.attachments[0]).toEqual(orphan);
  });

  it('leaves an ordinary inline attachment completely alone', async () => {
    const cards = [card('Cooley', [{ type: 'file', name: 'x.abc', mimeType: 'text/plain', data: 'QUJD' }])];
    expect(await inlineExternalAttachments(cards)).toEqual([]);
    expect(cards[0]!.content.attachments[0]).toEqual({ type: 'file', name: 'x.abc', mimeType: 'text/plain', data: 'QUJD' });
  });
});

describe('collecting the bytes for a .cdbf', () => {
  it('yields one entry per set of bytes, not one per reference', async () => {
    held.set('e1', threeBytes());
    const cards = [card('Cooley', [ext('e1')]), card('Silver Spear', [ext('e1')])];

    const { blobs, missing } = await externalAttachmentBlobs(cards);
    expect([...blobs.keys()]).toEqual(['e1']);
    expect(missing).toEqual([]);
  });

  it('names the card, because a file name alone does not say where to look', async () => {
    const cards = [card('Silver Spear', [ext('e3', { external: { id: 'e3', bytes: 3 } } as Partial<Attachment>)])];
    const { missing } = await externalAttachmentBlobs(cards);
    expect(missing).toEqual([{ card: 'Silver Spear', name: 'e3.mp3', reason: 'not-uploaded' }]);
  });

  it('comes back through a restore', async () => {
    const { ok, failed } = await restoreExternalAttachments(new Map([['e9', threeBytes()]]));
    expect({ ok, failed }).toEqual({ ok: 1, failed: 0 });
    expect(held.has('e9')).toBe(true);
  });
});

describe('what the externalised bytes weigh', () => {
  it('adds up what no other figure counts', () => {
    const state = { cards: {
      a: card('Cooley', [ext('e1'), { type: 'file', name: 'x.abc', mimeType: 'text/plain', data: 'QUJD' }]),
      b: card('Silver Spear', [ext('e2')]),
    } } as unknown as AppState;
    // Only the externalised ones: the inline attachment is already inside the
    // state's own size, and counting it here would double it.
    expect(externalAttachmentBytes(state)).toBe(6);
  });

  it('is zero for a library that has never externalised anything', () => {
    expect(externalAttachmentBytes({ cards: {} } as unknown as AppState)).toBe(0);
  });
});

// ── Phase 4: applying the rule to a library already built ───────────────────

/** 60 000 bytes once decoded — above the 50 KB default, below 64 KB. */
const bigInline = (name = 'big.mp3'): Attachment =>
  ({ type: 'file', name, mimeType: 'audio/mpeg', data: 'A'.repeat(80_000) }) as Attachment;

const smallExternal = (id: string): Attachment =>
  ({ type: 'file', name: id + '.abc', mimeType: 'text/plain', data: '',
    external: { id, bytes: 3, driveFileId: 'drive-' + id } }) as Attachment;

const stateWith = (attachments: Attachment[], thresholdKb?: number): AppState =>
  ({ attachmentThresholdKb: thresholdKb, cards: { c1: card('Cooley', attachments) } }) as unknown as AppState;

describe('the conversion plan', () => {
  it('sends the big ones out and brings the small ones back, in one pass', async () => {
    drive.connected = true;
    const plan = await conversionPlan(stateWith([bigInline(), smallExternal('e1')]));
    expect(plan.out).toEqual({ count: 1, bytes: 60_000 });
    expect(plan.back).toEqual({ count: 1, bytes: 3 });
  });

  it('leaves alone what is already where it belongs', async () => {
    drive.connected = true;
    const big = { type: 'file', name: 'b.mp3', mimeType: 'audio/mpeg', data: '',
      external: { id: 'e2', bytes: 900_000, driveFileId: 'd2' } } as Attachment;
    const small = { type: 'file', name: 's.abc', mimeType: 'text/plain', data: 'QUJD' } as Attachment;
    const plan = await conversionPlan(stateWith([big, small]));
    expect(plan).toEqual({ out: { count: 0, bytes: 0 }, back: { count: 0, bytes: 0 } });
  });

  it('brings everything home when Drive is not connected', async () => {
    // Out of the blob without Drive, an attachment is one copy on one device —
    // exactly what the rule's Drive condition exists to prevent. So with no
    // Drive, nothing leaves and everything that already did wants to return.
    drive.connected = false;
    const plan = await conversionPlan(stateWith([bigInline(), smallExternal('e1')]));
    expect(plan.out.count).toBe(0);
    expect(plan.back.count).toBe(1);
  });

  it('follows the threshold the user chose', async () => {
    drive.connected = true;
    const plan = await conversionPlan(stateWith([bigInline()], 100));
    expect(plan.out.count).toBe(0);   // 60 000 bytes is below 100 KB now
  });

  it('plans nothing for a set score, even at a threshold of zero', async () => {
    // A set's fused score is stored as an EMPTY placeholder and rebuilt from
    // the member tunes at display time. At a threshold of zero it used to
    // qualify — nothing is not less than nothing — so "apply" uploaded a
    // 0-byte Drive file per set, for ever, and counted them as conversions.
    drive.connected = true;
    const placeholder = { type: 'file', name: 'tuneset.abc', mimeType: 'text/vnd.abc',
      data: '', generatedBy: 'tuneset' } as Attachment;
    const plan = await conversionPlan(stateWith([placeholder], 0));
    expect(plan).toEqual({ out: { count: 0, bytes: 0 }, back: { count: 0, bytes: 0 } });
  });
});

describe('applying it', () => {
  beforeEach(() => { held.clear(); hooks.onPut = null; });

  it('moves the bytes out and empties the attachment', async () => {
    drive.connected = true;
    store.state = stateWith([bigInline()]);
    const r = await applyConversion();
    expect({ out: r.out, back: r.back, failed: r.failed }).toEqual({ out: 1, back: 0, failed: 0 });
    const att = store.state.cards['c1']!.content.attachments[0] as { data: string; external?: { id: string } };
    expect(att.data).toBe('');
    expect(att.external).toBeTruthy();
    expect(held.has(att.external!.id)).toBe(true);
  });

  it('brings the bytes back in and drops the reference', async () => {
    drive.connected = true;
    held.set('e1', new Blob([new Uint8Array([1, 2, 3])]));
    store.state = stateWith([smallExternal('e1')]);
    const r = await applyConversion();
    expect({ out: r.out, back: r.back, failed: r.failed }).toEqual({ out: 0, back: 1, failed: 0 });
    expect(store.state.cards['c1']!.content.attachments[0]).toEqual({
      type: 'file', name: 'e1.abc', mimeType: 'text/plain', data: 'AQID',
    });
  });

  it('counts a file it cannot fetch rather than emptying the attachment', async () => {
    drive.connected = true;
    // No local bytes, and Drive answers nothing — the reference must survive.
    store.state = stateWith([smallExternal('gone')]);
    const r = await applyConversion();
    expect(r.failed).toBe(1);
    expect(r.back).toBe(0);
    const att = store.state.cards['c1']!.content.attachments[0] as { external?: unknown };
    expect(att.external).toBeTruthy();
  });

  it('refuses to write into an attachment that moved while it worked', async () => {
    drive.connected = true;
    store.state = stateWith([bigInline('before.mp3')]);
    // Edited mid-flight — after the change was planned, before it is applied:
    // same position, a different file. Converting a library can take minutes
    // when files have to come down from Drive, so this is not a contrived race.
    hooks.onPut = () => { store.state.cards['c1']!.content.attachments[0] = bigInline('after.mp3'); };
    await applyConversion();
    // Untouched: the anchor no longer matches, so the change is dropped
    // rather than applied to a stranger.
    const att = store.state.cards['c1']!.content.attachments[0] as { name: string; data: string };
    expect(att.name).toBe('after.mp3');
    expect(att.data).not.toBe('');
  });
});

describe('what can be freed locally', () => {
  beforeEach(() => { held.clear(); });

  it('offers only what Drive is proven to hold', async () => {
    held.set('e1', new Blob([new Uint8Array([1, 2, 3])]));
    held.set('e2', new Blob([new Uint8Array([1, 2, 3])]));
    const uploaded = smallExternal('e1');
    // Never uploaded: these bytes exist here and nowhere else in the world.
    const notYet = { type: 'file', name: 'n.abc', mimeType: 'text/plain', data: '',
      external: { id: 'e2', bytes: 3 } } as Attachment;
    const { ids, bytes } = await freeableAttachments(stateWith([uploaded, notYet]));
    expect(ids).toEqual(['e1']);
    expect(bytes).toBe(3);
  });

  it('offers nothing it does not actually hold', async () => {
    const { ids } = await freeableAttachments(stateWith([smallExternal('e1')]));
    expect(ids).toEqual([]);
  });
});

// ── The window between writing the bytes and naming them ────────────────────
// Every externalisation is two steps, and between them the bytes are
// referenced by nothing — which is exactly what the sweep deletes.

/** This device's snapshots, as the strict reader returns them. `broken` is a
 *  snapshot store that cannot be read. */
const snaps = vi.hoisted(() => ({ states: [] as unknown[], broken: false }));
vi.mock('./snapshotService', () => ({
  snapshotStates: () => (snaps.broken ? Promise.reject(new Error('idb gone')) : Promise.resolve(snaps.states)),
}));

describe('the local sweep, while a conversion is in flight', () => {
  beforeEach(() => { held.clear(); hooks.onPut = null; });

  it('spares bytes written but not yet named by the state', async () => {
    drive.connected = true;
    store.state = stateWith([bigInline()]);
    // Landing the sweep at the one moment the bug needed: the blob is on the
    // device, `applyConversion` has not reached its mutate, so the state still
    // describes an ordinary inline attachment and nothing at all points at
    // these bytes. Reachable for real through the eight-second boot sweep, and
    // through the storage panel recounting because anything else mutated.
    let sweptAt: number | null = null;
    hooks.onPut = async () => {
      hooks.onPut = null;                       // once, not on the way back
      sweptAt = await sweepLocalAttachments();
    };
    await applyConversion();

    expect(sweptAt).toBe(0);
    const att = store.state.cards['c1']!.content.attachments[0] as { data: string; external?: { id: string } };
    expect(att.external).toBeTruthy();
    // The attachment is now empty AND points outside the blob. If the sweep
    // had taken these bytes, the file would be gone for good, silently.
    expect(att.data).toBe('');
    expect(held.has(att.external!.id)).toBe(true);
  });

  it('still collects bytes nothing points at once the state has moved on', async () => {
    drive.connected = true;
    held.set('orphan', new Blob([new Uint8Array([9])]));
    store.state = stateWith([]);
    expect(await sweepLocalAttachments()).toBe(1);
    expect(held.has('orphan')).toBe(false);
  });
});

// ── What a snapshot keeps alive ─────────────────────────────────────────────
// A snapshot holds a state, not bytes. Restoring one that names an attachment
// deleted since only works if the bytes are still somewhere — here, or on
// Drive. The hole closed on 2026-09-29: free an attachment's local bytes,
// delete it, and the purge used to delete its only remaining copy.

describe('what a snapshot keeps alive', () => {
  const condemn = (attachmentId: string, driveFileId = 'drive-' + attachmentId) =>
    graveyard.set(driveFileId, { driveFileId, attachmentId, at: 0 });

  beforeEach(() => {
    held.clear(); graveyard.clear();
    drive.connected = true; drive.deleted = [];
    snaps.states = []; snaps.broken = false;
    store.state = stateWith([]);
  });

  it('keeps the local bytes of a deleted attachment a snapshot names', async () => {
    held.set('e1', new Blob([new Uint8Array([1])]));
    snaps.states = [stateWith([smallExternal('e1')])];
    expect(await sweepLocalAttachments()).toBe(0);
    expect(held.has('e1')).toBe(true);
  });

  it('sweeps nothing when the snapshots cannot be read', async () => {
    // The lenient readers answered a failure with an empty list, so this used
    // to read as "no snapshot" and sweep regardless.
    held.set('orphan', new Blob([new Uint8Array([9])]));
    snaps.broken = true;
    expect(await sweepLocalAttachments()).toBe(0);
    expect(held.has('orphan')).toBe(true);
  });

  it('spares the Drive file of a freed, then deleted, attachment a snapshot names', async () => {
    // Freed: nothing held here. Deleted: absent from the state, condemned.
    condemn('e1');
    snaps.states = [stateWith([smallExternal('e1')])];
    const waiting = await purgeCondemnedFiles();
    expect(drive.deleted).toEqual([]);
    // Kept in the journal, so it goes once the snapshot does…
    expect(graveyard.has('drive-e1')).toBe(true);
    // …and not counted as waiting on Drive, which would have the token
    // renewal asking on every tap for a month to do nothing.
    expect(waiting).toBe(0);
  });

  it('recognises it by attachment id when the snapshot predates the upload', async () => {
    condemn('e1');
    const beforeUpload = { type: 'file', name: 'e1.abc', mimeType: 'text/plain', data: '',
      external: { id: 'e1', bytes: 3 } } as Attachment;
    snaps.states = [stateWith([beforeUpload])];
    await purgeCondemnedFiles();
    expect(drive.deleted).toEqual([]);
  });

  it('deletes it once no snapshot names it any more', async () => {
    condemn('e1');
    expect(await purgeCondemnedFiles()).toBe(0);
    expect(drive.deleted).toEqual(['drive-e1']);
    expect(graveyard.size).toBe(0);
  });

  it('deletes nothing on Drive when the snapshots cannot be read', async () => {
    condemn('e1');
    snaps.broken = true;
    expect(await purgeCondemnedFiles()).toBe(1);
    expect(drive.deleted).toEqual([]);
    expect(graveyard.has('drive-e1')).toBe(true);
  });

  it('still reports what waits on Drive while Drive is away', async () => {
    condemn('e1');
    condemn('e2');
    snaps.states = [stateWith([smallExternal('e2')])];
    drive.connected = false;
    // e1 is due and cannot go yet; e2 is held by a snapshot and is not due.
    expect(await purgeCondemnedFiles()).toBe(1);
    expect(drive.deleted).toEqual([]);
  });
});

// ── One dead token must not be paid for once per attachment ─────────────────
// driveService answers a rejected token by asking for a new one, and waits a
// full OAUTH_TIMEOUT_MS (60 s) before giving up — then clears itself, so the
// next attachment starts its own sixty-second wait. Measured in a browser
// against a real Drive answering 401: exactly 60 s each, three attachments
// costing 180 s of a frozen button. Ten would be ten minutes; a threshold of
// zero over a real library, a day.
//
// So the first unreachable answer ends the pass. What is left is reported
// without being asked — the same truth, instantly.
describe('when Drive turns out to be unreachable mid-pass', () => {
  const threeAway = () => ({
    attachmentThresholdKb: 100_000,
    cards: {
      c1: card('Un', [ext('e1')]), c2: card('Deux', [ext('e2')]), c3: card('Trois', [ext('e3')]),
    },
  }) as unknown as AppState;

  beforeEach(() => { held.clear(); drive.unreachable = true; drive.downloads = 0; });
  afterEach(() => { drive.unreachable = false; });

  it('asks ONCE, not once per attachment, when the conversion comes home', async () => {
    drive.connected = true;
    store.state = threeAway();
    const r = await applyConversion();
    expect(drive.downloads).toBe(1);
    // All three are still counted as failed — the user is told the truth.
    expect(r.failed).toBe(3);
    expect(r.back).toBe(0);
    // And not one of them was emptied.
    for (const id of ['c1', 'c2', 'c3']) {
      const att = store.state.cards[id]!.content.attachments[0] as { external?: unknown };
      expect(att.external).toBeTruthy();
    }
  });

  it('asks ONCE when an export tries to put the bytes back', async () => {
    const cards = Object.values(threeAway().cards!);
    const missing = await inlineExternalAttachments(cards);
    expect(drive.downloads).toBe(1);
    // Every one of them is named to the gate, not just the one that was tried.
    expect(missing.map(m => m.name)).toEqual(['e1.mp3', 'e2.mp3', 'e3.mp3']);
    expect(missing.every(m => m.reason === 'offline')).toBe(true);
  });

  it('asks ONCE when the archive collects the bytes', async () => {
    const cards = Object.values(threeAway().cards!);
    const { blobs, missing } = await externalAttachmentBlobs(cards);
    expect(drive.downloads).toBe(1);
    expect(blobs.size).toBe(0);
    expect(missing).toHaveLength(3);
  });

  it('still tries every file when the failures are about the FILES', async () => {
    // A deleted Drive file says nothing about the next one, so the walk goes on.
    drive.unreachable = false;
    const cards = Object.values(threeAway().cards!);
    const missing = await inlineExternalAttachments(cards);
    expect(drive.downloads).toBe(3);
    expect(missing.every(m => m.reason === 'gone')).toBe(true);
  });
});
