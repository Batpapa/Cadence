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
      // ⚠️ Not switched on globally (tailwind's `future.hoverOnlyWhenSupported`)
      // on purpose: two controls in this app are REVEALED by hover and nothing
      // else — the delete-user ✕ (appRoot.tsx) and the remove-tag ✕
      // (views/card.tsx), both `opacity-0/hidden group-hover:`. Today a touch
      // user reaches them precisely BECAUSE hover sticks. Turning the flag on
      // would make them unreachable on a phone, so they need their own way in
      // first.
      addVariant('hoverable', '@media (hover: hover) { &:hover }');
    }),
  ],
};
