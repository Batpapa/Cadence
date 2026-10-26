// ── The widget's own glyphs ───────────────────────────────────────────────────
// The gear, the tuning fork and the Cadence mark are the app's
// (components/icons.tsx). The export arrow is the analyser's export trigger
// (sessionUiShared.tsx's SHARE_ICON_TRIGGER), redrawn here as a component:
// that file reaches for the user's cards, and this page cannot load it.

export { GearIcon, CadenceLogo, TuningForkIcon, ResetIcon } from '../components/icons';

export function ExportIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
