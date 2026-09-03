import { render } from 'preact';
import type { ComponentType } from 'preact';

/** Renders a Preact icon component into a detached DOM element.
 *  For use in vanilla TS files that cannot use JSX syntax. */
export function iconElement(Comp: ComponentType<{ size?: number }>, size?: number): Element {
  const wrap = document.createElement('span');
  render(<Comp size={size} />, wrap);
  return wrap.firstElementChild ?? wrap;
}

/** HAL 9000-ish "recording in progress" marker: a pulsing outer ring plus a
 *  glowing solid core, instead of a flat dot. Shared between the header chrome
 *  and the Modules page module-picker card so both stay visually identical. */
export function RecordingPulseDot({ size = 12, onClick, title, class: className = '' }: {
  size?: number; onClick?: () => void; title?: string; class?: string;
}) {
  const c = size / 2;
  const coreR = size * 0.22;
  const ringR = size * 0.36;
  // Plain SVG, not stacked absolutely-positioned/translated <span>s: a circle's
  // center is just its cx/cy, so animating only `r` (via SMIL, not a CSS
  // transform) can never drift off-center. An earlier attempt centering
  // divs via `translate(-50%,-50%)` broke because Tailwind's `animate-ping`
  // keyframe hardcodes `transform: scale(2)`, which clobbers any translate
  // sharing that same `transform` property mid-animation.
  return (
    <span
      class={`inline-flex shrink-0 ${onClick ? 'pointer-events-auto cursor-pointer' : ''} ${className}`}
      title={title}
      onClick={onClick}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
        <circle cx={c} cy={c} r={ringR} class="fill-none stroke-danger" stroke-width="1">
          <animate attributeName="r" values={`${ringR};${size * 0.62}`} dur="1.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.8;0" dur="1.4s" repeatCount="indefinite" />
        </circle>
        <circle cx={c} cy={c} r={coreR} class="fill-danger" style={{ filter: 'drop-shadow(0 0 2px rgb(var(--color-danger-ch)))' }} />
      </svg>
    </span>
  );
}

export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 4h12"/>
      <path d="M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4"/>
      <path d="M3.5 4l.9 9a.5.5 0 0 0 .5.5h6.2a.5.5 0 0 0 .5-.5l.9-9"/>
      <path d="M6.5 7v4M9.5 7v4"/>
    </svg>
  );
}

export function HelpIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}

export function ExternalLinkIcon({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  );
}

export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

export function HomeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}

export function LibraryIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  );
}

export function SearchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

export function SettingsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

export function CloudUpIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="16 16 12 12 8 16"/>
      <line x1="12" y1="12" x2="12" y2="21"/>
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
    </svg>
  );
}

export function ChevronDownIcon({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

export function CheckIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

export function CadenceLogo({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 154 154"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="3.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <g transform="translate(-27.564509,-147.72464)">
        <path d="m 34.938038,224.24193 h 10.133205 c 1.692805,0.10418 2.467388,2.8912 3.546623,2.91329 2.519211,0.059 5.745988,-14.81212 8.23323,-14.69314 4.502632,-0.13544 4.030544,32.52667 8.866558,32.55292 4.826937,0.1718 2.180009,-18.57973 8.106564,-38.88618 4.102301,-11.90735 14.733752,-17.72954 24.461728,-19.40917 10.274454,-1.57623 18.489864,1.90532 26.287504,7.83787" />
        <path d="m 98.480177,220.92875 c 0.911732,-3.01425 2.599123,-5.4052 6.607143,-5.32315 5.03033,0.18731 8.56327,3.7084 8.82115,9.29411 0.10954,4.84835 -3.36941,9.73281 -9.25204,10.8233 -6.81755,0.98296 -15.452109,-2.92859 -17.514598,-13.7119 -1.710174,-14.80596 11.955842,-20.09785 18.376398,-20.042 12.17048,0.0505 23.53117,10.26188 23.26864,23.84318 -0.18698,16.28832 -15.16462,23.78684 -23.20916,23.95198 -11.725849,0.41409 -21.101004,-7.15282 -27.113393,-16.75287" />
        <path d="m 174.01374,224.85436 h -10.1332 c -1.69281,-0.10418 -2.46739,-2.8912 -3.54663,-2.91329 -2.51921,-0.059 -5.74599,14.81212 -8.23323,14.69314 -4.50263,0.13544 -4.03054,-32.52667 -8.86655,-32.55292 -4.82694,-0.1718 -2.18001,18.57973 -8.10657,38.88618 -4.1023,11.90735 -14.73375,17.72954 -24.46172,19.40917 -10.27446,1.57623 -18.489872,-1.90532 -26.287512,-7.83787" />
      </g>
    </svg>
  );
}

export function SortAlphaIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} stroke="none" fill="currentColor">
      <text x="12" y="17" font-size="16" font-weight="700" text-anchor="middle" font-family="IBM Plex Mono, monospace">AZ</text>
    </svg>
  );
}

export function ClockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <polyline points="12 7 12 12 16 14"/>
    </svg>
  );
}

/** A closed-but-not-yet-finalized detection: the Viterbi decoder could still
 *  retract or revise it as later windows arrive. See AnnotationCard.tsx's
 *  "pending" state. */
export function HourglassIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 2h12"/>
      <path d="M6 22h12"/>
      <path d="M6 2c0 5 5 6 6 8 1-2 6-3 6-8"/>
      <path d="M6 22c0-5 5-6 6-8 1 2 6 3 6 8"/>
    </svg>
  );
}

export function CalendarPlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="12" y1="13" x2="12" y2="18"/>
      <line x1="9.5" y1="15.5" x2="14.5" y2="15.5"/>
    </svg>
  );
}

export function StarIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2.5 15.1 8.6 22 9.6 17 14.4 18.2 21.2 12 17.9 5.8 21.2 7 14.4 2 9.6 8.9 8.6 12 2.5"/>
    </svg>
  );
}

export function HeartIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 21s-7.5-4.6-10.2-9.1C.2 8.9 1.5 5 5.2 4.2c2.1-.5 4.1.5 5.3 2.3l1.5 2.1 1.5-2.1c1.2-1.8 3.2-2.8 5.3-2.3 3.7.8 5 4.7 3.4 7.7C19.5 16.4 12 21 12 21z"/>
    </svg>
  );
}

/** Like iconElement, but for StarIcon's extra `filled` prop — a vanilla-TS
 *  caller can't pass it through iconElement's size-only signature. */
export function starIconElement(filled: boolean, size = 13): Element {
  const wrap = document.createElement('span');
  render(<StarIcon size={size} filled={filled} />, wrap);
  return wrap.firstElementChild ?? wrap;
}

export function MusicNoteIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  );
}

export function GaugeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 14a8 8 0 1 1 16 0"/>
      <line x1="12" y1="14" x2="16" y2="8"/>
      <path d="M4 18h16"/>
    </svg>
  );
}

export function FlameIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2c1 4-4 6-4 10a4 4 0 0 0 8 .5C16 9 13 7 12 2z"/>
      <path d="M12 22a6 6 0 0 0 6-6c0-1.5-.5-3-1.5-4"/>
      <path d="M12 22a6 6 0 0 1-6-6c0-1.5.5-3 1.5-4"/>
    </svg>
  );
}

export function ScatterPlotIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 3v18h18"/>
      <circle cx="9" cy="8" r="1.4" fill="currentColor" stroke="none"/>
      <circle cx="13" cy="13" r="1.4" fill="currentColor" stroke="none"/>
      <circle cx="7.5" cy="15" r="1.4" fill="currentColor" stroke="none"/>
      <circle cx="17" cy="16" r="1.4" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="7" r="1.4" fill="currentColor" stroke="none"/>
    </svg>
  );
}

// Two overlapping circles — intersection filled solid (AND)
export function VennAndIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 14" width={size} height={size} fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/>
      <circle cx="13" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/>
      <path d="M10 2.4 A5.5 5.5 0 0 1 10 11.6 A5.5 5.5 0 0 1 10 2.4Z" style="fill:currentColor;fill-opacity:0.5"/>
    </svg>
  );
}

// Two overlapping circles — union filled as single path (OR)
export function VennOrIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 14" width={size} height={size} fill="none">
      <path d="M10 2.4 A5.5 5.5 0 1 0 10 11.6 A5.5 5.5 0 1 0 10 2.4Z" style="fill:currentColor;fill-opacity:0.5"/>
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/>
      <circle cx="13" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/>
    </svg>
  );
}

export function ArrowLeftIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

export function ArrowRightIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

export function ResetIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
    </svg>
  );
}

export function WaveformIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <line x1="3"  y1="10" x2="3"  y2="14"/>
      <line x1="6"  y1="7"  x2="6"  y2="17"/>
      <line x1="9"  y1="4"  x2="9"  y2="20"/>
      <line x1="12" y1="2"  x2="12" y2="22"/>
      <line x1="15" y1="5"  x2="15" y2="19"/>
      <line x1="18" y1="8"  x2="18" y2="16"/>
      <line x1="21" y1="10" x2="21" y2="14"/>
    </svg>
  );
}

export function FileAudioIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <path d="M9 16v-3l3 1v3"/>
      <circle cx="8" cy="17" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="11" cy="18" r="1.2" fill="currentColor" stroke="none"/>
    </svg>
  );
}

export function ImportTrayIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

export function ModulesIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.2"/>
      <rect x="14" y="3" width="7" height="7" rx="1.2"/>
      <rect x="3" y="14" width="7" height="7" rx="1.2"/>
      <rect x="14" y="14" width="7" height="7" rx="1.2"/>
    </svg>
  );
}

export function MicIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3"/>
      <path d="M19 10a7 7 0 0 1-14 0"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="8" y1="22" x2="16" y2="22"/>
    </svg>
  );
}

export function PanelLeftIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M9 3v18"/>
    </svg>
  );
}

/** Rising line with a corner arrow — the trending module on the welcome
 *  screen's feature list. Not FlameIcon (which labels the module itself in
 *  views/modules.tsx): here it sits in a row of four line icons and a filled
 *  flame would break that row's weight. */
export function TrendIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
      <polyline points="16 7 22 7 22 13"/>
    </svg>
  );
}

/** A screen taking an arrow in — "put this on your device", distinct from
 *  ImportTrayIcon's plain download tray (which already means "import data").
 *  Deliberately near-square rather than tall: a portrait rectangle reads as a
 *  phone specifically, and this offer is for desktops too. */
export function InstallIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="2"/>
      <path d="M12 7v8"/>
      <polyline points="9 12 12 15 15 12"/>
    </svg>
  );
}

export function GithubIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.15 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.99 7.99 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
    </svg>
  );
}

// ── Study strategies ──────────────────────────────────────────────────────────
// One per StudyStrategy. Sized by their two callers: 20px in the strategy
// picker's tiles, 15px in the study header. The colour comes from the caller
// via currentColor (see STRATEGY_ICONS in studyModal.tsx).

/** Five pips on a die — a uniform draw. */
export function DiceIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="4"/>
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="8.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="15.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  );
}

/** Concentric rings on a filled centre — always the single best card. */
export function BullseyeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="6"/>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>
    </svg>
  );
}

/** Bars of unequal height — a draw weighted by learning gain. */
export function WeightedBarsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="2" y="12" width="5" height="10" rx="1"/>
      <rect x="9.5" y="4" width="5" height="18" rx="1"/>
      <rect x="17" y="8" width="5" height="14" rx="1"/>
    </svg>
  );
}

/** A list read top to bottom: rows on the right, a down arrow running past
 *  them on the left. Deliberately not a repeat/loop glyph — the looping is
 *  the footnote, "the deck's own order" is what the mode actually is. */
export function SequentialIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <line x1="10" y1="6" x2="21" y2="6"/>
      <line x1="10" y1="12" x2="21" y2="12"/>
      <line x1="10" y1="18" x2="21" y2="18"/>
      <path d="M4 4v15"/>
      <polyline points="1.8 16.6 4 19 6.2 16.6"/>
    </svg>
  );
}

/** A single quaver: filled head, stem, flag. Marks a card typed as one tune.
 *  The head is filled rather than outlined because at 11–14px a hollow circle
 *  at this stroke width fills in anyway, and a hollow head would read as a
 *  half note to anyone who does see it. */
export function TuneIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="7.5" cy="17.5" r="3.2" fill="currentColor" stroke="none"/>
      <path d="M10.7 17.5V4.6l6.2 2.3v3.3"/>
    </svg>
  );
}

/** Three quavers under one beam: a set. Deliberately the same note head and
 *  stroke weight as TuneIcon, so the two read as one shape repeated rather
 *  than two unrelated glyphs — "several of those" is exactly what a set is. */
export function TuneSetIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="4.4" cy="17.6" r="2.3" fill="currentColor" stroke="none"/>
      <circle cx="11.2" cy="17.6" r="2.3" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="17.6" r="2.3" fill="currentColor" stroke="none"/>
      <path d="M6.5 17.6V6.4M13.3 17.6V6.4M20.1 17.6V6.4"/>
      <path d="M6.5 6.4h13.6"/>
    </svg>
  );
}

/** Pencil — "edit this". Paired with EyeIcon on the notes toggle. */
export function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
  );
}

/** Eye — "show me the rendered result". The other half of the notes toggle. */
export function EyeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

/** Gear, filled or hollow — "this is handled automatically" vs "this is yours
 *  to set". The body and the centre hole are ONE path with `fill-rule:
 *  evenodd`, which is what keeps the hole open when the shape is filled; two
 *  separate elements would fill the hole in along with everything else. */
export function GearIcon({ size = 13, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill-rule="evenodd">
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1zM15 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0z"/>
    </svg>
  );
}
