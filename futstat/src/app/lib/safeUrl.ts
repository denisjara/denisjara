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
  // Versión portátil: solo se aceptan data: URIs que vienen del bloque de escudos incrustado (nunca de los datos).
  if (typeof raw === 'string' && raw.startsWith('data:')) return embeddedLogos().values.has(raw) ? raw : undefined;
  const url = parseUrl(raw);
  if (!url) return undefined;
  if (!isAllowedImageHost(url.hostname)) return undefined;
  if (url.port && url.port !== '443') return undefined;
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return undefined;
  return embeddedLogos().byUrl.get(url.href) ?? url.href;
}

// ---------------------------------------------------------------------------
// Escudos incrustados (versión portátil de un solo archivo)
// ---------------------------------------------------------------------------
/** Imagen incrustada válida: PNG/WebP/JPEG en base64 y de tamaño razonable. */
const EMBEDDED_IMAGE = /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_EMBEDDED_IMAGE = 200_000;

let logos: { byUrl: Map<string, string>; values: Set<string> } | undefined;

/**
 * En `FutStat-Lab.html` los escudos van dentro del propio archivo (<script id="futstat-logos" type="application/json">
 * { "https://a.espncdn.com/...png": "data:image/png;base64,..." }), para verse sin internet y dentro de visores que
 * bloquean imágenes externas. En la web normal el bloque no existe y se usan las URLs de ESPN.
 */
export function embeddedLogos(): { byUrl: Map<string, string>; values: Set<string> } {
  if (logos) return logos;
  logos = { byUrl: new Map(), values: new Set() };
  try {
    // globalThis.document: este módulo también se usa en tests de Node (sin DOM).
    const doc = (globalThis as { document?: { getElementById(id: string): { textContent: string | null } | null } }).document;
    const text = doc?.getElementById('futstat-logos')?.textContent;
    if (!text) return logos;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return logos;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.length > MAX_EMBEDDED_IMAGE || !EMBEDDED_IMAGE.test(value)) continue;
      const url = parseUrl(key);
      if (!url || url.protocol !== 'https:' || !isAllowedImageHost(url.hostname)) continue;
      logos.byUrl.set(url.href, value);
      logos.values.add(value);
    }
  } catch {
    /* sin escudos incrustados: se usan las URLs */
  }
  return logos;
}

/** Solo para tests: olvida los escudos leídos del documento. */
export function resetEmbeddedLogosForTests(): void {
  logos = undefined;
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
