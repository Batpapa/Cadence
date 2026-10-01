import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  attachmentFor, mutateWithRule, uploadPendingAttachments, applyConversion, freeUploadedAttachments,
  sweepLocalAttachments, purgeCondemnedFiles, condemnAttachmentFile, condemnCardAttachments,
  replaceExternalBytes, attachmentBlob, isExternal, uploadAttachmentSoon,
} from './attachmentStore';
import { emptyState } from '../utils';
import type { AppState, Card, FileAttachment } from '../types';

// Property test of the externalised-attachment machinery (TODO §3.5, written
// 2026-10-01). Random but reproducible sequences of the operations the app
// really performs — attach, import, refresh, edit, remove, delete a card,
// upload, convert, free, sweep, purge, snapshot — against a fake device store
// and a fake Drive that both actually KEEP bytes. After every step, three
// invariants must hold:
//
//   1. nothing referenced is unreachable: every external attachment in the
//      live state AND in every snapshot resolves from its own record — local
//      bytes, or a Drive file that still exists;
//   2. bytes never change under an id: what is read back is what was written;
//   3. no orphan on Drive: every file there is named by the state, by a
//      snapshot, or by the journal of condemned files waiting to go.
//
// The card page's handlers are replayed here as the app writes them (onAdd,
// onRemove, onUpdateFile) rather than imported: they live inside a view.
//
// What the first runs found (2026-10-01):
//   - a real defect: a snapshot taken while a file waited in the upload
//     backlog could be gutted by "free space" once the upload went through
//     (seed 280; fixed in freeableAttachments);
//   - a vitest one: two `import()`s of the same mocked module in flight at once
//     from attachmentStore could resolve the second to the REAL driveService,
//     which dies on `localStorage` — so an upload "hung" for no reason the
//     app has. attachmentStore now asks for each deferred module once.
// Between runs the previous run's background work is let finish and Drive ids
// are never reused, or a late purge from one run deletes the next run's file.

// ── The world ───────────────────────────────────────────────────────────────

const held = vi.hoisted(() => new Map<string, Blob>());
const graveyard = vi.hoisted(() => new Map<string, { driveFileId: string; attachmentId: string; at: number; replacedBy?: string }>());
/** First bytes ever written under each local id — invariant 2's reference. */
const firstWrite = vi.hoisted(() => new Map<string, Blob>());
vi.mock('./attachmentDb', () => ({
  getAttachmentBlob: (id: string) => Promise.resolve(held.get(id)),
  putAttachmentBlob: (id: string, blob: Blob) => {
    if (!firstWrite.has(id)) firstWrite.set(id, blob);
    held.set(id, blob);
    return Promise.resolve();
  },
  deleteAttachmentBlob: (id: string) => { held.delete(id); return Promise.resolve(); },
  heldAttachmentIds: () => Promise.resolve([...held.keys()]),
  condemnDriveFile: (driveFileId: string, attachmentId: string, replacedBy?: string) => {
    graveyard.set(driveFileId, { driveFileId, attachmentId, at: 0, ...(replacedBy ? { replacedBy } : {}) });
    return Promise.resolve();
  },
  condemnedFiles: () => Promise.resolve([...graveyard.values()]),
  forgetCondemned: (driveFileId: string) => { graveyard.delete(driveFileId); return Promise.resolve(); },
}));

const drive = vi.hoisted(() => ({ connected: true, files: new Map<string, Blob>(), next: 0 }));
vi.mock('./driveService', () => ({
  isDriveConnected: () => drive.connected,
  hasDriveToken: () => true,
  registerDrivePendingWork: () => {},
  companionPathId: () => (drive.connected ? Promise.resolve('folder') : Promise.reject(new Error('offline'))),
  uploadCompanionFileInto: (_folder: string, _name: string, blob: Blob) => {
    if (!drive.connected) return Promise.reject(new Error('offline'));
    const id = 'drive-' + (++drive.next);
    drive.files.set(id, blob);
    return Promise.resolve(id);
  },
  downloadCompanionFile: (id: string) =>
    (drive.connected ? Promise.resolve(drive.files.get(id) ?? null) : Promise.reject(new Error('offline'))),
  deleteCompanionFile: (id: string) => {
    if (!drive.connected) return Promise.resolve(false);
    drive.files.delete(id);
    return Promise.resolve(true);
  },
}));

// Clone-on-write, like the real store: a recipe edits a copy that then
// replaces the state, so a reference taken before a mutate stays the old one.
const store = vi.hoisted(() => ({ state: null as unknown as AppState }));
vi.mock('../store', () => ({
  appState: { get value() { return store.state; } },
  mutate: (fn: (s: AppState) => void) => {
    const next = structuredClone(store.state);
    fn(next);
    store.state = next;
    return Promise.resolve();
  },
}));
const mutate = (fn: (s: AppState) => void) => {
  const next = structuredClone(store.state);
  fn(next);
  store.state = next;
  return Promise.resolve();
};

const snaps = vi.hoisted(() => ({ states: [] as AppState[] }));
vi.mock('./snapshotService', () => ({ snapshotStates: () => Promise.resolve(snaps.states) }));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** mulberry32: small, seedable, good enough to pick operations. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Background work (uploads fired and forgotten, the purge a condemnation
 *  starts) runs on promises that resolve at once; a few turns settle it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
}

let counter = 0;
/** A file whose content names itself, so a mix-up cannot pass unnoticed. */
function fileData(bytes: number): { data: string; content: string } {
  const head = `file-${++counter}:`;
  const content = head + 'x'.repeat(Math.max(0, bytes - head.length));
  return { data: btoa(content), content };
}

function newCard(withFile: number | null): Card {
  const id = 'card-' + (++counter);
  const attachments: FileAttachment[] = [];
  if (withFile !== null) attachments.push({ type: 'file', name: id + '.abc', mimeType: 'text/plain', ...pick(fileData(withFile)) });
  return { id, guid: id, name: id, defaultImportance: 1, tags: [], content: { notes: '', attachments } } as Card;
}
const pick = ({ data }: { data: string }) => ({ data });

function externalsOf(state: AppState): FileAttachment[] {
  return Object.values(state.cards ?? {}).flatMap(c =>
    (c.content?.attachments ?? []).filter((a): a is FileAttachment => a.type === 'file' && !!a.external));
}

async function checkInvariants(where: string): Promise<void> {
  const states = [{ label: 'live', state: store.state }, ...snaps.states.map((s, i) => ({ label: 'snapshot ' + i, state: s }))];
  const named = new Set<string>();
  for (const { label, state } of states) {
    for (const att of externalsOf(state)) {
      const ext = att.external!;
      if (ext.driveFileId) named.add(ext.driveFileId);
      const local = held.get(ext.id);
      const remote = ext.driveFileId ? drive.files.get(ext.driveFileId) : undefined;
      // 1 — reachable from its own record.
      expect(local ?? remote, `${where}: ${label} names ${att.name} (${ext.id}, drive ${ext.driveFileId ?? '—'}) but its bytes are nowhere`).toBeDefined();
      // 2 — the bytes are the ones first written under that id.
      const first = firstWrite.get(ext.id);
      if (first) {
        const want = await first.text();
        if (local) expect(await local.text(), `${where}: local bytes of ${ext.id} changed`).toBe(want);
        if (remote) expect(await remote.text(), `${where}: Drive copy of ${ext.id} differs`).toBe(want);
      }
    }
  }
  // 3 — no Drive file that nothing names.
  for (const id of drive.files.keys()) {
    expect(named.has(id) || graveyard.has(id), `${where}: ${id} is on Drive, named by nothing`).toBe(true);
  }
}

// ── The operations, as the app performs them ────────────────────────────────

type Op = { name: string; run: () => Promise<void> };

function operations(r: () => number): Op[] {
  const cards = () => Object.values(store.state.cards);
  const anyCard = () => { const c = cards(); return c.length ? c[Math.floor(r() * c.length)]! : null; };
  const size = () => (r() < 0.5 ? 300 : 3000);
  const fileIndex = (card: Card) => {
    const idx = card.content.attachments.map((a, i) => (a.type === 'file' ? i : -1)).filter(i => i >= 0);
    return idx.length ? idx[Math.floor(r() * idx.length)]! : -1;
  };

  return [
    { name: 'attach', run: async () => {
      const card = anyCard(); if (!card) return;
      const { data } = fileData(size());
      const att = await attachmentFor({ name: 'att-' + counter + '.txt', mimeType: 'text/plain', data }, store.state);
      await mutate(s => { s.cards[card.id]?.content.attachments.push(att); });
      uploadAttachmentSoon(att);
    } },
    { name: 'import', run: async () => {
      const card = newCard(size());
      await mutateWithRule(s => { s.cards[card.id] = card; });
    } },
    { name: 'refresh', run: async () => {
      // applyTheSessionAbc's shape: the file is replaced by a fresh one.
      const card = anyCard(); if (!card) return;
      const i = fileIndex(card); if (i < 0) return;
      const { data } = fileData(size());
      await mutateWithRule(s => {
        const atts = s.cards[card.id]?.content.attachments; if (!atts) return;
        atts[i] = { type: 'file', name: 'refreshed-' + counter + '.abc', mimeType: 'text/plain', data };
      });
    } },
    { name: 'copy', run: async () => {
      const card = anyCard(); if (!card) return;
      const i = fileIndex(card); if (i < 0) return;
      const { data } = fileData(size());
      await mutateWithRule(s => {
        const atts = s.cards[card.id]?.content.attachments; const original = atts?.[i];
        if (!atts || !original || original.type !== 'file') return;
        const { generatedBy: _g, external: _e, ...rest } = original;
        atts.splice(i, 0, { ...rest, name: 'copy-' + counter + '.txt', data });
      });
    } },
    { name: 'edit', run: async () => {
      const card = anyCard(); if (!card) return;
      const i = fileIndex(card); if (i < 0) return;
      const att = card.content.attachments[i] as FileAttachment;
      const { data } = fileData(size());
      if (isExternal(att)) {
        const external = await replaceExternalBytes(att, data);
        await mutate(s => {
          const target = s.cards[card.id]?.content.attachments[i];
          if (target?.type === 'file' && target.external) target.external = external;
        });
        void condemnAttachmentFile(att, external.id);
        uploadAttachmentSoon({ ...att, type: 'file', external });
      } else {
        await mutate(s => { const target = s.cards[card.id]?.content.attachments[i]; if (target?.type === 'file') target.data = data; });
      }
    } },
    { name: 'remove', run: async () => {
      const card = anyCard(); if (!card) return;
      const i = fileIndex(card); if (i < 0) return;
      const removed = store.state.cards[card.id]!.content.attachments[i]!;
      await mutate(s => { s.cards[card.id]?.content.attachments.splice(i, 1); });
      await condemnAttachmentFile(removed);
    } },
    { name: 'delete card', run: async () => {
      const card = anyCard(); if (!card) return;
      await mutate(s => { delete s.cards[card.id]; });
      await condemnCardAttachments([card]);
    } },
    { name: 'upload', run: async () => { await uploadPendingAttachments(); } },
    { name: 'convert', run: async () => { await applyConversion(); } },
    { name: 'threshold', run: async () => {
      const kb = [0, 1, 50][Math.floor(r() * 3)]!;
      await mutate(s => { s.attachmentThresholdKb = kb; });
    } },
    { name: 'free', run: async () => { await freeUploadedAttachments(store.state); } },
    { name: 'sweep', run: async () => { await sweepLocalAttachments(); } },
    { name: 'purge', run: async () => { await purgeCondemnedFiles(); } },
    { name: 'snapshot', run: async () => { snaps.states.push(structuredClone(store.state)); } },
    { name: 'drop snapshot', run: async () => {
      if (snaps.states.length) snaps.states.splice(Math.floor(r() * snaps.states.length), 1);
    } },
    { name: 'drive toggle', run: async () => { drive.connected = !drive.connected; } },
    { name: 'open', run: async () => {
      // Reading caches what came down from Drive under the same id.
      const all = externalsOf(store.state); if (!all.length) return;
      try { await attachmentBlob(all[Math.floor(r() * all.length)]!); } catch { /* offline or not uploaded */ }
    } },
  ];
}

// ── mutateWithRule, case by case ────────────────────────────────────────────
// Here rather than in attachmentStore.test.ts: that file's store edits the
// state in place, and a diff of a state against itself sees nothing.

function freshWorld(thresholdKb: number): void {
  held.clear(); graveyard.clear(); firstWrite.clear(); snaps.states = [];
  drive.connected = true; drive.files.clear();
  store.state = { ...emptyState(), id: 'user-1', cards: {}, attachmentThresholdKb: thresholdKb } as AppState;
}
const onlyFile = (cardId: string) => store.state.cards[cardId]!.content.attachments[0] as FileAttachment;

beforeAll(async () => {
  await import('../store');
  await import('./driveService');
  await import('./snapshotService');
});

describe('mutateWithRule', () => {
  it('sends a new file above the threshold out, and up to Drive', async () => {
    freshWorld(1);
    const card = newCard(3000);
    await mutateWithRule(s => { s.cards[card.id] = card; });
    await settle();
    const att = onlyFile(card.id);
    expect(att.data).toBe('');
    expect(att.external?.bytes).toBe(3000);
    expect(att.external?.driveFileId).toBeDefined();
    expect(await (await attachmentBlob(att)).text()).toMatch(/^file-\d+:x+$/);
  });

  it('keeps a new file below the threshold inline', async () => {
    freshWorld(1);
    const card = newCard(300);
    await mutateWithRule(s => { s.cards[card.id] = card; });
    await settle();
    expect(onlyFile(card.id).external).toBeUndefined();
    expect(held.size).toBe(0);
  });

  it('keeps everything inline without Drive — the rule\'s other half', async () => {
    freshWorld(1);
    drive.connected = false;
    const card = newCard(3000);
    await mutateWithRule(s => { s.cards[card.id] = card; });
    await settle();
    expect(onlyFile(card.id).external).toBeUndefined();
  });

  it('leaves alone what the recipe did not touch, however big', async () => {
    // Not the retroactive conversion: an inline file already in the library
    // stays inline when a recipe edits something else on its card.
    freshWorld(50);
    const card = newCard(3000);
    store.state.cards[card.id] = card;
    await mutate(s => { s.attachmentThresholdKb = 1; });
    await mutateWithRule(s => { s.cards[card.id]!.name = 'renamed'; });
    await settle();
    expect(onlyFile(card.id).external).toBeUndefined();
  });

  it('condemns the Drive copy of a file a refresh replaced', async () => {
    freshWorld(1);
    const card = newCard(3000);
    await mutateWithRule(s => { s.cards[card.id] = card; });
    await settle();
    const before = onlyFile(card.id).external!;
    const { data } = fileData(3000);
    await mutateWithRule(s => {
      s.cards[card.id]!.content.attachments[0] = { type: 'file', name: 'fresh.abc', mimeType: 'text/plain', data };
    });
    await settle();
    expect(drive.files.has(before.driveFileId!)).toBe(false);
    const after = onlyFile(card.id).external!;
    expect(after.id).not.toBe(before.id);
    expect(drive.files.has(after.driveFileId!)).toBe(true);
  });

  it('does not condemn a file that merely moved to another card', async () => {
    freshWorld(1);
    const a = newCard(3000), b = newCard(null);
    await mutateWithRule(s => { s.cards[a.id] = a; s.cards[b.id] = b; });
    await settle();
    const ext = onlyFile(a.id).external!;
    await mutateWithRule(s => {
      const moved = s.cards[a.id]!.content.attachments.pop()!;
      s.cards[b.id]!.content.attachments.push(moved);
    });
    await settle();
    expect(graveyard.size).toBe(0);
    expect(drive.files.has(ext.driveFileId!)).toBe(true);
  });
});

// ── The runs ────────────────────────────────────────────────────────────────

const RUNS = Number(process.env['PROP_RUNS']) || 150;
const STEPS = Number(process.env['PROP_STEPS']) || 40;

describe('externalised attachments, under random sequences of real operations', () => {
  it(`keeps its three invariants over ${RUNS} runs of ${STEPS} steps`, async () => {
    // Every "Drive is unreachable" path warns, and half the runs spend time
    // offline on purpose.
    if (!process.env['PROP_SEED']) vi.spyOn(console, 'warn').mockImplementation(() => {});
    // PROP_SEED=141 npx vitest run attachmentStore.property replays one run and
    // prints every step — the way to read a failure this reports.
    const only = Number(process.env['PROP_SEED']) || 0;
    const trace = (label: string) => {
      if (!only) return;
      const ext = externalsOf(store.state).map(a => `${a.name}=${a.external!.id.slice(0, 4)}/${a.external!.driveFileId ?? '-'}`);
      const inline = Object.values(store.state.cards).flatMap(c => c.content.attachments.filter(a => a.type === 'file' && !a.external).map(a => (a as FileAttachment).name));
      console.log(`${label}\n  external ${ext.join(', ') || '—'}\n  inline ${inline.join(', ') || '—'}\n  local ${[...held.keys()].map(k => k.slice(0, 4)).join(', ') || '—'}\n  drive ${[...drive.files.keys()].join(', ') || '—'} (connected ${drive.connected})\n  graveyard ${[...graveyard.keys()].join(', ') || '—'}  snapshots ${snaps.states.length}`);
    };
    for (let seed = only || 1; seed <= (only || RUNS); seed++) {
      // Let the previous run's background work finish BEFORE resetting, and
      // never reuse a Drive id: a late purge from run n deleting "drive-1"
      // would otherwise delete run n+1's "drive-1" — a failure of the harness,
      // which is what the first version of this test reported.
      for (let i = 0; i < 10; i++) await settle();
      held.clear(); graveyard.clear(); firstWrite.clear();
      drive.connected = true; drive.files.clear();
      snaps.states = [];
      store.state = { ...emptyState(), id: 'user-1', cards: {}, attachmentThresholdKb: 1 } as AppState;
      for (let i = 0; i < 3; i++) { const c = newCard(i === 0 ? 3000 : 300); store.state.cards[c.id] = c; }

      const r = rng(seed);
      const ops = operations(r);
      const trail: string[] = [];
      for (let step = 0; step < STEPS; step++) {
        const op = ops[Math.floor(r() * ops.length)]!;
        trail.push(op.name);
        await op.run();
        await settle();
        trace(`step ${step}: ${op.name}`);
        await checkInvariants(`seed ${seed}, step ${step} after [${trail.join(' → ')}]`);
      }
    }
  }, Math.max(120_000, RUNS * STEPS * 5));
});
