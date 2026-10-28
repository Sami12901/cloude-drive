/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          base: token('--c-surface-base'),
          raised: token('--c-surface-raised'),
          overlay: token('--c-surface-overlay'),
          border: token('--c-surface-border'),
          hover: token('--c-surface-hover'),
        },
        content: {
          primary: token('--c-content-primary'),
          secondary: token('--c-content-secondary'),
          muted: token('--c-content-muted'),
        },
        accent: {
          DEFAULT: token('--c-accent'),
          soft: token('--c-accent-soft'),
          hover: token('--c-accent-hover'),
        },
        warm: {
          DEFAULT: token('--c-warm'),
          hover: token('--c-warm-hover'),
        },
        state: {
          ok: token('--c-ok'),
          warn: token('--c-warn'),
          error: token('--c-error'),
          info: token('--c-info'),
        },
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Display"', '"Segoe UI"', 'system-ui', '-apple-system', 'Arial', 'sans-serif'],
        mono: ['"Cascadia Mono"', 'Consolas', '"Courier New"', 'monospace'],
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-up': 'slide-up 160ms ease-out',
      },
    },
  },
  plugins: [],
};
