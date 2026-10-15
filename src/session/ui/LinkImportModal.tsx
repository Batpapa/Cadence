import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import { t } from '../../services/i18nService';
import { focusIfDesktop, formatBytes } from '../../utils';
import { showModal, closeModal, renderModalBody, alertModal } from '../../components/modal';
import { safeExternalUrl } from '../../services/embedService';
import {
  probeRemoteFile, fetchRemoteFile, refusalMessage, RemoteFileError, MAX_REMOTE_ANALYSIS_BYTES,
} from '../../services/remoteFile';

// ── Importing a recording from a link (2026-10-15, group feedback) ───────────
// The analyser takes a file; this fetches one from its address first, then
// hands it to the very import a picked file goes through. Asked for as "import
// an audio or video link", beside "import a file".
//
// A DIRECT link to a file only. A page that plays a recording — any site's
// player, a share link — holds no file to read, and getting the sound out of
// such pages would take a server per site and go against their terms (the
// user's call, 2026-10-14). The dialog says so in general terms rather than
// naming sites (the user's call, 2026-10-15): the refusal is about what the
// address leads to, whoever serves it.
//
// What can be read is remoteFile.ts's business, and the same as for a link
// opened in the viewers: any server from the Android app, which asks through
// the system's own HTTP; in a browser, only a server that lets a page read it
// (CORS). The limit is higher, the analyser reading a Blob in pieces.

/** Long enough that typing a URL by hand is one request, short enough that a
 *  paste reads as answered at once — the link dialog's own. */
const CHECK_DELAY_MS = 400;

type Check =
  | { url: string; state: 'pending' }
  | { url: string; state: 'ok'; name: string }
  | { url: string; state: 'bad'; message: string };

const isRecording = (mime: string) => mime.startsWith('audio/') || mime.startsWith('video/');

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Why this address cannot be imported, in words. */
function messageFor(e: unknown): string {
  if (!(e instanceof RemoteFileError)) return t('embed.error');
  // A web page, or a file of a kind the viewers would open: said for THIS
  // dialog, which takes recordings only — the viewers' wording lists
  // everything they open, platforms included.
  if (e.refusal.why === 'unsupported') return t('sessions.link.notRecording');
  return refusalMessage(e.refusal, MAX_REMOTE_ANALYSIS_BYTES);
}

async function checkUrl(url: string, signal: AbortSignal): Promise<Check> {
  try {
    const head = await probeRemoteFile(url, { signal, maxBytes: MAX_REMOTE_ANALYSIS_BYTES });
    if (!isRecording(head.mimeType)) return { url, state: 'bad', message: t('sessions.link.notRecording') };
    return { url, state: 'ok', name: head.name };
  } catch (e) {
    if (isAbort(e)) throw e;
    return { url, state: 'bad', message: messageFor(e) };
  }
}

function LinkImportBody({ chosen, disabled, onSubmit }: {
  /** What the footer's button imports: the URL whose check passed. */
  chosen: { url: string; name: string };
  disabled: Signal<boolean>;
  onSubmit: () => void;
}) {
  const [url, setUrl] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Deferred, and not on a phone: see addLinkModal's same line.
  useLayoutEffect(() => { if (inputRef.current) focusIfDesktop(inputRef.current); }, []);

  // Checked as it is typed, as in the link dialog: a refusal is said while the
  // address is still in front of the user, not after a download.
  const trimmed = url.trim();
  useEffect(() => {
    if (trimmed === '') { setCheck(null); return; }
    const valid = safeExternalUrl(trimmed) !== null;
    if (valid) setCheck({ url: trimmed, state: 'pending' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      if (!valid) { setCheck({ url: trimmed, state: 'bad', message: t('embed.badUrl') }); return; }
      checkUrl(trimmed, ctrl.signal).then(setCheck, () => { /* superseded */ });
    }, CHECK_DELAY_MS);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [trimmed]);

  const current = check?.url === trimmed ? check : null;
  // After render, every render: the footer reads these in another tree.
  useLayoutEffect(() => {
    if (current?.state === 'ok') { chosen.url = current.url; chosen.name = current.name; }
    disabled.value = current?.state !== 'ok';
  });

  return (
    <div class="space-y-3">
      <p class="text-sm text-muted leading-relaxed">{t('sessions.link.intro')}</p>
      <div>
        <label class="label">{t('embed.url')}</label>
        <input
          ref={inputRef}
          type="url"
          class="input text-xs"
          placeholder={t('embed.placeholder')}
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !disabled.value) { e.preventDefault(); onSubmit(); } }}
        />
      </div>
      {current?.state === 'pending' && <p class="text-xs text-dim">{t('embed.checking')}</p>}
      {current?.state === 'ok' && <p class="text-xs text-success">{t('sessions.link.found', { name: current.name })}</p>}
      {current?.state === 'bad' && <p class="text-xs text-danger">{current.message}</p>}
    </div>
  );
}

/** Downloads the recording, with its progress and a way to stop, then hands
 *  it on as the File a picked one would have been. */
function download(url: string, name: string, onFile: (file: File) => void): void {
  const ctrl = new AbortController();
  let walkedAway = false;
  const giveUp = () => { walkedAway = true; ctrl.abort(); };

  const body = document.createElement('div');
  body.className = 'space-y-2';
  const said = document.createElement('p');
  said.className = 'text-sm text-muted leading-relaxed';
  let host = url;
  try { host = new URL(url).host; } catch { /* the URL is what there is */ }
  said.textContent = t('sessions.link.downloading', { name, host });
  const progress = document.createElement('p');
  progress.className = 'text-xs text-dim font-mono';
  body.append(said, progress);

  // closeModal only pops, it does not run onDismiss: the Cancel button gives
  // up itself, the ✕, Escape and the back gesture through onDismiss.
  showModal(t('sessions.link.downloadingTitle'), body, [
    { label: t('common.cancel'), onClick: () => { giveUp(); closeModal(); } },
  ], { onDismiss: giveUp });

  fetchRemoteFile(url, {
    signal: ctrl.signal,
    maxBytes: MAX_REMOTE_ANALYSIS_BYTES,
    onProgress: (received, total) => {
      progress.textContent = total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received);
    },
  }).then((remote) => {
    if (walkedAway) return;
    closeModal();
    // The server's Last-Modified stands in for a local file's date, which
    // dates the analysis (fileStartDate). None said: now, which that function
    // reads as "unknown" rather than as a start time.
    onFile(new File([remote.blob], remote.name, { type: remote.blob.type, lastModified: remote.lastModified ?? Date.now() }));
  }).catch((e: unknown) => {
    if (walkedAway) return;
    closeModal();
    if (!(e instanceof RemoteFileError)) console.warn('[sessions] could not download ' + url, e);
    alertModal(t('sessions.link.title'), messageFor(e));
  });
}

/** The dialog behind "Import a link". `onFile` gets the downloaded recording. */
export function showLinkImportModal(onFile: (file: File) => void): void {
  const disabled = signal(true);
  const chosen = { url: '', name: '' };
  const go = () => {
    if (disabled.value) return;
    leave();
    download(chosen.url, chosen.name, onFile);
  };
  const { el, cleanup } = renderModalBody(<LinkImportBody chosen={chosen} disabled={disabled} onSubmit={go} />);
  const leave = () => { closeModal(); cleanup(); };
  showModal(t('sessions.link.title'), el, [
    { label: t('common.cancel'), onClick: leave },
    { label: t('sessions.link.import'), primary: true, disabled, onClick: go },
  ], { maxWidth: '28rem', onDismiss: cleanup });
}
