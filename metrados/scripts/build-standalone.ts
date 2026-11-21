/**
 * Versión PORTÁTIL de Metrado Lab: un único archivo HTML con la app entera.
 *
 *   npm run build:standalone   →  standalone/Metrado-Lab.html
 *
 * Se abre con doble clic (file://) en cualquier navegador moderno, sin servidor, sin instalar nada y sin conexión:
 * los planos se leen en el propio navegador. Dentro van el código de la app, las tipografías, el lector de PDF
 * (pdf.js, con su hilo de trabajo como texto inerte que se arranca desde una URL blob:) y los decodificadores
 * WebAssembly de imágenes JPEG 2000 y JBIG2 (los de los planos escaneados).
 *
 * Además se escribe standalone/Metrado-Lab.pagina.html: el mismo contenido sin <html>/<head>/<body>, para publicarlo
 * como página en un servicio que ya pone ese esqueleto.
 *
 * Seguridad: CSP propia calculada sobre el HTML final (sha256 de cada bloque ejecutable en línea, sin 'unsafe-inline',
 * sin conexiones a ningún servidor).
 *
 * Requiere `VITE_STANDALONE=1 vite build` (dist-standalone/).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionCspPolicy } from './csp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'dist-standalone');
const OUT_DIR = path.join(ROOT, 'standalone');
const OUT_FILE = path.join(OUT_DIR, 'Metrado-Lab.html');
const PAGE_FILE = path.join(OUT_DIR, 'Metrado-Lab.pagina.html');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist');
/** Tope del archivo final (por debajo de 16 MB para que también se pueda publicar como página única). */
const MAX_FILE_BYTES = 12_000_000;
const WASM_FILES = ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm'];

/** Código JS dentro de <script>: neutraliza cualquier '</script' literal. */
const inlineScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1');
const inlineStyle = (css: string) => css.replace(/<\/(style)/gi, '<\\/$1');

/**
 * El worker de pdf.js se distribuye como módulo ES. Abierto con doble clic (file://), el navegador no arranca workers
 * de tipo módulo desde una URL blob:, pero sí clásicos; por eso se adapta: su único `export` final sobra (al cargarse
 * ya se registra en globalThis.pdfjsWorker) e `import.meta.url` (solo lo usa el código de arranque de WebAssembly para
 * localizar archivos que aquí se entregan por otra vía) pasa a ser la URL del propio script.
 * Si una versión nueva de pdf.js cambia esto, el build falla aquí en vez de publicar un archivo roto.
 */
function classicWorker(source: string): string {
  const tail = /export\{WorkerMessageHandler\};?\s*$/;
  if (!tail.test(source)) throw new Error('El worker de pdf.js ya no termina en `export{WorkerMessageHandler}`: revisa classicWorker().');
  const code = source.replace(tail, '').replace(/\bimport\.meta\.url\b/g, 'self.location.href');
  if (/\bimport\.meta\b/.test(code) || /(^|[;}\n])\s*(export|import)\s*[{*"']/.test(code)) throw new Error('El worker de pdf.js usa sintaxis de módulo que classicWorker() no adapta.');
  try {
    new Function(code); // solo se analiza: un script clásico no admite `export`, `import.meta` ni `await` de nivel superior
  } catch (e) {
    throw new Error(`El worker de pdf.js adaptado no es un script clásico válido: ${e instanceof Error ? e.message : String(e)}`);
  }
  return code;
}

function build(): { html: string; page: string } {
  const indexPath = path.join(BUILD_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error('Falta dist-standalone/index.html: ejecuta `npm run build:standalone`.');
  let html = fs.readFileSync(indexPath, 'utf8');
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/gi)];
  const css = [...html.matchAll(/<link\b[^>]*\bhref="\.\/(assets\/[^"]+\.css)"[^>]*>/gi)];
  if (js.length !== 1) throw new Error(`Se esperaba 1 script de la app y hay ${js.length}.`);
  for (const m of css) {
    const content = fs.readFileSync(path.join(BUILD_DIR, m[1]), 'utf8');
    if (/url\(\s*["']?\.\.?\//.test(content)) throw new Error(`${m[1]} aún referencia archivos externos.`);
    html = html.replace(m[0], () => `<style>${inlineStyle(content)}</style>`);
  }
  const app = fs.readFileSync(path.join(BUILD_DIR, js[0][1]), 'utf8');

  // El hilo de trabajo de pdf.js va como texto inerte: la app lo convierte en una URL blob: al abrir el primer PDF.
  const worker = classicWorker(fs.readFileSync(path.join(PDFJS, 'build', 'pdf.worker.min.mjs'), 'utf8'));
  if (/<\/script|<!--/i.test(worker)) throw new Error('El worker de pdf.js contiene "</script" o "<!--": no se puede incrustar como texto.');
  const wasm: Record<string, string> = {};
  for (const name of WASM_FILES) wasm[name] = fs.readFileSync(path.join(PDFJS, 'wasm', name)).toString('base64');

  const payload =
    `<script id="pdfjs-worker" type="text/plain">${worker}</script>\n` +
    `<script id="pdfjs-wasm" type="application/json">${JSON.stringify(wasm)}</script>\n` +
    `<script type="module">${inlineScript(app)}</script>`;
  html = html.replace(js[0][0], () => payload);
  if (/(?:src|href)="\.\/assets\//.test(html)) throw new Error('Quedan referencias a ./assets en el HTML.');

  const meta = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i;
  if (!meta.test(html)) throw new Error('Falta la meta CSP en index.html.');
  html = html.replace(meta, (_, a: string, b: string) => `${a}${productionCspPolicy(html, { standalone: true })}${b}`);

  // Página sin esqueleto: título, estilos, contenido y scripts, en ese orden.
  const head = /<head>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  const body = /<body>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? '';
  const title = /<title>[\s\S]*?<\/title>/i.exec(head)?.[0] ?? '<title>Metrado Lab</title>';
  const blocks = [...head.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]);
  const page = [title, '<meta name="claude:viewport-fit-sides" content="cover">', ...blocks, body.trim()].join('\n');
  return { html, page };
}

function main(): void {
  const { html, page } = build();
  const size = Buffer.byteLength(html);
  if (size > MAX_FILE_BYTES) throw new Error(`El archivo pesa ${(size / 1_048_576).toFixed(1)} MB (máximo ${(MAX_FILE_BYTES / 1_048_576).toFixed(1)}).`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, content] of [
    [OUT_FILE, html],
    [PAGE_FILE, page],
  ] as const) {
    fs.writeFileSync(`${file}.tmp`, content);
    fs.renameSync(`${file}.tmp`, file);
  }
  const mb = (n: number) => `${(n / 1_048_576).toFixed(2)} MB`;
  console.log(`✓ ${path.relative(ROOT, OUT_FILE)} · ${mb(size)}`);
  console.log(`✓ ${path.relative(ROOT, PAGE_FILE)} · ${mb(Buffer.byteLength(page))}`);
}

try {
  main();
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
