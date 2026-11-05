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
