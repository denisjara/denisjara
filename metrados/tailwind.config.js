/** @type {import('tailwindcss').Config} */
// Los colores son variables CSS (tripletas "R G B") definidas en src/index.css para el tema claro (:root) y el
// oscuro. Así funcionan los modificadores de opacidad de Tailwind: bg-accent/15, border-line/60…
const v = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        board: v('board'),
        panel: { DEFAULT: v('panel'), 2: v('panel-2'), 3: v('panel-3') },
        line: { DEFAULT: v('line'), strong: v('line-strong') },
        ink: { DEFAULT: v('ink'), 2: v('ink-2'), 3: v('ink-3') },
        accent: { DEFAULT: v('accent'), ink: v('on-accent'), soft: v('accent-soft'), text: v('accent-text') },
        danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
        warn: { DEFAULT: v('warn'), soft: v('warn-soft') },
        ok: v('ok'),
      },
      fontFamily: {
        sans: ['"Sofia Sans"', '"DIN Alternate"', 'Bahnschrift', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        cond: ['"Sofia Sans Condensed"', '"DIN Condensed"', '"Arial Narrow"', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        float: '0 1px 2px rgb(var(--c-shadow) / 0.10), 0 8px 24px -8px rgb(var(--c-shadow) / 0.28)',
        pop: '0 2px 6px rgb(var(--c-shadow) / 0.14), 0 22px 48px -12px rgb(var(--c-shadow) / 0.42)',
      },
      keyframes: {
        'pop-in': { '0%': { opacity: '0', transform: 'translateY(4px) scale(0.98)' }, '100%': { opacity: '1', transform: 'none' } },
        'sheet-up': { '0%': { transform: 'translateY(16px)', opacity: '0' }, '100%': { transform: 'none', opacity: '1' } },
      },
      animation: {
        'pop-in': 'pop-in 140ms cubic-bezier(0.2, 0.7, 0.2, 1) both',
        'sheet-up': 'sheet-up 200ms cubic-bezier(0.2, 0.7, 0.2, 1) both',
      },
    },
  },
  plugins: [],
};
