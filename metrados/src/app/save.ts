/**
 * Entregar un archivo al usuario (Excel, CSV, proyecto).
 *
 * En un navegador normal es una descarga. Cuando la app se ve como artefacto de Claude, las descargas directas
 * están bloqueadas y se usa la capacidad `downloads` de la plataforma (el usuario confirma cada archivo).
 */
interface DownloadsApi {
  save(req: { filename: string; data: Blob | Uint8Array | string }): Promise<{ status: string }>;
}

interface ClaudeHost {
  use(name: string): Promise<unknown>;
}

const host: ClaudeHost | undefined = typeof window !== 'undefined' ? (window as unknown as { claude?: ClaudeHost }).claude : undefined;

/** true si la página se está viendo dentro de Claude (no hay descargas directas ni diálogo de impresión). */
export const hostedInClaude = typeof host?.use === 'function';

let downloads: Promise<DownloadsApi | null> | null = null;

function downloadsApi(): Promise<DownloadsApi | null> {
  downloads ??= hostedInClaude
    ? host!
        .use('downloads')
        .then((d) => (d && typeof (d as DownloadsApi).save === 'function' ? (d as DownloadsApi) : null))
        .catch(() => null)
    : Promise.resolve(null);
  return downloads;
}

// La capacidad tarda un momento en estar lista: se pide al cargar para que el primer clic ya la encuentre.
if (hostedInClaude) void downloadsApi();

export type SaveOutcome = 'saved' | 'declined' | 'failed';

export async function saveFile(filename: string, data: Blob | Uint8Array | string, mime = 'application/octet-stream'): Promise<SaveOutcome> {
  const api = await downloadsApi();
  if (api) {
    try {
      await api.save({ filename, data });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === 'declined') return 'declined';
      if (code !== 'unavailable' && code !== 'not_granted' && code !== 'capability_disabled' && code !== 'capability_removed') return 'failed';
      // Sin capacidad en esta vista: se intenta la descarga normal.
    }
  }
  try {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'saved';
  } catch {
    return 'failed';
  }
}

/** Copia texto al portapapeles (debe llamarse desde un clic). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
