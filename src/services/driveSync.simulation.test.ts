import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AppState } from '../types';
import { statesEqual } from './stateDiff';

// ── A whole install, simulated ───────────────────────────────────────────────
// reconcilePolicy.test.ts already proves the decision TABLE is right, on pure
// inputs. This file asks what that table cannot answer: in a real install, what
// can actually put the conflict modal on screen saying the two copies hold the
// SAME content and the Drive one was written by THIS device?
//
// Users reported exactly that (2026-09-06): one device, nothing changed, no
// difference shown. The hypothesis is a lost upload acknowledgement — Drive
// committed our own write and the answer never came back. Every route to that
// screen is walked here through the REAL driveService, faking only the browser
// around it, so the hypothesis is either the only survivor or it is not.
//
// Faked: localStorage, fetch (a Drive with a version counter), the OAuth
// client, the clock. Not faked: every line of bookkeeping, precondition,
// reconciliation and upload logic under test.

const USER = 'user-1';
const FILE = 'file-1';

type Payload = AppState & { _lastModified?: number; _deviceId?: string };
type Drive = typeof import('./driveService');

// ── The browser ──────────────────────────────────────────────────────────────

class MemoryStorage {
  map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

/** Every upload gets one of these. The three that COMMIT before failing are the
 *  whole point: from the client's side they are indistinguishable from a write
 *  that never happened, and that is exactly the blind spot being probed. */
type Upload =
  | 'ok'
  | 'commit-then-network-error'   // bytes landed, connection died on the way back
  | 'commit-then-500'             // bytes landed, gateway answered an error
  | 'commit-then-hang'            // bytes landed, tab was killed before the answer
  | 'commit-then-wait'            // bytes landed, the answer is held back on purpose
  | 'error-before-commit';        // genuinely nothing happened (offline)

class FakeDrive {
  version = 1;
  body: string | null = null;
  /** Writes that actually landed — the ground truth the client cannot see. */
  commits = 0;
  nextUpload: Upload = 'ok';
  /** Releases an upload answer held by 'commit-then-wait'. Lets two tabs write
   *  in one order and be acknowledged in the other. */
  release: (() => void) | null = null;

  write(payload: string): void { this.body = payload; this.version++; this.commits++; }
  /** Drive bumps `version` for server-side churn nobody asked for (indexing…). */
  phantomBump(): void { this.version++; }
  payload(): Payload | null { return this.body === null ? null : JSON.parse(this.body) as Payload; }

  /** A second writer: another device, or an older build of this one. */
  writeAs(s: AppState, deviceId: string, ts: number): void {
    const { id: _id, ...rest } = s;
    this.write(JSON.stringify({ ...rest, _lastModified: ts, _deviceId: deviceId }));
  }
}

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function installFetch(drive: FakeDrive): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('oauth2/v3/userinfo')) return response(200, { sub: 'google-1', email: 'anne@example.com' });
    if (u.startsWith('https://www.googleapis.com/upload/')) {
      const outcome = drive.nextUpload;
      drive.nextUpload = 'ok';
      if (outcome === 'error-before-commit') throw new TypeError('Failed to fetch');
      drive.write(String(init!.body));
      if (outcome === 'commit-then-network-error') throw new TypeError('Failed to fetch');
      if (outcome === 'commit-then-500') return response(500, {});
      if (outcome === 'commit-then-hang') return new Promise(() => { /* the tab dies here */ });
      // The answer reports the version produced BY THIS WRITE, whenever it
      // finally arrives — which is the whole point of holding it back.
      const written = String(drive.version);
      if (outcome === 'commit-then-wait') {
        return new Promise(resolve => { drive.release = () => resolve(response(200, { version: written })); });
      }
      return response(200, { version: written });
    }
    if (u.includes('/drive/v3/files?q=')) return response(200, { files: [{ id: FILE }] });
    if (u.includes('fields=version')) return response(200, { version: String(drive.version) });
    if (u.includes('alt=media')) return { ok: true, status: 200, json: async () => JSON.parse(drive.body ?? 'null') as unknown };
    throw new Error('unexpected request: ' + u);
  });
}

function installOAuth(): void {
  const google = {
    accounts: {
      oauth2: {
        initTokenClient: () => {
          const client = {
            callback: null as ((r: unknown) => void) | null,
            error_callback: null,
            requestAccessToken: () => client.callback?.({ access_token: 'tok', expires_in: 3600 }),
          };
          return client;
        },
        revoke: () => {},
      },
    },
  };
  vi.stubGlobal('google', google);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: () => {},
  });
}

// ── The app around driveService ──────────────────────────────────────────────

interface Session {
  mod: Drive;
  /** The tab's own copy of the user's data — appState.value in the real app. */
  local: AppState;
  /** Every verdict this tab reached from INSIDE a flush, i.e. what a push
   *  blocked by the version precondition put on screen. */
  duringFlush: Verdict[];
}

/** What the user would SEE at the end of a reconciliation. `conflict` carries
 *  the two facts the reported screen showed: same content, same device. */
type Verdict =
  | { screen: 'none' }
  | { screen: 'apply' }
  | { screen: 'conflict'; identical: boolean; sameDevice: boolean };

const state = (over: Record<string, unknown> = {}): AppState =>
  ({ id: USER, cards: {}, decks: {}, folders: {}, profiles: {}, ...over }) as unknown as AppState;

let storage: MemoryStorage;
let drive: FakeDrive;

/** The one field the scenarios move around, read back off the file itself. */
const driveNote = (): unknown => (drive.payload() as unknown as { note?: string } | null)?.note;

/** A tab: a fresh module instance over the SHARED localStorage — which is
 *  exactly what a second tab of the same browser is. */
async function openTab(local: AppState): Promise<Session> {
  vi.resetModules();
  const mod = await import('./driveService');
  mod.initDriveForUser(USER);
  const s: Session = { mod, local, duringFlush: [] };
  // Mirrors main.ts's reconcileWithDrive, which is what flushSync's precondition
  // calls: only 'none' lets a push proceed.
  mod.setReconcileHook(async () => {
    const v = await reconcile(s);
    s.duringFlush.push(v);
    return v.screen === 'none';
  });
  return s;
}

/** main.ts's boot reconciliation, verdict included. */
async function reconcile(s: Session): Promise<Verdict> {
  const file = await s.mod.readDriveFile(true);
  const result = s.mod.reconcileDriveData(file);
  if (result.action === 'none') { s.mod.resumePendingSync(s.local); return { screen: 'none' }; }
  if (result.action === 'apply') {
    // applyDriveState, minus the snapshot and the migration — neither touches
    // the bookkeeping this file is about.
    s.local = { ...result.state, id: USER };
    s.mod.markSyncedAfterApply(result.driveTs, result.version);
    return { screen: 'apply' };
  }
  // showDriveConflictModal's own two questions, asked the way it asks them.
  return {
    screen: 'conflict',
    identical: statesEqual(s.local, result.state),
    sameDevice: result.driveDeviceId !== null && result.driveDeviceId === s.mod.getDeviceId(),
  };
}

/** store.ts's mutate(): change something, then tell Drive. */
function edit(s: Session, fn: (u: Record<string, unknown>) => void): void {
  const next = structuredClone(s.local);
  fn(next as unknown as Record<string, unknown>);
  s.local = next;
  s.mod.syncToCloud(next);
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Let an in-flight flush run as far as it can. Used only where the upload is
 *  made to hang: the point is to reach the write and stop there. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const SAME_DEVICE_IDENTICAL = { screen: 'conflict', identical: true, sameDevice: true };

/** An install already connected and in sync: where most users are. */
async function connectedAndInSync(): Promise<Session> {
  storage.setItem('cadence_drive_file_id_' + USER, FILE);
  storage.setItem('cadence_drive_connected_' + USER, '1');
  storage.setItem('cadence_drive_owner_' + USER, 'google-1');
  const s = await openTab(state({ cards: { a: { id: 'a' } } }));
  edit(s, u => { u.note = 'first'; });
  await s.mod.manualSync();
  expect(drive.commits).toBe(1);
  expect(await reconcile(s)).toEqual({ screen: 'none' });
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T10:00:00Z'));
  storage = new MemoryStorage();
  drive = new FakeDrive();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('crypto', { randomUUID: () => 'device-here' });
  installFetch(drive);
  installOAuth();
  // A token that is already valid — otherwise every request would detour
  // through the consent flow, which is not what any of this is about.
  storage.setItem('cadence_access_token', 'tok');
  storage.setItem('cadence_token_expires_at', String(Date.now() + 3600_000));
  storage.setItem('cadence_token_owner', 'google-1');
  storage.setItem('cadence_device_id', 'device-here');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── 1. The hypothesis: an acknowledgement that never came back ───────────────

describe('a write that landed on Drive without being recorded locally', () => {
  it('the connection dies on the way back: next boot shows the reported screen', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-network-error';
    await s.mod.manualSync();

    // Drive holds our edit. The client believes it failed.
    expect(drive.commits).toBe(2);
    expect(driveNote()).toBe('second');

    advance(60_000);
    const reboot = await openTab(s.local);
    expect(await reconcile(reboot)).toEqual(SAME_DEVICE_IDENTICAL);
  });

  it('a 5xx after the bytes landed reads the same way', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-500';
    await s.mod.manualSync();
    expect(drive.commits).toBe(2);

    const reboot = await openTab(s.local);
    expect(await reconcile(reboot)).toEqual(SAME_DEVICE_IDENTICAL);
  });

  it('the tab is killed between the commit and recordSyncPoint', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-hang';
    void s.mod.manualSync();          // never settles: this tab is gone
    await flushMicrotasks();          // far enough to reach the upload, no further
    expect(drive.commits).toBe(2);

    const reboot = await openTab(s.local);
    expect(await reconcile(reboot)).toEqual(SAME_DEVICE_IDENTICAL);
  });

  it('comes back at every boot until it is answered — which is what users report', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-network-error';
    await s.mod.manualSync();

    for (let i = 0; i < 3; i++) {
      const reboot = await openTab(s.local);
      expect(await reconcile(reboot)).toEqual(SAME_DEVICE_IDENTICAL);
    }
    // And nothing ever pushes in the meantime: the precondition sends every
    // flush back through the same reconciliation.
    expect(drive.commits).toBe(2);
  });

  it('resolves for good once the sync point is recorded — what the silent fix does', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-network-error';
    await s.mod.manualSync();

    const reboot = await openTab(s.local);
    const file = await reboot.mod.readDriveFile(true);
    const result = reboot.mod.reconcileDriveData(file);
    expect(result.action).toBe('conflict');
    if (result.action !== 'conflict') return;

    // RESOLVE_IDENTICAL_SILENTLY's whole body: adopt, apply nothing.
    reboot.mod.markSyncedAfterApply(result.driveTs, result.version);

    expect(await reconcile(await openTab(reboot.local))).toEqual({ screen: 'none' });
    expect(driveNote()).toBe('second');   // nothing was lost or overwritten
  });
});

// ── 2. Everything that does NOT produce that screen ──────────────────────────

describe('what cannot produce it', () => {
  it('a push that never reached Drive: no conflict, and the edit is still pushed later', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'error-before-commit';
    await s.mod.manualSync();
    expect(drive.commits).toBe(1);   // Drive never moved

    const reboot = await openTab(s.local);
    expect(await reconcile(reboot)).toEqual({ screen: 'none' });
    await reboot.mod.manualSync();
    expect(driveNote()).toBe('second');
  });

  it('an ordinary successful push', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    await s.mod.manualSync();
    expect(await reconcile(await openTab(s.local))).toEqual({ screen: 'none' });
  });

  it('a phantom version bump on a cleanly synced file', async () => {
    const s = await connectedAndInSync();
    drive.phantomBump();
    expect(await reconcile(await openTab(s.local))).toEqual({ screen: 'none' });
  });

  it('a phantom bump with unpushed local edits: still silent, and the push follows', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.phantomBump();
    const reboot = await openTab(s.local);
    expect(await reconcile(reboot)).toEqual({ screen: 'none' });
    await reboot.mod.manualSync();
    expect(driveNote()).toBe('second');
  });

  it('an upload whose answer carried no usable version', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://www.googleapis.com/upload/')) {
        drive.write(String(init!.body));
        return response(200, {});                 // no `version` field
      }
      if (u.includes('fields=version')) return response(200, { version: String(drive.version) });
      if (u.includes('alt=media')) return { ok: true, status: 200, json: async () => JSON.parse(drive.body ?? 'null') as unknown };
      throw new Error('unexpected request: ' + u);
    });
    await s.mod.manualSync();
    expect(drive.commits).toBe(2);
    // The base was dropped rather than left stale, so the next read re-anchors
    // on the content stamp instead of asking the user anything.
    expect(await reconcile(await openTab(s.local))).toEqual({ screen: 'none' });
  });

  it('Drive moved and local did not: applied silently, no question asked', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    drive.writeAs(state({ note: 'from the other device' }), 'other-device', Date.now());
    const reboot = await openTab(s.local);
    expect(await reconcile(reboot)).toEqual({ screen: 'apply' });
    expect((reboot.local as unknown as { note: string }).note).toBe('from the other device');
  });

  it('a genuine two-sided divergence shows a real difference, not an identical one', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    drive.writeAs(state({ note: 'their edit' }), 'other-device', Date.now());
    edit(s, u => { u.note = 'my edit'; });
    expect(await reconcile(await openTab(s.local)))
      .toEqual({ screen: 'conflict', identical: false, sameDevice: false });
  });

  it('a second LOCAL user sharing one Google account: same device, but a real difference', async () => {
    // The device id is per browser profile, not per local user, so two local
    // users who insisted on sharing one Google account both write the same file
    // AND stamp the same device id. It still cannot masquerade as the reported
    // screen: what they hold is somebody else's data, and the diff says so.
    const s = await connectedAndInSync();
    advance(60_000);
    drive.writeAs(state({ note: 'the other local user' }), 'device-here', Date.now());
    edit(s, () => {});
    expect(await reconcile(await openTab(s.local)))
      .toEqual({ screen: 'conflict', identical: false, sameDevice: true });
  });

  it('a no-op edit alone never raises anything, however many times it happens', async () => {
    // Local "moved" is a counter, so re-saving identical content still counts.
    // It is a necessary ingredient of the reported screen — never a sufficient
    // one: without a Drive write nobody recorded, nothing is ever asked.
    const s = await connectedAndInSync();
    for (let i = 0; i < 5; i++) { advance(1_000); edit(s, () => {}); }
    expect(await reconcile(await openTab(s.local))).toEqual({ screen: 'none' });
  });
});

// ── 3. The other ways to that exact screen ──────────────────────────────────

describe('the other routes to identical + same device', () => {
  it('reconnecting Drive by hand forces it, by design and with no lost write', async () => {
    const s = await connectedAndInSync();
    s.mod.disconnectDrive();
    advance(60_000);

    const result = await s.mod.connectDrive();
    expect(result.action).toBe('conflict');
    if (result.action !== 'conflict') return;
    expect(statesEqual(s.local, result.state)).toBe(true);
    expect(result.driveDeviceId).toBe(s.mod.getDeviceId());
    // Nothing went wrong here: a reconnect deliberately voids every merge base
    // (the file may have been reverted or replaced while detached), so the two
    // copies are always the user's call. It takes a click on "Connect".
    expect(drive.commits).toBe(1);
  });

  it('a reconnect conflict closed by killing the tab comes back at the next boot', async () => {
    // The connect flow voids both merge bases before asking. The modal cannot
    // be dismissed, but the tab can be closed — and then the install is
    // connected with no base at all, which is a conflict by definition.
    const s = await connectedAndInSync();
    s.mod.disconnectDrive();
    advance(60_000);
    expect((await s.mod.connectDrive()).action).toBe('conflict');

    const reboot = await openTab(s.local);
    expect(await reconcile(reboot)).toEqual(SAME_DEVICE_IDENTICAL);
  });

  it('a Drive file restored by hand to an older revision of our own', async () => {
    // Google Drive keeps its own version history, and restoring a revision is a
    // new write: a version we never recorded, carrying a `_deviceId` that is
    // still ours. Identical only if local happens to hold that same content
    // again — which is exactly what undoing the edit locally does.
    const s = await connectedAndInSync();
    const restorePoint = drive.body!;
    advance(60_000);
    edit(s, u => { u.note = 'a change'; });
    await s.mod.manualSync();
    advance(60_000);
    edit(s, u => { u.note = 'first'; });        // back to what the file used to hold
    drive.write(restorePoint);                  // the user restores that revision

    expect(await reconcile(await openTab(s.local))).toEqual(SAME_DEVICE_IDENTICAL);
  });

  it('another device holding the very same content: identical, but NOT this device', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    // The other device re-pushes byte-identical content (e.g. it just answered
    // "keep local" on the same divergence).
    drive.writeAs(s.local, 'other-device', Date.now());
    edit(s, () => {});
    expect(await reconcile(await openTab(s.local)))
      .toEqual({ screen: 'conflict', identical: true, sameDevice: false });
  });

  it('an older build of this app, still running in another tab, writes without version tracking', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    // Same device id (same browser), content unchanged — an old bundle pushing
    // what it had. Indistinguishable from a lost acknowledgement, and the same
    // family of cause: a write by this device that our bookkeeping never saw.
    drive.writeAs(s.local, 'device-here', Date.now());
    edit(s, () => {});
    expect(await reconcile(await openTab(s.local))).toEqual(SAME_DEVICE_IDENTICAL);
  });

  it('"keep local" whose follow-up push never happened, then a phantom bump', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-network-error';
    await s.mod.manualSync();

    const reboot = await openTab(s.local);
    const file = await reboot.mod.readDriveFile(true);
    const result = reboot.mod.reconcileDriveData(file);
    expect(result.action).toBe('conflict');
    if (result.action !== 'conflict') return;

    // The user answers "keep local"; the push it triggers dies offline.
    reboot.mod.adoptDriveVersionAsBase(result.version);
    drive.nextUpload = 'error-before-commit';
    reboot.mod.syncToCloud(reboot.local);
    await reboot.mod.manualSync();

    // Adopting a version without a content stamp leaves the phantom-bump guard
    // with nothing to match on, so the next server-side churn re-raises the
    // same question. A repeat, not a new cause.
    drive.phantomBump();
    expect(await reconcile(await openTab(reboot.local))).toEqual(SAME_DEVICE_IDENTICAL);
  });

  it('a second tab flushing WHILE the first upload is in flight sees the same screen', async () => {
    // The one route that needs nothing to go wrong at all. Two tabs, both with
    // something to push: tab A's write has landed but its acknowledgement is
    // still on the wire, so nothing has recorded it yet. Tab B's flush reads a
    // Drive that moved with no record of why — the exact signature of a lost
    // acknowledgement, except that this one is merely late.
    const s = await connectedAndInSync();
    const other = await openTab(structuredClone(s.local));
    advance(60_000);
    edit(s, u => { u.note = 'same edit'; });
    edit(other, u => { u.note = 'same edit'; });

    drive.nextUpload = 'commit-then-wait';
    const aDone = s.mod.manualSync();
    await flushMicrotasks();               // A has written; its answer is held
    expect(drive.commits).toBe(2);

    await other.mod.manualSync();
    expect(other.duringFlush).toEqual([SAME_DEVICE_IDENTICAL]);
    // The precondition did its job: B never wrote over a file it had not
    // reconciled with.
    expect(drive.commits).toBe(2);

    // And it is transient — once A's answer lands, everything settles.
    drive.release!();
    await aDone;
    advance(60_000);
    expect(await reconcile(await openTab(s.local))).toEqual({ screen: 'none' });
  });

  it('two tabs one after the other, no overlap: no divergence at all', async () => {
    // The bookkeeping lives in localStorage, which both tabs share, so a second
    // tab pushing after the first simply reads the base the first recorded.
    const s = await connectedAndInSync();
    const other = await openTab(structuredClone(s.local));
    advance(60_000);
    edit(s, u => { u.note = 'from tab A'; });
    await s.mod.manualSync();
    edit(other, u => { u.note = 'from tab B'; });
    await other.mod.manualSync();
    expect(drive.commits).toBe(3);
    expect(other.duringFlush).toEqual([]);
    expect(await reconcile(await openTab(other.local))).toEqual({ screen: 'none' });
  });
});

// ── 4. Is the silent resolution safe? ───────────────────────────────────────

describe('flipping RESOLVE_IDENTICAL_SILENTLY would not hide a real difference', () => {
  it('an edit made AFTER the lost write keeps the copies different, so the user is still asked', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-network-error';
    await s.mod.manualSync();
    advance(60_000);
    edit(s, u => { u.note = 'third'; });      // never reached Drive

    const reboot = await openTab(s.local);
    const verdict = await reconcile(reboot);
    expect(verdict).toEqual({ screen: 'conflict', identical: false, sameDevice: true });
  });

  it('adopting silently keeps every local edit, then pushes the next one normally', async () => {
    const s = await connectedAndInSync();
    advance(60_000);
    edit(s, u => { u.note = 'second'; });
    drive.nextUpload = 'commit-then-network-error';
    await s.mod.manualSync();

    const reboot = await openTab(s.local);
    const file = await reboot.mod.readDriveFile(true);
    const result = reboot.mod.reconcileDriveData(file);
    if (result.action !== 'conflict') throw new Error('expected a conflict');
    reboot.mod.markSyncedAfterApply(result.driveTs, result.version);

    expect((reboot.local as unknown as { note: string }).note).toBe('second');
    advance(60_000);
    edit(reboot, u => { u.note = 'third'; });
    await reboot.mod.manualSync();
    expect(driveNote()).toBe('third');
    expect(await reconcile(await openTab(reboot.local))).toEqual({ screen: 'none' });
  });
});
