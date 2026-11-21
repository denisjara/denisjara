import { describe, expect, it } from 'vitest';
import { distToSegment, flattenPart, partArea, partLength, type Part, type Pt } from '../src/core/geometry';
import { ALL_SNAPS, snapPoint } from '../src/core/vector';
import { cleanMText, parseDxf, splineVertices } from '../src/io/dxf/parser';
import { buildDxfScene } from '../src/io/dxf/scene';
import { buildSampleDxf, SAMPLE_COUNTS, SAMPLE_ROOMS } from '../src/io/sample';

type Pairs = (string | number)[];
const lines = (pairs: Pairs): string => pairs.map(String).join('\n');

/** DXF mínimo con capas, bloques y entidades (cada una como lista plana de pares código/valor). */
function dxf(entities: Pairs[], opts: { layers?: Pairs[]; blocks?: { name: string; base?: [number, number]; ents: Pairs[] }[]; header?: Pairs } = {}): string {
  const out: Pairs = [0, 'SECTION', 2, 'HEADER', ...(opts.header ?? [9, '$ACADVER', 1, 'AC1027']), 0, 'ENDSEC'];
  out.push(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 1);
  for (const l of opts.layers ?? []) out.push(0, 'LAYER', ...l);
  out.push(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS');
  for (const b of opts.blocks ?? []) {
    out.push(0, 'BLOCK', 8, '0', 2, b.name, 70, 0, 10, b.base?.[0] ?? 0, 20, b.base?.[1] ?? 0);
    for (const e of b.ents) out.push(0, ...e);
    out.push(0, 'ENDBLK', 8, '0');
  }
  out.push(0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  for (const e of entities) out.push(0, ...e);
  out.push(0, 'ENDSEC', 0, 'EOF');
  return `${lines(out)}\n`;
}

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));
const distToPart = (p: Pt, part: Part): number => {
  const f = flattenPart(part, 1e-8);
  if (part.closed) f.push(f[0]);
  let best = Infinity;
  for (let i = 1; i < f.length; i++) best = Math.min(best, distToSegment(p, f[i - 1], f[i]));
  return best;
};
const square: Pairs = ['LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 0, 20, 0, 10, 1, 20, 0, 10, 1, 20, 1, 10, 0, 20, 1];

describe('geometría básica', () => {
  it('LINE, LWPOLYLINE cerrada y con arcos (estadio)', async () => {
    const d = await parseDxf(
      dxf([
        ['LINE', 8, 'EJES', 10, 1, 20, 1, 11, 4, 21, 5],
        ['LWPOLYLINE', 8, 'MUROS', 90, 4, 70, 1, 10, 0, 20, 0, 10, 4.5, 20, 0, 10, 4.5, 20, 3.2, 10, 0, 20, 3.2],
        ['LWPOLYLINE', 8, 'MUROS', 90, 4, 70, 1, 43, 0.15, 10, 0, 20, 0, 10, 10, 20, 0, 42, 1, 10, 10, 20, 4, 10, 0, 20, 4, 42, 1],
        ['LWPOLYLINE', 8, 'MUROS', 90, 3, 70, 0, 10, 0, 20, 0, 42, 1, 10, 2, 20, 0, 42, 0.5, 10, 4, 20, 0, 42, 9],
      ]),
    );
    expect(d.paths).toHaveLength(4);
    expect(partLength(d.paths[0].part)).toBe(5);
    expect(d.paths[1].part.closed).toBe(true);
    expect(partArea(d.paths[1].part)).toBeCloseTo(14.4, 12);
    expect(partLength(d.paths[1].part)).toBeCloseTo(15.4, 12);
    close(partArea(d.paths[2].part), 40 + 4 * Math.PI);
    close(partLength(d.paths[2].part), 20 + 4 * Math.PI);
    expect(d.paths[2].width).toBe(0.15);
    // polilínea abierta: el bulge del último vértice no cuenta
    expect(d.paths[3].part.closed).toBeUndefined();
    expect(d.paths[3].part.v[2].b).toBeUndefined();
    close(partLength(d.paths[3].part), Math.PI + partLength({ v: [{ x: 2, y: 0, b: 0.5 }, { x: 4, y: 0 }] }));
    expect(d.layers.map((l) => l.name).sort()).toEqual(['0', 'EJES', 'MUROS']);
    expect(d.stats).toEqual({ entities: 4, byType: { LINE: 1, LWPOLYLINE: 3 } });
    // los semicírculos del estadio sobresalen 2 a cada lado
    expect(d.bbox.minX).toBeCloseTo(-2, 9);
    expect(d.bbox.maxX).toBeCloseTo(12, 9);
    expect(d.version).toBe('AC1027');
  });

  it('CIRCLE, ARC (incluido el que cruza 0°) y ELLIPSE', async () => {
    const d = await parseDxf(
      dxf([
        ['CIRCLE', 8, '0', 10, 3, 20, -2, 40, 2.5],
        ['ARC', 8, '0', 10, 0, 20, 0, 40, 10, 50, 350, 51, 20],
        ['ARC', 8, '0', 10, 1, 20, 1, 40, 2, 50, 90, 51, 0],
        ['ELLIPSE', 8, '0', 10, 2, 20, 1, 11, 5, 21, 0, 40, 0.6, 41, 0, 42, 6.283185307179586],
        ['ELLIPSE', 8, '0', 10, 0, 20, 0, 11, 0, 21, 4, 40, 0.5, 41, 0, 42, 1.5707963267948966],
      ]),
    );
    const [circle, arc, arc270, ell, quarter] = d.paths.map((p) => p.part);
    expect(circle.closed).toBe(true);
    close(partLength(circle), 2 * Math.PI * 2.5, 1e-12);
    close(partArea(circle), Math.PI * 6.25, 1e-12);
    close(partLength(arc), (10 * 30 * Math.PI) / 180, 1e-12);
    close(arc.v[0].x, 10 * Math.cos((350 * Math.PI) / 180), 1e-12);
    close(arc.v[arc.v.length - 1].y, 10 * Math.sin((20 * Math.PI) / 180), 1e-12);
    expect(distToPart({ x: 10, y: 0 }, arc)).toBeLessThan(1e-6);
    expect(distToPart({ x: -10, y: 0 }, arc)).toBeGreaterThan(5);
    // de 90° a 0° en sentido antihorario: tres cuartos de vuelta
    close(partLength(arc270), 2 * 1.5 * Math.PI, 1e-12);
    expect(ell.closed).toBe(true);
    close(partArea(ell), Math.PI * 5 * 3, 1e-6);
    // cuarto de elipse con el semieje mayor vertical: va de (0,4) a (-2,0)
    close(quarter.v[0].y, 4);
    close(quarter.v[quarter.v.length - 1].x, -2, 1e-9);
    expect(Math.abs(quarter.v[quarter.v.length - 1].y)).toBeLessThan(1e-9);
  });

  it('POLYLINE antigua con VERTEX y SEQEND', async () => {
    const d = await parseDxf(
      dxf([
        ['POLYLINE', 8, 'MUROS', 66, 1, 70, 1],
        ['VERTEX', 8, 'MUROS', 10, 0, 20, 0],
        ['VERTEX', 8, 'MUROS', 10, 6, 20, 0, 42, 1],
        ['VERTEX', 8, 'MUROS', 10, 6, 20, 2],
        ['VERTEX', 8, 'MUROS', 10, 0, 20, 2],
        ['SEQEND', 8, 'MUROS'],
        ['LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 0],
      ]),
    );
    expect(d.paths.map((p) => p.src)).toEqual(['POLYLINE', 'LINE']);
    close(partArea(d.paths[0].part), 12 + Math.PI / 2);
    expect(d.stats.byType).toEqual({ POLYLINE: 1, LINE: 1 });
  });

  it('SPLINE cúbica no racional: sus tramos Bézier coinciden con la evaluación directa (de Boor)', () => {
    const knots = [0, 0, 0, 0, 1, 2.5, 3, 3, 3, 3];
    const pts: [number, number][] = [
      [0, 0],
      [1, 3],
      [3, 4],
      [5, 1],
      [7, -2],
      [9, 2],
    ];
    const deBoor = (u: number): Pt => {
      const p = 3;
      let k = p;
      while (k < pts.length - 1 && u >= knots[k + 1]) k++;
      const d = pts.slice(k - p, k + 1).map((q) => [...q]);
      for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
          const i = k - p + j;
          const a = (u - knots[i]) / (knots[i + p - r + 1] - knots[i]);
          d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
        }
      }
      return { x: d[p][0], y: d[p][1] };
    };
    const v = splineVertices(3, knots, pts, []);
    expect(v).toHaveLength(4);
    const spans = [
      [0, 1],
      [1, 2.5],
      [2.5, 3],
    ];
    spans.forEach(([a, b], i) => {
      const p0 = v[i];
      const p3 = v[i + 1];
      const c = p0.c!;
      for (const t of [0, 0.13, 0.5, 0.77, 1]) {
        const u = 1 - t;
        const x = u ** 3 * p0.x + 3 * u * u * t * c[0] + 3 * u * t * t * c[2] + t ** 3 * p3.x;
        const y = u ** 3 * p0.y + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t ** 3 * p3.y;
        const exact = deBoor(Math.min(a + t * (b - a), 3 - 1e-12));
        expect(Math.hypot(x - exact.x, y - exact.y)).toBeLessThan(1e-9);
      }
    });
    // racional: un cuarto de círculo exacto como NURBS de grado 2
    const w = Math.SQRT1_2;
    const arc = splineVertices(2, [0, 0, 0, 1, 1, 1], [[1, 0], [1, 1], [0, 1]], [1, w, 1]);
    for (const q of arc) expect(Math.abs(Math.hypot(q.x, q.y) - 1)).toBeLessThan(1e-12);
    close(partLength({ v: arc }), Math.PI / 2, 1e-5);
  });
});

describe('bloques', () => {
  it('INSERT con escala, giro y desplazamiento; área × escala²', async () => {
    const d = await parseDxf(dxf([['INSERT', 8, 'COLUMNAS', 2, 'CUADRO', 10, 10, 20, 5, 41, 2, 42, 2, 50, 90]], { blocks: [{ name: 'CUADRO', ents: [square] }] }));
    const v = d.paths[0].part.v.map((p) => [Math.round(p.x * 1e9) / 1e9, Math.round(p.y * 1e9) / 1e9]);
    expect(v).toEqual([
      [10, 5],
      [10, 7],
      [8, 7],
      [8, 5],
    ]);
    close(partArea(d.paths[0].part), 4);
    expect(d.paths[0].block).toBe('CUADRO');
    // la entidad estaba en la capa 0 del bloque: toma la capa de la inserción
    expect(d.layers[d.paths[0].layer].name).toBe('COLUMNAS');
    expect(d.inserts).toHaveLength(1);
    expect(d.inserts[0]).toMatchObject({ name: 'CUADRO', x: 10, y: 5, depth: 0 });
    close(d.inserts[0].rotation, Math.PI / 2);
    close(d.inserts[0].sx, 2);
  });

  it('punto base, bloques anidados, matriz de 2 × 3 y bloque que se llama a sí mismo', async () => {
    const d = await parseDxf(
      dxf(
        [
          ['INSERT', 8, '0', 2, 'GRUPO', 10, 100, 20, 0],
          ['INSERT', 8, '0', 2, 'CUADRO', 10, 0, 20, 0, 70, 2, 71, 3, 44, 5, 45, 4],
          ['INSERT', 8, '0', 2, 'BUCLE', 10, 0, 20, 50],
          ['INSERT', 8, '0', 2, 'NO_EXISTE', 10, 0, 20, 0],
        ],
        {
          blocks: [
            { name: 'CUADRO', base: [0.5, 0.5], ents: [square] },
            { name: 'GRUPO', ents: [['INSERT', 8, '0', 2, 'CUADRO', 10, 0, 20, 0], ['INSERT', 8, '0', 2, 'CUADRO', 10, 3, 20, 0, 41, 2, 42, 2]] },
            { name: 'BUCLE', ents: [['LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 0], ['INSERT', 8, '0', 2, 'BUCLE', 10, 1, 20, 0]] },
          ],
        },
      ),
    );
    const byName = (n: string) => d.inserts.filter((i) => i.name === n);
    expect(byName('CUADRO')).toHaveLength(2 + 6);
    expect(byName('CUADRO').filter((i) => i.depth === 1)).toHaveLength(2);
    expect(byName('GRUPO')).toHaveLength(1);
    // el punto base (0.5, 0.5) queda en el punto de inserción
    const nested = d.paths.filter((p) => p.block === 'GRUPO');
    expect(nested).toHaveLength(2);
    expect(nested[0].part.v[0]).toMatchObject({ x: 99.5, y: -0.5 });
    close(partArea(nested[1].part), 4);
    expect(nested[1].part.v[0]).toMatchObject({ x: 102, y: -1 });
    const cells = byName('CUADRO')
      .filter((i) => i.depth === 0)
      .map((i) => `${i.x},${i.y}`)
      .sort();
    expect(cells).toEqual(['0,0', '0,4', '0,8', '5,0', '5,4', '5,8']);
    // el bloque recursivo se dibuja una vez y no cuelga el lector
    expect(d.paths.filter((p) => p.block === 'BUCLE')).toHaveLength(1);
    expect(d.warnings.some((w) => w.includes('NO_EXISTE'))).toBe(true);
  });

  it('inserción reflejada y con escala no uniforme: los arcos siguen midiendo lo que deben', async () => {
    const arcBlock = { name: 'PUERTA', ents: [['LINE', 8, '0', 10, 0, 20, 0, 11, 0, 21, 1] as Pairs, ['ARC', 8, '0', 10, 0, 20, 0, 40, 1, 50, 0, 51, 90] as Pairs] };
    const d = await parseDxf(
      dxf(
        [
          ['INSERT', 8, 'PUERTAS', 2, 'PUERTA', 10, 5, 20, 5, 41, -0.9, 42, 0.9, 50, 30],
          ['INSERT', 8, 'PUERTAS', 2, 'PUERTA', 10, 0, 20, 0, 41, 2, 42, 1],
        ],
        { blocks: [arcBlock] },
      ),
    );
    const mirrored = d.paths[1].part;
    close(partLength(mirrored), (0.9 * Math.PI) / 2, 1e-12);
    expect(mirrored.v[0].b).toBeLessThan(0); // el arco cambia de sentido al reflejarse
    expect(d.inserts[0].sx).toBeLessThan(0);
    // escala 2 × 1: un cuarto de elipse de semiejes 2 y 1 (perímetro ≈ 2,4221)
    const stretched = d.paths[3].part;
    expect(stretched.v.some((p) => p.c)).toBe(true);
    close(partLength(stretched), 2.4221102220, 1e-6);
    close(partArea({ v: [{ x: 0, y: 0 }, ...stretched.v], closed: true }), (Math.PI * 2 * 1) / 4, 1e-6);
  });

  it('atributos de una inserción', async () => {
    const d = await parseDxf(
      dxf(
        [
          ['INSERT', 8, 'PUERTAS', 2, 'ETIQUETA', 66, 1, 10, 2, 20, 3],
          ['ATTRIB', 8, 'PUERTAS', 10, 2.1, 20, 3.1, 40, 0.2, 1, 'P-1', 2, 'TIPO', 70, 0],
          ['ATTRIB', 8, 'PUERTAS', 10, 2.1, 20, 2.8, 40, 0.2, 1, '0.90x2.10', 2, 'MEDIDA', 70, 1],
          ['SEQEND', 8, 'PUERTAS'],
        ],
        { blocks: [{ name: 'ETIQUETA', ents: [['CIRCLE', 8, '0', 10, 0, 20, 0, 40, 0.3], ['ATTDEF', 8, '0', 10, 0, 20, 0, 40, 0.2, 1, 'X', 3, 'Tipo', 2, 'TIPO']] }] },
      ),
    );
    expect(d.inserts[0].attribs).toEqual({ TIPO: 'P-1', MEDIDA: '0.90x2.10' });
    // el atributo invisible no se dibuja; la definición (ATTDEF) tampoco
    expect(d.texts.map((t) => [t.text, t.src, t.block])).toEqual([['P-1', 'ATTRIB', 'ETIQUETA']]);
    expect(d.texts[0]).toMatchObject({ x: 2.1, y: 3.1, height: 0.2 });
    expect(d.paths).toHaveLength(1);
  });
});

describe('sistemas de coordenadas, colores y capas', () => {
  it('extrusión (0,0,-1): entidades reflejadas en X con los arcos por el lado correcto', async () => {
    const d = await parseDxf(
      dxf([
        ['CIRCLE', 8, '0', 10, 5, 20, 0, 40, 1, 210, 0, 220, 0, 230, -1],
        ['ARC', 8, '0', 10, 5, 20, 0, 40, 1, 50, 0, 51, 90, 210, 0, 220, 0, 230, -1],
        ['LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1, 10, 2, 20, 0, 210, 0, 220, 0, 230, -1],
      ]),
    );
    const [circle, arc, pl] = d.paths.map((p) => p.part);
    close(partArea(circle), Math.PI);
    expect(distToPart({ x: -5, y: 1 }, circle)).toBeLessThan(1e-6);
    close(partLength(arc), Math.PI / 2, 1e-12);
    expect(arc.v[0]).toMatchObject({ x: -6, y: 0 });
    expect(distToPart({ x: -5 - Math.SQRT1_2, y: Math.SQRT1_2 }, arc)).toBeLessThan(1e-6);
    // semicírculo de (0,0) a (-2,0): en el OCS abombaba hacia y negativa y sigue haciéndolo
    expect(pl.v[1]).toMatchObject({ x: -2, y: 0 });
    expect(distToPart({ x: -1, y: -1 }, pl)).toBeLessThan(1e-6);
  });

  it('colores: por capa, índice, color verdadero y por bloque; tipos de línea y capas apagadas', async () => {
    const d = await parseDxf(
      dxf(
        [
          ['LINE', 8, 'MUROS', 10, 0, 20, 0, 11, 1, 21, 0],
          ['LINE', 8, 'MUROS', 62, 1, 10, 0, 20, 0, 11, 1, 21, 0],
          ['LINE', 8, 'MUROS', 420, 1193046, 10, 0, 20, 0, 11, 1, 21, 0],
          ['LINE', 8, 'EJES', 10, 0, 20, 0, 11, 1, 21, 0],
          ['LINE', 8, 'EJES', 6, 'CONTINUOUS', 10, 0, 20, 0, 11, 1, 21, 0],
          ['INSERT', 8, 'MUROS', 62, 5, 2, 'B', 10, 0, 20, 0],
          ['LINE', 8, 'SIN_TABLA', 10, 0, 20, 0, 11, 1, 21, 0],
        ],
        {
          layers: [
            [2, 'MUROS', 70, 0, 62, 3, 6, 'CONTINUOUS'],
            [2, 'EJES', 70, 1, 62, -2, 6, 'CENTER'],
            [2, 'FIJA', 70, 0, 62, 4, 6, 'CONTINUOUS'],
          ],
          blocks: [{ name: 'B', ents: [['LINE', 8, '0', 62, 0, 10, 0, 20, 0, 11, 1, 21, 0], ['LINE', 8, 'FIJA', 10, 0, 20, 0, 11, 1, 21, 0], ['LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 0]] }],
        },
      ),
    );
    expect(d.paths.map((p) => p.color)).toEqual(['#00ff00', '#ff0000', '#123456', '#ffff00', '#ffff00', '#0000ff', '#00ffff', '#00ff00', '#ffffff']);
    expect(d.paths.map((p) => !!p.dashed)).toEqual([false, false, false, true, false, false, false, false, false]);
    const layer = (n: string) => d.layers.find((l) => l.name === n)!;
    expect(layer('EJES')).toMatchObject({ off: true, frozen: true, color: '#ffff00' });
    expect(layer('MUROS')).toMatchObject({ off: false, frozen: false, color: '#00ff00' });
    expect(layer('SIN_TABLA').color).toBe('#ffffff');
    // dentro del bloque: capa 0 → capa de la inserción; capa propia → se conserva
    expect(d.paths.slice(5, 8).map((p) => d.layers[p.layer].name)).toEqual(['MUROS', 'FIJA', 'MUROS']);
  });

  it('se salta el espacio papel, lo invisible y avisa de lo que no admite', async () => {
    const d = await parseDxf(
      dxf([
        ['LINE', 8, '0', 67, 1, 10, 0, 20, 0, 11, 9, 21, 9],
        ['LINE', 8, '0', 60, 1, 10, 0, 20, 0, 11, 9, 21, 9],
        ['LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 0],
        ['MLEADER', 8, '0', 10, 0, 20, 0],
        ['MLEADER', 8, '0', 10, 0, 20, 0],
        ['VIEWPORT', 8, '0', 10, 0, 20, 0],
        ['POINT', 8, '0', 10, 0, 20, 0],
        ['LINE', 8, '0', 10, 'x', 20, 0, 11, 1, 21, 0],
      ]),
    );
    expect(d.paths).toHaveLength(2);
    expect(d.warnings).toEqual(['2 entidades MLEADER no se muestran (tipo no admitido).']);
    expect(d.stats.entities).toBe(6);
  });
});

describe('sombreados y textos', () => {
  it('HATCH: contorno de polilínea con isla y contorno de aristas (línea + arco)', async () => {
    const d = await parseDxf(
      dxf([
        // prettier-ignore
        ['HATCH', 8, 'PISOS', 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, 1, 2, 'SOLID', 70, 1, 71, 0, 91, 2,
          92, 3, 72, 0, 73, 1, 93, 4, 10, 0, 20, 0, 10, 6, 20, 0, 10, 6, 20, 4, 10, 0, 20, 4, 97, 0,
          92, 18, 72, 0, 73, 1, 93, 4, 10, 1, 20, 1, 10, 2, 20, 1, 10, 2, 20, 2, 10, 1, 20, 2, 97, 1, 330, 'AB',
          75, 0, 76, 1, 98, 1, 10, 3, 20, 3],
        // prettier-ignore
        ['HATCH', 8, 'PISOS', 10, 0, 20, 0, 30, 0, 2, 'ANSI31', 70, 0, 71, 0, 91, 1,
          92, 1, 93, 2,
          72, 1, 10, -1, 20, 0, 11, 1, 21, 0,
          72, 2, 10, 0, 20, 0, 40, 1, 50, 0, 51, 180, 73, 1,
          97, 0, 75, 0, 76, 1, 52, 0, 41, 1, 77, 0, 78, 0, 98, 0],
        // arco horario: los ángulos vienen reflejados (360° − ángulo)
        // prettier-ignore
        ['HATCH', 8, 'PISOS', 10, 0, 20, 0, 30, 0, 2, 'SOLID', 70, 1, 71, 0, 91, 1,
          92, 1, 93, 2,
          72, 1, 10, 10, 20, 0, 11, 12, 21, 0,
          72, 2, 10, 11, 20, 0, 40, 1, 50, 0, 51, 180, 73, 0,
          97, 0, 75, 0, 76, 1, 98, 0],
      ]),
    );
    expect(d.paths.map((p) => p.src)).toEqual(['HATCH', 'HATCH', 'HATCH', 'HATCH']);
    expect(d.paths[0].hatch).toBe(d.paths[1].hatch);
    expect(d.paths[2].hatch).not.toBe(d.paths[0].hatch);
    expect([d.paths[0].fill, d.paths[2].fill]).toEqual([true, undefined]);
    expect(partArea(d.paths[0].part)).toBe(24);
    expect(partArea(d.paths[1].part)).toBe(1);
    expect(d.paths[2].part.closed).toBe(true);
    close(partArea(d.paths[2].part), Math.PI / 2);
    expect(distToPart({ x: 0, y: 1 }, d.paths[2].part)).toBeLessThan(1e-6);
    // el horario va de (12,0) a (10,0) por abajo
    close(partArea(d.paths[3].part), Math.PI / 2);
    expect(distToPart({ x: 11, y: -1 }, d.paths[3].part)).toBeLessThan(1e-6);
  });

  it('TEXT y MTEXT: códigos de formato, símbolos, alineación y texto dentro de un bloque girado', async () => {
    expect(cleanMText('{\\fArial|b1|i0|c0|p34;\\H1.5x;DORMITORIO}\\P\\C1;A = 11.20 m\\U+00B2\\~aprox.')).toBe('DORMITORIO\nA = 11.20 m² aprox.');
    expect(cleanMText('\\A1;\\S1/2;" x \\S3^4; \\\\ \\{ok\\} \\Lsub\\l %%c20')).toBe('1/2" x 3/4 \\ {ok} sub Ø20');
    const d = await parseDxf(
      dxf(
        [
          ['TEXT', 8, 'TEXTOS', 10, 1, 20, 2, 40, 0.25, 1, '%%c1/2" %%p0.05 45%%d NI\\U+00D1O', 50, 90],
          ['TEXT', 8, 'TEXTOS', 10, 0, 20, 0, 11, 5, 21, 6, 40, 0.2, 1, 'V-101', 72, 1, 73, 2],
          ['MTEXT', 8, 'TEXTOS', 10, 3, 20, 4, 40, 0.3, 71, 5, 3, '{\\fArial;SALA - ', 1, 'COMEDOR}\\PA=22.83', 11, 0, 21, 1],
          ['INSERT', 8, 'TEXTOS', 2, 'ROTULO', 10, 10, 20, 0, 41, 2, 42, 2, 50, 90],
        ],
        { blocks: [{ name: 'ROTULO', ents: [['TEXT', 8, '0', 10, 1, 20, 0, 40, 0.1, 1, 'C-1']] }] },
      ),
    );
    expect(d.texts.map((t) => t.text)).toEqual(['Ø1/2" ±0.05 45° NIÑO', 'V-101', 'SALA - COMEDOR\nA=22.83', 'C-1']);
    close(d.texts[0].rotation, Math.PI / 2);
    expect(d.texts[0]).toMatchObject({ halign: 'left', valign: 'baseline', x: 1, y: 2 });
    expect(d.texts[1]).toMatchObject({ halign: 'center', valign: 'middle', x: 5, y: 6 });
    expect(d.texts[2]).toMatchObject({ halign: 'center', valign: 'middle', src: 'MTEXT' });
    close(d.texts[2].rotation, Math.PI / 2);
    // dentro del bloque: (1,0) × 2, girado 90° y trasladado → (10, 2); altura × 2
    close(d.texts[3].x, 10);
    close(d.texts[3].y, 2);
    close(d.texts[3].height, 0.2);
    close(d.texts[3].rotation, Math.PI / 2);
    expect(d.layers[d.texts[3].layer].name).toBe('TEXTOS');
  });
});

describe('archivos', () => {
  it('bytes en Windows-1252, DXF binario, basura y finales de línea CRLF', async () => {
    const text = dxf([['TEXT', 8, 'TEXTOS', 10, 0, 20, 0, 40, 1, 1, 'BAÑO']], { layers: [[2, 'TEXTOS', 70, 0, 62, 7]] });
    const latin = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
    expect(latin.includes(0xd1)).toBe(true);
    expect((await parseDxf(latin)).texts[0].text).toBe('BAÑO');
    expect((await parseDxf(new TextEncoder().encode(text).buffer as ArrayBuffer)).texts[0].text).toBe('BAÑO');
    expect((await parseDxf(text.replace(/\n/g, '\r\n'))).texts[0].text).toBe('BAÑO');
    await expect(parseDxf(new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\0'))).rejects.toThrow(/binario/);
    await expect(parseDxf('hola, esto no es un plano')).rejects.toThrow(/no parece un DXF/);
    await expect(parseDxf('')).rejects.toThrow(/no parece un DXF/);
  });

  it('20 000 líneas se leen deprisa y avisando del progreso', async () => {
    const ents: Pairs[] = [];
    for (let i = 0; i < 20000; i++) ents.push(['LINE', 8, i % 2 ? 'A' : 'B', 10, i, 20, 0, 11, i + 0.5, 21, 1]);
    const progress: number[] = [];
    const t0 = performance.now();
    const d = await parseDxf(dxf(ents), { onProgress: (f) => progress.push(f) });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(d.paths).toHaveLength(20000);
    expect(d.paths[19999].part.v[1]).toEqual({ x: 19999.5, y: 1 });
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1])).toBe(true);
  });
});

describe('plano de ejemplo en DXF (metros)', () => {
  it('se lee completo: capas, bloques contados y ambientes con su área exacta', async () => {
    const d = await parseDxf(buildSampleDxf());
    expect(d.insUnits).toBe(6);
    expect(d.warnings).toEqual([]);
    const count = (name: string) => d.inserts.filter((i) => i.name === name).length;
    expect([count('PUERTA'), count('LUMINARIA'), count('TOMACORRIENTE')]).toEqual([SAMPLE_COUNTS.doors, SAMPLE_COUNTS.lights, SAMPLE_COUNTS.outlets]);
    expect(d.paths.filter((p) => p.src === 'SOLID')).toHaveLength(SAMPLE_COUNTS.columns);
    expect(d.texts.some((t) => t.text === 'A = 11.20 m²')).toBe(true);

    const scene = buildDxfScene(d);
    expect(scene.layers.map((l) => l.name)).toEqual(['0', 'MUROS', 'COLUMNAS', 'VENTANAS', 'PUERTAS', 'MOBILIARIO', 'ELECTRICAS', 'TEXTOS', 'COTAS']);
    // mundo (metros, y hacia arriba) → lámina
    const toSheet = (x: number, y: number): Pt => ({ x: scene.toSheet[0] * x + scene.toSheet[4], y: scene.toSheet[3] * y + scene.toSheet[5] });
    for (const r of SAMPLE_ROOMS) {
      const corners = [
        [r.x0, r.y0],
        [r.x1, r.y0],
        [r.x1, r.y1],
        [r.x0, r.y1],
      ].map(([x, y]) => {
        const s = toSheet(x, y);
        // el cursor cae a medio centímetro de la esquina (hay columnas a 5 cm: el enganche toma el vértice más cercano)
        const hit = snapPoint(scene.vector, { x: s.x + 0.004, y: s.y - 0.003 }, { modes: ALL_SNAPS, radius: 0.02 });
        expect(hit?.kind === 'endpoint' || hit?.kind === 'intersection').toBe(true);
        return { x: hit!.x, y: hit!.y };
      });
      // en un DXF dibujado en metros la unidad de lámina ya es el metro: el área sale exacta a 1e-12
      expect(partArea({ v: corners, closed: true })).toBeCloseTo((r.x1 - r.x0) * (r.y1 - r.y0), 10);
    }
    // una puerta: hoja de 0.90 y arco de un cuarto de círculo de radio 0.90
    const door = d.paths.filter((p) => p.block === 'PUERTA' && p.src === 'ARC');
    expect(door).toHaveLength(SAMPLE_COUNTS.doors);
    close(partLength(door[1].part), (0.9 * Math.PI) / 2, 1e-12);
  });
});
