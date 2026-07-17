// ── Playback control icons ────────────────────────────────────────────────────
// Inline SVG strings for vanilla-DOM buttons. Text glyphs ('▶', '⏸', '■'…) are
// rendered as emoji by mobile browsers — never use them for controls.

export const playIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21"/></svg>`;

export const pauseIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>`;

export const stopIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>`;

export const repeatIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
