/** @type {import('tailwindcss').Config} */
// Los colores son variables CSS (tripletas "R G B") definidas en src/index.css para
// :root (oscuro, por defecto) y [data-theme="light"]. Así funcionan los modificadores
// de opacidad de Tailwind: bg-home/20, text-ink-2, border-line/60 ...
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: { 1: v('surface-1'), 2: v('surface-2'), 3: v('surface-3') },
        line: { DEFAULT: v('line'), strong: v('line-strong') },
        ink: { 1: v('ink-1'), 2: v('ink-2'), 3: v('ink-3') },
        accent: { DEFAULT: v('accent'), ink: v('on-accent'), text: v('accent-text') },
        home: { DEFAULT: v('home'), ink: v('on-home') },
        draw: { DEFAULT: v('draw'), ink: v('on-draw') },
        away: { DEFAULT: v('away'), ink: v('on-away') },
        win: { DEFAULT: v('win'), ink: v('on-win') },
        loss: { DEFAULT: v('loss'), ink: v('on-loss') },
        pos: v('pos'),
        neg: v('neg'),
        warn: v('warn'),
        live: v('live'),
        seq: { DEFAULT: v('seq'), ink: v('on-seq') },
      },
      fontFamily: {
        display: ['"Big Shoulders Display"', '"Arial Narrow"', 'Impact', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }], // 11px
      },
      borderRadius: {
        card: '14px',
      },
      boxShadow: {
        card: '0 1px 0 0 rgb(255 255 255 / 0.03) inset, 0 10px 30px -18px rgb(0 0 0 / 0.6)',
        pop: '0 18px 50px -12px rgb(0 0 0 / 0.55), 0 0 0 1px rgb(var(--c-line-strong) / 1)',
      },
      maxWidth: {
        page: '1360px',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'live-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 420ms cubic-bezier(0.2, 0.7, 0.2, 1) both',
        'live-pulse': 'live-pulse 1.6s ease-in-out infinite',
        shimmer: 'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [],
};
