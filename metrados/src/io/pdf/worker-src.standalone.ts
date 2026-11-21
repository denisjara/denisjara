/**
 * Hilo de trabajo de pdf.js en la versión portátil (un solo HTML, sin servidor): el código va incrustado en el
 * documento como texto inerte y se arranca desde una URL blob:. Los decodificadores WebAssembly también van
 * incrustados (en base64) y se entregan a pdf.js con una fábrica de datos propia en vez de descargarlos.
 */
let cached: string | null = null;

export function workerSrc(): string {
  if (cached) return cached;
  const code = document.getElementById('pdfjs-worker')?.textContent ?? '';
  if (!code) throw new Error('Este archivo no incluye el lector de PDF.');
  cached = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  return cached;
}

let embedded: Record<string, string> | null = null;

function embeddedFiles(): Record<string, string> {
  if (embedded) return embedded;
  try {
    const parsed: unknown = JSON.parse(document.getElementById('pdfjs-wasm')?.textContent ?? '{}');
    embedded = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    embedded = {};
  }
  return embedded;
}

class EmbeddedBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const b64 = kind === 'wasmUrl' ? embeddedFiles()[filename] : undefined;
    if (typeof b64 !== 'string') throw new Error(`Recurso no incluido en la versión portátil: ${filename}`);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
}

export function documentOptions(): Record<string, unknown> {
  return { useWorkerFetch: false, BinaryDataFactory: EmbeddedBinaryData, wasmUrl: 'incrustado/' };
}
