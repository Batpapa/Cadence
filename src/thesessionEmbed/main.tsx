// FIRST: every URL the modules below build depends on it (see the file).
import './publicPath';
import { render } from 'preact';
import type { Lang } from '../services/i18nService';
import type { SourceKind } from './tuneFinder';
import { FinderWidget } from './FinderWidget';
import './embed.css';

// ── thesession-embed: Cadence's tune recognition as a widget for The Session ──
// Served at TuneAnalyser/thesession-embed/ and meant to sit in an iframe:
//
//   <iframe src="https://batpapa.github.io/Cadence/TuneAnalyser/thesession-embed/?links=same"
//     allow="microphone" title="Identify tunes" style="…"></iframe>
//
// The same two parameters as the widget The Session embeds today, so trying
// this one is a matter of changing the src:
//   theme=dark|auto  — light otherwise: the embedding page decides, and knows
//                      its visitor's choice, which the frame cannot read.
//                      `auto` follows the system;
//   links=same       — tune links open in the embedding page, not a new tab;
//   lang=fr          — French; English otherwise (The Session is in English);
//   sources=…        — the tabs offered, in that order, among mic, device,
//                      file and link. mic,file by default: what Jeremy keeps
//                      for The Session (2026-10-25). `device` (the
//                      computer's sound) also needs allow="display-capture" on
//                      the iframe, and says so without it;
//   sets=on          — the "sets" box ticked from the start (off otherwise);
//   tools=on         — each analysis's gear (sets, timings) and export menus,
//                      and a clip per tune and per set. Off by default: Jeremy
//                      finds them overkill for The Session (2026-10-25).
//
// Nothing here reads or writes the app's data: no user, no AppState, no
// Drive. The only storage touched is the shared tune-index cache
// (`cadence-sessions`), which inside a third-party frame is partitioned by the
// browser under the embedding site anyway.

const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme !== 'auto') document.documentElement.classList.add(theme === 'dark' ? 'dark' : 'light');
const lang: Lang = params.get('lang') === 'fr' ? 'fr' : 'en';
const ALL_SOURCES: SourceKind[] = ['mic', 'device', 'file', 'link'];
const DEFAULT_SOURCES: SourceKind[] = ['mic', 'file'];
const asked = (params.get('sources') ?? '').split(',').filter((s): s is SourceKind => (ALL_SOURCES as string[]).includes(s));
const sources = asked.length > 0 ? [...new Set(asked)] : DEFAULT_SOURCES;
const sets = params.get('sets') === 'on';
document.documentElement.lang = lang === 'fr' ? 'fr' : 'en-ie';

// The Session's type size: `font-size: clamp(100%, 50% + .675vi, 150%)` on its
// root — it grows with the width of the WINDOW, ~21 px at 1920. In here `vi`
// would be the frame's 536 px and leave the text at 16 px, visibly smaller
// than the page around it, while their iframe's own height (5.75rem) grows
// with their root. outerWidth is the browser window's, readable from a frame:
// the same formula on it gives the same size, and keeps everything in rem
// fitting the frame they size in rem.
function matchTheSessionType(): void {
  const w = window.outerWidth || document.documentElement.clientWidth;
  document.documentElement.style.fontSize = `clamp(100%, calc(50% + ${(w * 0.00675).toFixed(2)}px), 150%)`;
}
matchTheSessionType();
addEventListener('resize', matchTheSessionType);

render(
  <FinderWidget opts={{ lang, sameTab: params.get('links') === 'same', sources, sets, tools: params.get('tools') === 'on' }} />,
  document.getElementById('finder')!,
);
