/**
 * Tema claro/oscuro. Oscuro por defecto; la elección se guarda en localStorage (con try/catch:
 * el almacenamiento puede no estar disponible) y se aplica como data-theme en <html>.
 */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'futstat-theme';

export function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', t);
  root.style.colorScheme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f1f2ee' : '#080b10');
  try {
    window.localStorage.setItem(KEY, t);
  } catch {
    /* almacenamiento no disponible: el tema dura la sesión */
  }
  window.dispatchEvent(new CustomEvent('futstat-theme', { detail: t }));
}

/** [tema, alternar, fijar] */
export function useTheme(): [Theme, () => void, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener('futstat-theme', on);
    return () => window.removeEventListener('futstat-theme', on);
  }, []);
  const set = useCallback((t: Theme) => applyTheme(t), []);
  const toggle = useCallback(() => applyTheme(readTheme() === 'dark' ? 'light' : 'dark'), []);
  return [theme, toggle, set];
}
