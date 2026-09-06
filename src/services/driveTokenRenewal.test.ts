import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Token renewal, against the real driveService ─────────────────────────────
// Two mechanisms, one purpose: stop asking the user to reconnect every hour.
//
// Google's token model can only mint a token from a user activation. The
// background paths ask when no gesture exists, the browser blocks the window,
// and the cloud goes yellow — nothing failed, the request was just made at the
// wrong instant. So the token is renewed EARLY, from a pointerdown the user
// made anyway; and every path shares one in-flight request, because two
// concurrent asks used to open two windows (the second usually blocked) and
// clobber each other's GIS callback.
//
// Faked here: localStorage, the OAuth client, the DOM events. Not faked: the
// renewal's own conditions, which are what these tests are about.

const USER = 'user-1';

class MemoryStorage {
  map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
  clear(): void { this.map.clear(); }
}

/** The OAuth client, with the two knobs these tests need: how many windows were
 *  opened, and whether the next one is granted or refused. */
class FakeOAuth {
  calls = 0;
  outcome: 'grant' | 'refuse' = 'grant';
  /** Held requests, released by hand — lets two callers overlap on purpose. */
  pending: Array<() => void> = [];
  hold = false;

  client = {
    callback: null as ((r: unknown) => void) | null,
    error_callback: null as ((e: unknown) => void) | null,
    requestAccessToken: () => {
      this.calls++;
      const settle = () => {
        if (this.outcome === 'grant') this.client.callback?.({ access_token: `tok-${this.calls}`, expires_in: 3600 });
        else this.client.error_callback?.({ type: 'popup_closed' });
      };
      if (this.hold) this.pending.push(settle); else settle();
    },
  };

  releaseAll(): void { const p = this.pending; this.pending = []; for (const f of p) f(); }
}

let storage: MemoryStorage;
let oauth: FakeOAuth;
let pointerHandlers: Array<() => void>;

function installBrowser(): void {
  storage = new MemoryStorage();
  oauth = new FakeOAuth();
  pointerHandlers = [];
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('google', {
    accounts: { oauth2: { initTokenClient: () => oauth.client, revoke: () => {} } },
  });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    getElementById: () => ({}),          // pretend the GIS script tag is already there
    createElement: () => ({}),
    head: { appendChild: () => {} },
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'pointerdown') pointerHandlers.push(fn);
    },
  });
  vi.stubGlobal('crypto', { randomUUID: () => 'device-1' });
}

/** A connected install whose token expires in `minutes`. */
async function openApp(minutes: number | null): Promise<typeof import('./driveService')> {
  storage.setItem(`cadence_drive_connected_${USER}`, '1');
  storage.setItem(`cadence_drive_file_id_${USER}`, 'file-1');
  storage.setItem(`cadence_drive_owner_${USER}`, 'google-1');
  if (minutes !== null) {
    storage.setItem('cadence_access_token', 'tok-0');
    storage.setItem('cadence_token_expires_at', String(Date.now() + minutes * 60_000));
    storage.setItem('cadence_token_owner', 'google-1');
  }
  vi.resetModules();
  const mod = await import('./driveService');
  mod.initDriveForUser(USER);
  await mod.initDriveClient();
  mod.initDriveTokenRenewal();
  return mod;
}

const click = () => { for (const h of pointerHandlers) h(); };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(installBrowser);
afterEach(() => vi.unstubAllGlobals());

describe('renewing from a gesture', () => {
  it('leaves a comfortably valid token alone', async () => {
    await openApp(50);
    click();
    await settle();
    expect(oauth.calls).toBe(0);
  });

  it('renews when the token is close to expiry', async () => {
    await openApp(5);
    click();
    await settle();
    expect(oauth.calls).toBe(1);
    // The renewal is the point, not the ceremony: the stored token is replaced.
    expect(storage.getItem('cadence_access_token')).toBe('tok-1');
  });

  it('renews when there is no token at all', async () => {
    await openApp(null);
    click();
    await settle();
    expect(oauth.calls).toBe(1);
  });

  it('asks nothing when Drive is not connected', async () => {
    storage.clear();
    vi.resetModules();
    const mod = await import('./driveService');
    mod.initDriveForUser(USER);
    await mod.initDriveClient();
    mod.initDriveTokenRenewal();
    click();
    await settle();
    expect(oauth.calls).toBe(0);
  });

  it('stops after a refusal instead of popping a window on every click', async () => {
    await openApp(5);
    oauth.outcome = 'refuse';
    click();
    await settle();
    expect(oauth.calls).toBe(1);
    // This is the original complaint ("la fenêtre s'affiche très souvent"), and
    // a gesture path could reproduce it at every single click.
    click(); await settle();
    click(); await settle();
    expect(oauth.calls).toBe(1);
  });

  it('does not renew while the tab is hidden', async () => {
    await openApp(5);
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
    click();
    await settle();
    expect(oauth.calls).toBe(0);
  });
});

describe('one token request at a time', () => {
  it('collapses two concurrent renewals into a single window', async () => {
    await openApp(5);
    oauth.hold = true;

    click();          // first gesture starts the request
    await settle();
    click();          // second lands while the window is still open
    click();
    await settle();

    expect(oauth.calls).toBe(1);
    oauth.releaseAll();
    await settle();
    expect(storage.getItem('cadence_access_token')).toBe('tok-1');
  });

  it('lets a later gesture ask again once the first request has settled', async () => {
    await openApp(5);
    click();
    await settle();
    expect(oauth.calls).toBe(1);

    // Fresh token now, so a click asks for nothing…
    click(); await settle();
    expect(oauth.calls).toBe(1);

    // …until it nears expiry again, proving the in-flight slot was released.
    storage.setItem('cadence_token_expires_at', String(Date.now() + 60_000));
    vi.resetModules();
    const mod = await import('./driveService');
    mod.initDriveForUser(USER);
    await mod.initDriveClient();
    mod.initDriveTokenRenewal();
    click();
    await settle();
    expect(oauth.calls).toBe(2);
  });
});
