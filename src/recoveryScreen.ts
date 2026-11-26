import { initDb, dumpRawDatabase, loadUser, getAllUserIds } from './db';
import { formatBytes } from './utils';
import { downloadCadenceFile, downloadBlob } from './services/fileTransfer';
import { welcomeLanguage } from './services/userService';
import { h, render } from 'preact';
import { WelcomePrefs } from './components/welcomePrefs';
import { setLanguage, t } from './services/i18nService';
import { listAllSnapshots, getSnapshotState, type SnapshotMeta } from './services/snapshotService';
import { collectUserSessionAudio, userDbName, localSessionAudioStats } from './session/db';
import { rawAttachmentBlobs } from './services/attachmentDb';
import { buildZip, audioExtension } from './services/zip';
import { applyTheme } from './services/themeService';

// ── The recovery screen ──────────────────────────────────────────────────────
// Plain markup, before any Preact root: what is left when the app cannot
// start, or what `?mode=recovery` opens on purpose. Out of main.ts since
// 2026-11-26, as it was: imported statically there, so that a screen made for
// a broken or offline app never waits on a chunk of its own.

/** Shown either after a real boot failure (initDb() timing out because
 *  another tab/connection deadlocked the IndexedDB upgrade lock — see db.ts —
 *  `err` is set), or on demand via `?mode=recovery` (no `err`) so someone can
 *  be pointed here to self-serve a per-user data download even when their app
 *  otherwise loads fine. Lists every local user by name/id so with 2+ users
 *  on the same device it's clear which one's data is being sent — there is
 *  deliberately no "erase everything" option, since that would destroy
 *  anything not synced to Drive. */
export async function showRecoveryScreen(root: HTMLElement, err?: unknown): Promise<void> {
  const message = err !== undefined ? (err instanceof Error ? err.message : String(err)) : null;
  // Neither entry point runs showUserSelector(), which is where the language
  // is otherwise set: without this the screen spoke English to everyone.
  setLanguage(welcomeLanguage());
  // Nor applyTheme(): index.html's bootstrap paints the theme, but only
  // applyTheme() brings the Android app's system bars along.
  applyTheme();

  // Redrawn in place when the language changes: let go of the previous controls.
  const oldPrefs = document.getElementById('recovery-prefs');
  if (oldPrefs) render(null, oldPrefs);
  // Top padding clears the status bar where the page runs under it (Android 15+).
  // w-full: #app is a flex column, where an auto-margined box shrinks to its
  // text — the screen changed width with the language.
  root.innerHTML = `
    <div class="w-full p-4 sm:p-8 max-w-3xl mx-auto space-y-4" style="padding-top:calc(var(--safe-top) + 1rem)">
      <div id="recovery-prefs" class="flex justify-end -mb-2"></div>
      <h1 class="text-lg font-semibold text-center">${escapeHtml(t('recovery.title'))}</h1>
      ${message
        ? `<p class="text-danger font-mono text-sm text-center">${escapeHtml(t('recovery.failed', { message }))}</p>
           <p class="text-xs text-muted text-center">${escapeHtml(t('recovery.failedHint'))}</p>
           <div class="flex justify-center"><button id="recovery-retry" class="btn-primary text-sm">${escapeHtml(t('recovery.retry'))}</button></div>`
        : `<p class="text-xs text-muted text-center">${escapeHtml(t('recovery.intro'))}</p>`}
      <div id="recovery-users" class="space-y-2 overflow-x-auto"></div>
      <div id="recovery-snapshots" class="space-y-2"></div>
      <div class="flex flex-wrap gap-2 justify-center pt-2 border-t border-border">
        <button id="recovery-raw" class="btn-ghost text-sm">${escapeHtml(t('recovery.rawDump'))}</button>
        <button id="recovery-report" class="btn-ghost text-sm">${escapeHtml(t('recovery.report'))}</button>
      </div>
    </div>`;

  // The screen is plain markup: a language picked here redraws all of it —
  // after the picker's own handler has returned, since the redraw replaces the
  // Preact tree that handler runs in.
  render(h(WelcomePrefs, { onLanguageChange: () => { setTimeout(() => { void showRecoveryScreen(root, err); }, 0); } }),
    document.getElementById('recovery-prefs')!);

  document.getElementById('recovery-retry')?.addEventListener('click', () => location.reload());
  const rawBtn = document.getElementById('recovery-raw') as HTMLButtonElement | null;
  rawBtn?.addEventListener('click', () => { void runDownload(rawBtn, t('recovery.rawDump'), () => downloadRawDump(message), false); });
  document.getElementById('recovery-report')?.addEventListener('click', () => { void reportBug(message); });

  const usersEl = document.getElementById('recovery-users')!;
  try {
    // ?mode=recovery skips normal boot entirely, so initDb() was never called
    // in that path — a real boot failure (message set) already tried and
    // failed, so skip straight to listing (which will itself throw below).
    if (!message) await initDb();
    const ids = await getAllUserIds();
    if (ids.length === 0) {
      usersEl.innerHTML = `<p class="text-xs text-muted text-center">${escapeHtml(t('recovery.noUsers'))}</p>`;
      return;
    }
    // One batched lookup instead of a per-user existence check — tells us
    // which users actually have a session database on this device, so the
    // "Download sessions" button only shows up where there's something to get.
    const sessionDbNames = indexedDB.databases ? new Set((await indexedDB.databases()).map(d => d.name)) : null;

    for (const id of ids) {
      const user = await loadUser(id);
      const row = document.createElement('div');
      // One line from `sm` up; stacked below it, where the full id, the name
      // and two buttons on one line pushed the row far past a phone's width.
      row.className = 'flex flex-col gap-1.5 p-2 rounded border border-border sm:flex-row sm:items-center sm:gap-3 sm:whitespace-nowrap';
      const idTag = document.createElement('span');
      // Always shown in full, never wrapped/truncated — the one thing this
      // screen exists to make legible for debugging. On a phone it gets a line
      // of its own, which a 36-character id fits.
      idTag.className = 'text-xs text-muted font-mono select-all shrink-0 whitespace-nowrap';
      idTag.textContent = id;
      const nameTag = document.createElement('span');
      nameTag.className = 'text-sm truncate min-w-0 sm:flex-1';
      nameTag.textContent = user?.name ?? t('recovery.unnamed');

      const safeName = (user?.name ?? 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const btns = document.createElement('span');
      btns.className = 'flex flex-wrap gap-1 shrink-0';

      const btn = document.createElement('button');
      btn.className = 'btn-ghost text-xs shrink-0 inline-flex items-center gap-1.5';
      btn.innerHTML = EXPORT_SVG + escapeHtml(t('recovery.data'));
      // Downloaded as .cdb, id stripped — the exact shape Settings → Backup →
      // Import accepts, so recovery-to-restore is: download here, import there.
      //
      // Attachments kept out of the blob are put BACK into it first, from this
      // device's own copies. Without that, the one screen that exists for a
      // broken app would hand someone a file of references and call it their
      // data — the 2026-09-09 failure, on the screen built to answer it. Drive
      // is deliberately not consulted: this runs when nothing works, and a
      // file this device does not hold simply stays a reference.
      btn.onclick = () => { void runDownload(btn, t('recovery.data'), () => downloadUserData(id, safeName, user)); };
      btns.appendChild(btn);

      // `?.has` may be true, false, or unknown (Safari lacks databases()) —
      // when unknown, still offer the button and let the click itself
      // discover there's nothing there (collectUserSessionAudio returns null).
      if (sessionDbNames === null || sessionDbNames.has(userDbName(id))) {
        const audioBtn = document.createElement('button');
        audioBtn.className = 'btn-ghost text-xs shrink-0 inline-flex items-center gap-1.5';
        let audioLabel = t('recovery.audio');
        audioBtn.innerHTML = EXPORT_SVG + escapeHtml(audioLabel);
        audioBtn.onclick = () => { void runDownload(audioBtn, audioLabel, () => downloadSessionAudioZip(id, safeName, user)); };
        btns.appendChild(audioBtn);
        // How much is behind that button, once we can tell. This screen exists
        // for someone whose app is broken and who is about to wait on a
        // download; "Audio (1.2 GB)" is the difference between waiting on
        // purpose and assuming it has hung. Fire-and-forget — the button is
        // usable while the figure is still being counted, and stays usable if
        // it never arrives.
        void localSessionAudioStats(id).then(stats => {
          if (!stats) return;
          audioLabel = t('recovery.audioSized', { size: formatBytes(stats.bytes) });
          if (!audioBtn.disabled) audioBtn.innerHTML = EXPORT_SVG + escapeHtml(audioLabel);
        }).catch(() => { /* the plain label is already correct */ });
      }

      row.append(idTag, nameTag, btns);
      usersEl.appendChild(row);
    }
  } catch (listErr) {
    console.error('Recovery: failed to list users:', listErr);
    usersEl.innerHTML = `<p class="text-xs text-danger text-center">${escapeHtml(t('recovery.listFailed'))}</p>`;
  }

  await renderRecoverySnapshots();
}


/** The safety-net snapshots, on the one screen that can still be reached when
 *  there is no user to log in as.
 *
 *  Until 2026-09-09 these were listed in Settings only, which meant they were
 *  unreachable in exactly the situation they were built for: a device whose
 *  user store came back empty. They live in their own database
 *  (`cadence-snapshots`), so they can perfectly well survive whatever emptied
 *  the main one — and each one is a full AppState, downloadable here as the
 *  same .cdb that Settings → Backup → Import accepts.
 *
 *  Read-only on purpose. Restoring from here would mean writing to a database
 *  this screen already suspects, on behalf of a user who may not exist; the
 *  download plus the ordinary import path is one machine less to get wrong. */
async function renderRecoverySnapshots(): Promise<void> {
  const host = document.getElementById('recovery-snapshots');
  if (!host) return;
  let snaps: SnapshotMeta[] = [];
  try {
    snaps = await listAllSnapshots();
  } catch (e) {
    console.error('Recovery: failed to list snapshots:', e);
    return;
  }
  if (snaps.length === 0) return;

  const title = document.createElement('p');
  title.className = 'section-title pt-4 border-t border-border';
  title.textContent = t('recovery.snapshots.title');
  host.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'text-xs text-muted';
  hint.textContent = t('recovery.snapshots.hint');
  host.appendChild(hint);

  for (const s of snaps) {
    const row = document.createElement('div');
    // Stacked below `sm`, like the user rows above.
    row.className = 'flex flex-col gap-1 p-2 rounded border border-border sm:flex-row sm:items-center sm:gap-3 sm:whitespace-nowrap';

    const when = document.createElement('span');
    when.className = 'text-xs font-mono text-muted shrink-0 whitespace-nowrap';
    when.textContent = new Date(s.ts).toISOString().slice(0, 16).replace(String.fromCharCode(84), " ");

    const what = document.createElement('span');
    what.className = 'text-sm min-w-0 sm:truncate sm:flex-1';
    what.textContent = t('recovery.snapshots.summary', { cards: s.cards, reviews: s.reviews, reason: s.reason });

    const who = document.createElement('span');
    who.className = 'text-xs text-dim font-mono select-all shrink-0 whitespace-nowrap';
    who.textContent = s.userId;

    const btn = document.createElement('button');
    btn.className = 'btn-ghost text-xs shrink-0 inline-flex items-center gap-1.5 self-start sm:self-auto';
    btn.innerHTML = EXPORT_SVG + escapeHtml(t('recovery.download'));
    btn.onclick = () => {
      void runDownload(btn, t('recovery.download'), async () => {
        const state = await getSnapshotState(s.key);
        if (!state) { alert(t('recovery.snapshotUnreadable')); return false; } // ui-ok: the recovery screen has no ModalHost (plain DOM, before any Preact root)
        // id stripped, exactly like the per-user download above: it is
        // device-local, and the import path assigns its own.
        const { id: _id, ...data } = state as unknown as Record<string, unknown> & { id?: string };
        downloadCadenceFile(JSON.stringify(data), "cadence-snapshot-" + s.userId + "-" + s.ts + ".cdb");
        return true;
      });
    };

    row.append(when, what, who, btn);
    host.appendChild(row);
  }
}

/** One user's library as a .cdb, with every attachment this device holds put
 *  back inside it.
 *
 *  The reading and the re-encoding are done here rather than through
 *  attachmentStore, on purpose: that module resolves through Drive, asks for
 *  tokens, and expects the app to have started. None of those are available on
 *  this screen, and none of them are wanted — what is on this device is what
 *  this device can give.
 *
 *  Anything that cannot be filled in stays exactly as it is, reference and
 *  all: it is still the truth about that attachment, and it is what lets the
 *  file be repaired later on a device that does have the bytes. */
async function downloadUserData(
  id: string, safeName: string, user: Awaited<ReturnType<typeof loadUser>>,
): Promise<boolean> {
  const { id: _id, ...data } = (user ?? { id }) as Record<string, unknown> & { id?: string };
  try {
    const held = await rawAttachmentBlobs(id);
    if (held && held.size > 0) {
      const cards = (data['cards'] ?? {}) as Record<string, { content?: { attachments?: Array<Record<string, unknown>> } }>;
      for (const card of Object.values(cards)) {
        for (const att of card.content?.attachments ?? []) {
          const external = att['external'] as { id?: string } | undefined;
          if (att['type'] !== 'file' || !external?.id) continue;
          const blob = held.get(external.id);
          if (!blob) continue;
          att['data'] = await blobToBase64(blob);
          delete att['external'];
        }
      }
    }
  } catch (e) {
    // A file of references is still worth having, and far better than no
    // download at all on a screen someone reached because nothing works.
    console.warn('Recovery: could not inline attachments', e);
  }
  downloadCadenceFile(JSON.stringify(data), `cadence-user-${safeName}-${id}.cdb`);
  return true;
}

/** Chunked: spreading a multi-megabyte array into fromCharCode blows the
 *  argument limit — the trap utils' arrayBufferToBase64 documents. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Every audio this user has on this device, zipped: finalized sessions,
 *  imports, and crash-orphaned recordings reassembled from their chunks. A
 *  raw DB dump was useless here — Blobs JSON-serialize to {} — where actual
 *  files play anywhere. Session names come from AppState metadata when
 *  available, from the local draft otherwise, from the id as a last resort. */
async function downloadSessionAudioZip(id: string, safeName: string, user: Awaited<ReturnType<typeof loadUser>>): Promise<boolean> {
  try {
    const collected = await collectUserSessionAudio(id);
    if (!collected || (collected.audio.length === 0 && collected.orphans.length === 0)) {
      alert(t('recovery.noAudio')); // ui-ok: the recovery screen has no ModalHost (plain DOM, before any Preact root)
      return false;
    }
    const metaSessions = ((user?.modules?.['tune-analyser'] as { sessions?: Record<string, { name?: string; mimeType?: string }> } | undefined)?.sessions) ?? {};
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
    const seen = new Map<string, number>();
    const unique = (base: string): string => {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}-${n}`;
    };
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    for (const { sessionId, blob } of collected.audio) {
      const meta = metaSessions[sessionId];
      const nice = clean(meta?.name ?? collected.draftNames[sessionId] ?? sessionId);
      const ext = audioExtension(blob.type || meta?.mimeType || collected.draftMimes[sessionId]);
      entries.push({ name: `${unique(nice)}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    for (const { recordingId, blob } of collected.orphans) {
      const nice = clean(collected.draftNames[recordingId] ?? recordingId);
      const ext = audioExtension(blob.type || collected.draftMimes[recordingId]);
      entries.push({ name: `recovered-${unique(nice)}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const zip = buildZip(entries);
    downloadBlob(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }), `cadence-audio-${safeName}-${id}.zip`);
    return true;
  } catch (e) {
    console.error('Recovery: audio zip failed:', e);
    alert(t('recovery.audioFailed', { message: e instanceof Error ? e.message : String(e) })); // ui-ok: the recovery screen has no ModalHost (plain DOM, before any Preact root)
    return false;
  }
}

// Same icon as the "Export" button in settingsModal.ts, for the same action.
const EXPORT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

/** Every download on the recovery screen says that it happened. A user pressed
 *  "Data" five times in four minutes (2026-09-17: five identical files in his
 *  Downloads) because nothing on screen changed — and a browser never reports
 *  a download as finished, so "handed over" is the most this can honestly
 *  claim. The busy state also stops the slow ones (a zip of hours of audio)
 *  being started twice. */
async function runDownload(btn: HTMLButtonElement, label: string, action: () => Promise<boolean>, icon = true): Promise<void> {
  const show = (text: string) => { btn.innerHTML = (icon ? EXPORT_SVG : '') + escapeHtml(text); };
  btn.disabled = true;
  show(t('recovery.preparing'));
  let ok = false;
  try { ok = await action(); } finally {
    btn.disabled = false;
    show(ok ? t('recovery.handedOver', { label }) : label);
  }
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, c => map[c]!);
}

/** Best-effort dump of every object store across every user (see db.ts) —
 *  works even when per-user listing above failed, since it reads via cursors
 *  on the raw IndexedDB API instead of through the (possibly broken) idb/User
 *  layer. */
async function downloadRawDump(message: string | null): Promise<boolean> {
  try {
    const dump = await dumpRawDatabase();
    const filename = `cadence-raw-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    downloadJson({ error: message, userAgent: navigator.userAgent, capturedAt: new Date().toISOString(), data: dump }, filename);
    return true;
  } catch (dumpErr) {
    console.error('Failed to generate raw dump:', dumpErr);
    alert(t('recovery.rawFailed')); // ui-ok: the recovery screen has no ModalHost (plain DOM, before any Preact root)
    return false;
  }
}

/** Opens a prefilled GitHub issue; the user still needs to manually drag in
 *  whichever downloaded file(s) apply. */
function reportBug(message: string | null): void {
  const title = message ? `Boot crash: ${message}` : 'Bug report';
  const body =
    `Please drag in the file(s) you downloaded from the Recovery screen.\n\n` +
    (message ? `Technical error:\n\`\`\`\n${message}\n\`\`\`\n\n` : '') +
    `What were you doing right before this happened?\n`;
  window.open(
    `https://github.com/Batpapa/Cadence/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
    '_blank', 'noopener'
  );
}

function downloadJson(data: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), filename);
}
