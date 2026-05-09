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
  plugins: [],
};
