/**
 * Dónde está el hilo de trabajo de pdf.js y sus recursos, en la web normal: archivos propios servidos junto a la app.
 * (En la versión portátil de un solo archivo, vite.config.ts cambia este módulo por worker-src.standalone.ts.)
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const workerSrc = (): string => workerUrl;

/** Opciones de getDocument: decodificadores WebAssembly, mapas de caracteres y tipografías estándar. */
export function documentOptions(): Record<string, unknown> {
  const base = new URL('./pdfjs/', document.baseURI).href;
  return { cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` };
}
