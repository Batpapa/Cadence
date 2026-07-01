import { render } from 'preact';
import type { ComponentType } from 'preact';

/** Renders a Preact icon component into a detached DOM element.
 *  For use in vanilla TS files that cannot use JSX syntax. */
export function iconElement(Comp: ComponentType<{ size?: number }>, size?: number): Element {
  const wrap = document.createElement('span');
  render(<Comp size={size} />, wrap);
  return wrap.firstElementChild ?? wrap;
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

export function UnlinkIcon({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
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

export function PanelLeftIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M9 3v18"/>
    </svg>
  );
}
