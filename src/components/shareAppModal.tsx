import { useEffect, useState } from 'preact/hooks';
import { showModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';
import { ShareIcon } from './icons';

// ── "Share Cadence" ──────────────────────────────────────────────────────────
// From a festival report (2026-09-09): the address appeared NOWHERE in the
// interface, and an installed PWA has no address bar — so someone who wanted to
// pass Cadence on to the person beside them had literally nothing to give.
//
// The QR is the point of this modal, not decoration: at a session you hold out
// a phone and the other person scans it, with no network round-trip and nothing
// to spell out loud over music. The link and the share sheet cover the case
// where the person is not in the room.

/** The address to hand out. Deliberately NOT `location.href`, which can carry a
 *  query (?mode=recovery), a deep path, or whatever redirect domain the visitor
 *  happened to arrive through — none of which is what you want to give someone.
 *  One source of truth, the <link rel="canonical"> already in index.html, so a
 *  future move of the app is a one-line change there. */
function appUrl(): string {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  return canonical || new URL('.', location.href).href;
}

const PLATE_PX = 216;
/** Modules the QR spec wants clear all around the symbol. Scanners genuinely
 *  need it — a code cropped to its own edge often will not read at all. */
const QUIET_ZONE = 4;

function QrCode({ text }: { text: string }) {
  const [code, setCode] = useState<{ path: string; span: number } | null>(null);

  useEffect(() => {
    let alive = true;
    // Loaded on demand: an encoder nothing else in the app needs, behind a modal
    // that is opened rarely. A failure here is deliberately silent — the link
    // below is the actual payload, and the code only makes handing it over in
    // person easier.
    void import('qrcode-generator')
      .then(({ default: qrcode }) => {
        if (!alive) return;
        const qr = qrcode(0, 'M');   // 0 = pick the smallest version that fits
        qr.addData(text);
        qr.make();
        const span = qr.getModuleCount();
        let path = '';
        for (let row = 0; row < span; row++) {
          for (let col = 0; col < span; col++) {
            if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
          }
        }
        setCode({ path, span });
      })
      .catch(() => { /* link-only, see above */ });
    return () => { alive = false; };
  }, [text]);

  // Black on white in BOTH themes, on purpose — a scanner needs dark modules on
  // a light ground, so a QR that followed the theme would simply stop working
  // for every user in dark mode. This is the one element on the page that must
  // not be themed.
  return (
    <div
      class="mx-auto rounded-xl bg-white flex items-center justify-center"
      style={{ width: PLATE_PX, height: PLATE_PX }}
    >
      {code && (
        <svg
          width={PLATE_PX - 16} height={PLATE_PX - 16}
          viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${code.span + QUIET_ZONE * 2} ${code.span + QUIET_ZONE * 2}`}
          shape-rendering="crispEdges"
          role="img"
          aria-label={t('shareApp.qrAlt')}
        >
          <path d={code.path} fill="#000" />
        </svg>
      )}
    </div>
  );
}

function ShareAppBody() {
  const url = appUrl();
  const [copied, setCopied] = useState(false);
  // Absent on Firefox desktop among others, so the share sheet can never be the
  // only way out of this modal — the link and its copy button always are.
  const canShare = typeof navigator.share === 'function';

  const copy = () => {
    // Optional chaining short-circuits the whole chain: no clipboard (an
    // insecure context) means no feedback rather than a thrown error, and the
    // address stays selectable by hand right above.
    navigator.clipboard?.writeText(url).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      () => { /* denied — the address is selectable */ },
    );
  };

  const share = () => {
    void navigator.share({ title: t('shareApp.title'), url }).catch(() => { /* dismissed */ });
  };

  return (
    <div class="space-y-4">
      <QrCode text={url} />

      <div class="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2">
        {/* select-all: one tap/click takes the whole address, which is the
            fallback whenever the clipboard API is unavailable or refused. */}
        <span class="flex-1 min-w-0 font-mono text-xs text-primary break-all select-all">{url}</span>
        <button
          class="btn-ghost text-xs shrink-0 px-2 py-1 border border-border rounded-md"
          onClick={copy}
        >
          {copied ? t('shareApp.copied') : t('shareApp.copy')}
        </button>
      </div>

      {canShare && (
        <button class="btn-primary w-full text-sm flex items-center justify-center gap-2" onClick={share}>
          <ShareIcon size={14} />
          {t('shareApp.share')}
        </button>
      )}

      <p class="text-xs text-muted text-center leading-relaxed">{t('shareApp.hint')}</p>
    </div>
  );
}

export function showShareAppModal(): void {
  const { el, cleanup } = renderModalBody(<ShareAppBody />);
  showModal(t('shareApp.title'), el, [], { maxWidth: '20rem', onDismiss: cleanup });
}
