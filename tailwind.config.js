const plugin = require('tailwindcss/plugin');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts,tsx}'],
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
      // Tailwind's `future.hoverOnlyWhenSupported` would do this globally, and
      // as of 2026-09-13 NOTHING BLOCKS IT ANY MORE — it is simply a decision
      // nobody has taken yet, and one worth verifying in a browser when it is.
      // What used to block it: two controls revealed by hover and by nothing
      // else, so a finger reached them only BECAUSE hover sticks to the last
      // thing tapped — the delete-user ✕ (now a button in Settings → User) and
      // the remove-tag ✕ (now a button on the card's tag heading). What is left
      // on `group-hover:` is decorative: the ⠿ drag handles, whose row is the
      // drag target, and two checkboxes that sit at 40% rather than 0.
      // `pointer: fine` as well as `hover: hover`: a few Android browsers (and
      // device emulators) claim to hover when they cannot, and the pair is the
      // combination that actually means "there is a mouse here".
      addVariant('hoverable', '@media (hover: hover) and (pointer: fine) { &:hover }');
    }),
  ],
};
