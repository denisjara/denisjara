/**
 * Copiar texto al portapapeles sin depender de la red ni de un contexto seguro.
 *
 * 1. `navigator.clipboard.writeText` (https y localhost; en file:// según el navegador).
 * 2. Si no existe o lo rechaza: un <textarea> temporal fuera de pantalla + `document.execCommand('copy')`
 *    (obsoleto, pero funciona sin permisos en la versión de un solo archivo abierta con file://).
 * 3. Si ambos fallan devuelve `false`: la interfaz enseña el texto seleccionable para copiarlo a mano.
 *
 * Nunca lanza. Sin tipos del DOM (lo importan también los tests de Node): accede a `navigator`/`document` por globalThis.
 */
interface ClipboardLike {
  writeText?: (text: string) => Promise<void>;
}
interface ElementLike {
  value: string;
  style: Record<string, string>;
  setAttribute(name: string, value: string): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
  focus?: (opts?: { preventScroll?: boolean }) => void;
}
interface DocumentLike {
  body?: { appendChild(el: unknown): unknown } | null;
  activeElement?: ElementLike | null;
  createElement(tag: 'textarea'): ElementLike;
  execCommand?: (cmd: string) => boolean;
}
const g = globalThis as unknown as { navigator?: { clipboard?: ClipboardLike }; document?: DocumentLike };

export async function copyText(text: string): Promise<boolean> {
  if (typeof text !== 'string' || !text) return false;
  try {
    const clip = g.navigator?.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(text);
      return true;
    }
  } catch {
    // sin permiso o contexto no seguro: se prueba el método antiguo
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const doc = g.document;
  if (!doc || !doc.body) return false;
  const active = doc.activeElement ?? null;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  doc.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    try {
      active?.focus?.({ preventScroll: true });
    } catch {
      // el foco anterior ya no existe
    }
  }
  return ok;
}
