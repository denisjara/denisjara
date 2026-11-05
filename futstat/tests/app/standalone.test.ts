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
