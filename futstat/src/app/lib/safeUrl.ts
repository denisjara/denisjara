/**
 * Origen permitido para URLs que llegan en los datos (escudos, logos, enlaces externos).
 *
 * - Imágenes: solo https y hosts de ESPN (a.espncdn.com y *.espncdn.com). Cualquier otra URL se descarta
 *   y el componente muestra su alternativa (iniciales, bandera...). La CSP de index.html aplica la misma
 *   lista (img-src), así que esto es una segunda barrera y evita peticiones bloqueadas en consola.
 * - Enlaces externos: solo https, sin credenciales en la URL. Se abren en pestaña nueva con
 *   rel="noopener noreferrer" (ver <ExternalLink>).
 *
 * Nunca se usan URLs de los datos como javascript:, data:, blob: ni rutas relativas.
 */

const MAX_URL_LENGTH = 2048;

/** Hosts de imagen permitidos (exactos) y sufijos permitidos (subdominios). */
const IMAGE_HOSTS = new Set(['a.espncdn.com']);
const IMAGE_HOST_SUFFIXES = ['.espncdn.com'];

function parseUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LENGTH) return undefined;
  // Solo URLs absolutas: nada de rutas relativas ni esquemas implícitos ("//host").
  if (!/^https?:\/\//i.test(s)) return undefined;
  try {
    const url = new URL(s);
    if (url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** true si el host está en la lista de imágenes permitidas. */
export function isAllowedImageHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return IMAGE_HOSTS.has(h) || IMAGE_HOST_SUFFIXES.some((suf) => h.endsWith(suf) && h.length > suf.length);
}

/**
 * URL de imagen segura o undefined. Solo https (http de un host permitido se sube a https),
 * sin puerto explícito y con host de ESPN.
 */
export function safeImageUrl(raw: unknown): string | undefined {
  const url = parseUrl(raw);
  if (!url) return undefined;
  if (!isAllowedImageHost(url.hostname)) return undefined;
  if (url.port && url.port !== '443') return undefined;
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return undefined;
  return url.href;
}

/** URL externa segura (solo https, sin credenciales) o undefined. */
export function safeExternalUrl(raw: unknown): string | undefined {
  const url = parseUrl(raw);
  if (!url || url.protocol !== 'https:') return undefined;
  return url.href;
}

/** Color hex de 6 dígitos (con o sin #) → "#rrggbb"; cualquier otra cosa → undefined. */
export function safeHexColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const h = raw.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toLowerCase()}` : undefined;
}
