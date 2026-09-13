const plugin = require('tailwindcss/plugin');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts,tsx}'],
  // Every `hover:` in the app compiles behind `@media (hover: hover)`, so a
  // touch screen — which has no pointer to move away, and therefore leaves
  // :hover stuck on whatever was tapped last — simply never applies them.
  // Switched on 2026-09-13; what had been blocking it until then is in the
  // note on `hoverable:` below.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: {
        bg:             'rgb(var(--color-bg-ch) / <alpha-value>)',
        surface:        'rgb(var(--color-surface-ch) / <alpha-value>)',
        elevated:       'rgb(var(--color-elevated-ch) / <alpha-value>)',
        border:         'rgb(var(--color-border-ch) / <alpha-value>)',
        muted:          'rgb(var(--color-muted-ch) / <alpha-value>)',
        dim:            'rgb(var(--color-dim-ch) / <alpha-value>)',
        primary:        'rgb(var(--color-primary-ch) / <alpha-value>)',
        accent:         'rgb(var(--color-accent-ch) / <alpha-value>)',
        'accent-hover': 'var(--color-accent-hover)',
        danger:         'rgb(var(--color-danger-ch) / <alpha-value>)',
        success:        'rgb(var(--color-success-ch) / <alpha-value>)',
        warn:           'rgb(var(--color-warn-ch) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      // `hoverable:` is `hover:` for devices that actually hover.
      //
      // A touch screen has no pointer to move away, so it applies :hover to
      // whatever was tapped last and KEEPS it there until something else is
      // tapped — a chip cycled back to neutral stayed outlined in accent
      // (reported 2026-09-12). Use this wherever hover carries MEANING, i.e.
      // where a stuck hover would say something false about the state.
      //
      // `pointer: fine` as well as `hover: hover`: a few Android browsers (and
      // device emulators) claim to hover when they cannot, and the pair is the
      // combination that actually means "there is a mouse here".
      //
      // Since `future.hoverOnlyWhenSupported` was switched on (above), plain
      // `hover:` compiles to this EXACT query — Tailwind 3.4 emits the same
      // `(hover: hover) and (pointer: fine)` string — so the two are synonyms
      // today and `hover:` is safe everywhere. Measured on the built CSS the
      // day the flag went on: 45 hover rules gated, 4 left out, and those four
      // are hand-written CSS the flag cannot reach (a scrollbar thumb, a
      // markdown row, an abcjs button, the spoiler border — all decorative,
      // and the spoiler reveals on CLICK).
      //
      // Kept rather than folded into `hover:`, for one reason: the flag's
      // wording belongs to Tailwind and can change under an upgrade, this line
      // belongs to us. So the hovers that carry MEANING go on saying so, and
      // keep their `pointer: fine` half whatever a future version decides.
      //
      // What blocked that flag until 2026-09-13: two controls revealed by hover
      // and by nothing else, so a finger reached them only BECAUSE hover sticks
      // — the delete-user ✕ (now a button in Settings → User) and the remove-tag
      // ✕ (now a button on the card's tag heading). What is left on
      // `group-hover:` is decorative: the ⠿ drag handles, whose row is the drag
      // target and which long-press dragging never needed, and two checkboxes
      // that sit at 40% rather than 0.
      addVariant('hoverable', '@media (hover: hover) and (pointer: fine) { &:hover }');
    }),
  ],
};
