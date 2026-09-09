import { useEffect, useState } from 'preact/hooks';
import { showModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';
import { ShareIcon, WhatsAppIcon, ExternalLinkIcon } from './icons';

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

/** The Cadence Community group. Handed over by the author on 2026-09-09; a
 *  WhatsApp invite link stays valid until it is explicitly reset from the
 *  group settings, at which point THIS LINE is the single place to change.
 *  Not in i18n: it is an address, not a translated string, and duplicating it
 *  per locale is how one copy quietly goes stale. */
const COMMUNITY_URL = 'https://chat.whatsapp.com/IrkMyOn07niE9Xjvtj6qKQ';

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
          {copied ? t('common.copied') : t('shareApp.copy')}
        </button>
      </div>

      {canShare && (
        <button class="btn-primary w-full text-sm flex items-center justify-center gap-2" onClick={share}>
          <ShareIcon size={14} />
          {t('shareApp.share')}
        </button>
      )}

      {/* A rule, because what follows is a different act from the three above:
          they hand Cadence to someone standing next to you, this one joins a
          group. Same modal all the same — "pass it on" and "come talk to us"
          are the two things a person reaches for after a good session, and a
          second entry point in the header would cost more than it returns. */}
      <div class="h-px bg-border" />

      {/* Tinted WhatsApp green rather than the theme accent, same exception and
          same reason as WhatsAppIcon in icons.tsx: the colour is a promise about
          where the link goes.
          These four values are Tailwind arbitrary classes and NOT an inline
          `style`, despite being one-off colours. An inline style would win on
          specificity over any `hover:` class, so the card would simply never
          light up — the rest state has to live in a class for the hover state to
          be able to replace it. */}
      <a
        href={COMMUNITY_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="flex flex-col gap-3 rounded-[10px] p-3.5 border transition-colors
               border-[rgba(37,211,102,.28)] bg-[rgba(37,211,102,.07)]
               hover:border-[rgba(37,211,102,.6)] hover:bg-[rgba(37,211,102,.12)]"
      >
        {/* items-START, not center. An earlier version centred the badge against
            the whole block, so when the hint wrapped to a second line the badge
            landed opposite the gap between the two and the row read as crooked.
            Centring only ever looks right at one exact line count, which no
            translated string can be relied on to hold. Anchored to the title,
            the row survives any number of hint lines. */}
        <span class="flex items-start gap-2.5">
          {/* Nudged down to sit on the title's optical centre rather than its
              cap height, which reads as aligned where a flush top does not. */}
          <span class="shrink-0 mt-px"><WhatsAppIcon size={32} /></span>
          <span class="flex-1 min-w-0">
            <span class="block text-sm font-medium text-primary">{t('shareApp.community')}</span>
            {/* text-pretty, because at 20rem the hint wraps and the default
                algorithm is happy to leave one word alone on the last line. */}
            <span class="block text-xs text-muted leading-snug text-pretty">
              {t('shareApp.communityHint')}
            </span>
          </span>
        </span>

        {/* A span, not a button: it already sits inside the anchor, and nesting
            interactive elements is invalid and breaks keyboard navigation.
            Very dark green on the brand green, NOT white — white on #25D366 is
            1.98:1 and unreadable, this pairing is 7.4:1. Inline style is safe
            here precisely because this element has no hover state of its own. */}
        <span
          class="flex items-center justify-center gap-1.5 rounded-md px-3 py-[7px] text-[13px] font-semibold"
          style={{ background: '#25D366', color: '#062f16' }}
        >
          {t('shareApp.communityCta')}
          <ExternalLinkIcon size={11} />
        </span>
      </a>
    </div>
  );
}

export function showShareAppModal(): void {
  const { el, cleanup } = renderModalBody(<ShareAppBody />);
  showModal(t('shareApp.title'), el, [], { maxWidth: '20rem', onDismiss: cleanup });
}
