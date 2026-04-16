/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        surface: '#141414',
        elevated: '#1e1e1e',
        border: '#252525',
        muted: '#888888',
        dim: '#555555',
        primary: '#e8e8e8',
        accent: '#8b7cf8',
        'accent-hover': '#7c6af7',
        danger: '#f87171',
        success: '#4ade80',
        warn: '#fbbf24',
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
