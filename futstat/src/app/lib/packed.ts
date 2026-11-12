/**
 * Datos comprimidos de la versión portátil (FutStat-Lab.html): cada JSON va como gzip en base64.
 * Sin dependencias del DOM para poder probarlo en Node (DecompressionStream, Blob y Response existen en ambos).
 */

/** base64 → gzip → texto JSON → objeto. Lanza Error si el navegador no soporta DecompressionStream o el dato está dañado. */
export async function decodePacked(b64: string): Promise<unknown> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream no disponible');
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text) as unknown;
}

/** Solo https (o localhost para pruebas) y terminada en '/'. */
export function validRemoteBase(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 300) return undefined;
  try {
    const u = new URL(raw);
    const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) return undefined;
    return u.href.endsWith('/') ? u.href : `${u.href}/`;
  } catch {
    return undefined;
  }
}
