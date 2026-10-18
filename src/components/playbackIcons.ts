// ── Playback control icons ────────────────────────────────────────────────────
// Inline SVG strings for vanilla-DOM buttons. Text glyphs ('▶', '⏸', '■'…) are
// rendered as emoji by mobile browsers — never use them for controls.

export const playIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21"/></svg>`;

export const pauseIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>`;

export const stopIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>`;

/** Back to a point: a bar, then a triangle pointing at it. */
export const rewindIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="3" height="16" rx="1"/><polygon points="20 4 9 12 20 20"/></svg>`;

export const repeatIcon =(size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

/** A passage's start `[←` or end `→]`: the end is the start mirrored, so the
 *  two cannot differ. They were text, and IBM Plex ships without ← and → in
 *  its latin subset: the phone's own font drew them, lopsided on some Android
 *  devices (2026-10-16). */
export const boundIcon = (side: 'in' | 'out', size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g${side === 'out' ? ' transform="matrix(-1 0 0 1 24 0)"' : ''}><path d="M7 4H4v16h3"/><path d="M20 12H9"/><polyline points="13 8 9 12 13 16"/></g></svg>`;

export const downloadIcon =(size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
