/**
 * Hilo de trabajo de pdf.js en la versión portátil (un solo HTML, sin servidor): el código va incrustado en el
 * documento como texto inerte y se arranca desde una URL blob:. Los decodificadores WebAssembly también van
 * incrustados (en base64) y se entregan a pdf.js con una fábrica de datos propia en vez de descargarlos.
 *
 * El código incrustado es un script clásico (scripts/build-standalone.ts lo adapta): abierto con doble clic
 * (file://), el navegador no deja arrancar workers de tipo módulo desde blob:, pero sí clásicos.
 */
import type { WorkerHost } from './worker-src';

/** Arranca el hilo y espera su primer mensaje («ready»). null si el navegador o la página no lo permiten. */
function startWorker(url: string): Promise<Worker | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch {
      resolve(null);
      return;
    }
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (!ok) worker.terminate();
      resolve(ok ? worker : null);
    };
    const onMessage = (): void => finish(true);
    const onError = (): void => finish(false);
    const timer = setTimeout(() => finish(false), 8000);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });
}

export async function prepareWorker(lib: WorkerHost): Promise<void> {
  const code = document.getElementById('pdfjs-worker')?.textContent ?? '';
  if (!code) throw new Error('Este archivo no incluye el lector de PDF.');
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const worker = await startWorker(url);
  if (worker) {
    lib.GlobalWorkerOptions.workerPort = worker;
    return;
  }
  // Sin hilo de trabajo: pdf.js se carga en la propia página (al importarse se registra en globalThis.pdfjsWorker).
  await import(/* @vite-ignore */ url);
  lib.GlobalWorkerOptions.workerSrc = url;
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
