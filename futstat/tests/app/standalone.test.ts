import { describe, expect, it } from 'vitest';
import { embedJson, standaloneCsp } from '../../scripts/build-standalone';

describe('versión portátil', () => {
  it('el JSON incrustado no puede cerrar la etiqueta <script> ni romper el parseo', () => {
    const LS = String.fromCharCode(0x2028);
    const value = { name: '</script><script>alert(1)</script><!--', sep: `a${LS}b` };
    const out = embedJson(value);
    expect(out).not.toContain('<');
    expect(out).not.toContain(LS);
    expect(JSON.parse(out)).toEqual(value);
  });

  it('la CSP firma los scripts ejecutables y los estilos, no el bloque de datos', () => {
    const html =
      '<meta http-equiv="Content-Security-Policy" content="x"><style>a{}</style>' +
      '<script id="futstat-data" type="application/json">{"a":1}</script><script type="module">run()</script>';
    const csp = standaloneCsp(html);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp.match(/script-src[^;]*/)![0].match(/sha256-/g)).toHaveLength(1);
    expect(csp.match(/style-src[^;]*/)![0].match(/sha256-/g)).toHaveLength(1);
    expect(csp).toContain("trusted-types 'none'");
  });
});

describe('versión portátil: datos comprimidos y escudos', () => {
  it('decodePacked recupera exactamente el JSON comprimido con gzip + base64', async () => {
    const { gzipSync } = await import('node:zlib');
    const { decodePacked } = await import('../../src/app/lib/packed');
    const value = { generatedAt: '2026-11-05T00:00:00Z', equipos: ['Colo-Colo', 'Atlético de Madrid', 'Ñublense'], n: 13810 };
    const b64 = gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
    await expect(decodePacked(b64)).resolves.toEqual(value);
    await expect(decodePacked(Buffer.from('no es gzip').toString('base64'))).rejects.toBeTruthy();
  });

  it('una data: URI que no viene del bloque de escudos incrustado se rechaza', async () => {
    const { safeImageUrl } = await import('../../src/app/lib/safeUrl');
    expect(safeImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
    expect(safeImageUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeUndefined();
    expect(safeImageUrl('https://a.espncdn.com/i/teamlogos/soccer/500/83.png')).toBe('https://a.espncdn.com/i/teamlogos/soccer/500/83.png');
  });
});

describe('versión portátil: auto-actualización', () => {
  it('solo acepta como web de origen una URL https (o localhost) sin credenciales ni parámetros', async () => {
    const { validRemoteBase } = await import('../../src/app/lib/packed');
    expect(validRemoteBase('https://denisjara.github.io/denisjara/data/')).toBe('https://denisjara.github.io/denisjara/data/');
    expect(validRemoteBase('https://denisjara.github.io/denisjara/data')).toBe('https://denisjara.github.io/denisjara/data/');
    expect(validRemoteBase('http://127.0.0.1:4310/data/')).toBe('http://127.0.0.1:4310/data/');
    expect(validRemoteBase('http://evil.example/data/')).toBeUndefined();
    expect(validRemoteBase('javascript:alert(1)')).toBeUndefined();
    expect(validRemoteBase('https://user:pw@denisjara.github.io/data/')).toBeUndefined();
    expect(validRemoteBase('https://denisjara.github.io/data/?x=1')).toBeUndefined();
    expect(validRemoteBase(42)).toBeUndefined();
  });

  it('la CSP de la versión portátil permite conectar solo con ESPN y con la web de origen', async () => {
    const { standaloneCsp } = await import('../../scripts/build-standalone');
    const csp = standaloneCsp('<script type="module">x()</script>', 'https://denisjara.github.io/denisjara/data/');
    expect(csp).toMatch(/connect-src https:\/\/site\.api\.espn\.com https:\/\/denisjara\.github\.io(;|$)/);
  });
});
