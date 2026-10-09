import { render } from 'preact';
import { signal, type Signal } from '@preact/signals';
import { CadenceMark } from '../components/cadenceMark';
import { t } from '../services/i18nService';

/**
 * The Android app's "downloading the update" screen (2026-10-09): shown at a
 * page start while a deployed update is fetched, so that reopening the app or
 * pulling to refresh brings the new version, as it does in the PWA. In the
 * welcome screen's manner — its mark, and a line below.
 *
 * Two steps. At once, the theme's background and nothing else (the user's
 * choice): on a good connection that is all anyone sees, a launch a moment
 * longer than usual. Then, if the download is still going (`detail()`), the
 * mark drawn in a loop, what is happening, how far along, and a way out — a
 * way to start on the version already here.
 *
 * Drawn into the app's root before anything else is: the caller clears it, and
 * the app then renders there as usual.
 */

// The device's own way of writing it ("42 %" in French, "42%" in English).
const PERCENT = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });

function UpdateOverlay({ percent, detailed, onLater }: {
  percent: Signal<number | null>;
  detailed: Signal<boolean>;
  onLater: () => void;
}) {
  const p = percent.value;
  const shown = detailed.value;

  return (
    <div class="fixed inset-0 bg-bg flex items-center justify-center">
      <div
        class={`w-full max-w-[352px] mx-4 flex flex-col items-center text-center transition-opacity duration-500 ${shown ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        aria-hidden={!shown}
      >
        {/* Not drawn before it shows: the loop starts when it can be seen. */}
        <div class="mb-[22px] w-[78px] h-[78px]">{shown && <CadenceMark size={78} looping />}</div>
        <div>
          <p class="text-[15px] text-primary">{t('update.downloading.title')}</p>
          <p class="text-[13.5px] text-muted mt-1.5">
            {t('update.downloading.wait')}
            {/* The plugin's own figure, as it gives it: its whole job, the
                transfer being 10 to 70 and the checksum, unzip and install
                the rest (a second or so). Nothing before the first figure. */}
            {p !== null && p > 0 && p < 100 && <span class="tabular-nums"> {PERCENT.format(p / 100)}</span>}
          </p>
          <button class="btn-ghost text-sm mt-6" disabled={!shown} onClick={onLater}>
            {t('update.downloading.later')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface UpdateOverlayHandle {
  /** From the plain background to the full screen. */
  detail(): void;
  progress(percent: number): void;
  close(): void;
}

export function showUpdateOverlay(root: HTMLElement, onLater: () => void): UpdateOverlayHandle {
  const percent = signal<number | null>(null);
  const detailed = signal(false);
  // The legal footer belongs to the welcome and recovery screens (styles.css);
  // AppRoot or the welcome screen set this class again for themselves after.
  const html = document.documentElement;
  const hadAppOpen = html.classList.contains('app-open');
  html.classList.add('app-open');
  render(<UpdateOverlay percent={percent} detailed={detailed} onLater={onLater} />, root);
  return {
    detail: () => { detailed.value = true; },
    progress: (p) => { percent.value = p; },
    close: () => {
      render(null, root);
      if (!hadAppOpen) html.classList.remove('app-open');
    },
  };
}
