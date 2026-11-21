import { describe, expect, it } from 'vitest';
import { findRegion, type RegionResult } from '../src/core/boundary';
import { pointInPolygon, polygonSignedArea, segmentIntersection, type BBox, type Pt } from '../src/core/geometry';

type Seg = [number, number, number, number];
const BOUNDS: BBox = { minX: -100, minY: -100, maxX: 200, maxY: 200 };
const pack = (segs: Seg[]): Float64Array => Float64Array.from(segs.flat());
const rect = (x0: number, y0: number, x1: number, y1: number): Seg[] => [
  [x0, y0, x1, y0],
  [x1, y0, x1, y1],
  [x1, y1, x0, y1],
  [x0, y1, x0, y0],
];
const region = (segs: Seg[], p: Pt, eps = 1e-6): RegionResult => findRegion(pack(segs), p, { eps, bounds: BOUNDS });
const ok = (r: RegionResult) => {
  if (!r.ok) throw new Error(`se esperaba una región y fue «${r.reason}»`);
  return r;
};
const sortPts = (pts: Pt[]) => [...pts].sort((a, b) => a.x - b.x || a.y - b.y);

/** Generador pseudoaleatorio con semilla (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('recinto que contiene un punto', () => {
  it('rectángulo de 4 segmentos sueltos, en cualquier orden y sentido: vértices originales exactos', () => {
    const r = ok(region([[10.25, 3, 10.25, 0.5], [0.1, 0.5, 10.25, 0.5], [0.1, 3, 0.1, 0.5], [10.25, 3, 0.1, 3]], { x: 4, y: 2 }));
    expect(sortPts(r.outer)).toEqual(sortPts([{ x: 0.1, y: 0.5 }, { x: 10.25, y: 0.5 }, { x: 10.25, y: 3 }, { x: 0.1, y: 3 }]));
    expect(polygonSignedArea(r.outer)).toBeGreaterThan(0);
    expect(r.area).toBeCloseTo(10.15 * 2.5, 12);
    expect(r.perimeter).toBeCloseTo(2 * (10.15 + 2.5), 12);
    expect(r.holes).toEqual([]);
  });

  it('muros que se pasan en las esquinas (#): queda el rectángulo interior', () => {
    const segs: Seg[] = [
      [-1, 0, 6, 0],
      [-1, 4, 6, 4],
      [0, -1, 0, 5],
      [5, -1, 5, 5],
    ];
    const r = ok(region(segs, { x: 2.5, y: 2 }));
    expect(sortPts(r.outer)).toEqual(sortPts([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }]));
    expect(r.area).toBe(20);
    // fuera del # la cara no está cerrada
    expect(region(segs, { x: 5.5, y: 4.5 })).toEqual({ ok: false, reason: 'open' });
  });

  it('uniones en T: un muro interior que muere sobre los muros exteriores separa dos ambientes', () => {
    const segs: Seg[] = [...rect(0, 0, 10, 6), [4, 0, 4, 6]];
    const left = ok(region(segs, { x: 1, y: 1 }));
    const right = ok(region(segs, { x: 9, y: 5 }));
    expect(left.area).toBe(24);
    expect(right.area).toBe(36);
    expect(left.outer).toHaveLength(4);
    expect(sortPts(right.outer)).toEqual(sortPts([{ x: 4, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 4, y: 6 }]));
  });

  it('muros partidos en trozos alineados: los vértices intermedios se funden', () => {
    const segs: Seg[] = [[0, 0, 2, 0], [2, 0, 5.5, 0], [5.5, 0, 8, 0], [8, 0, 8, 3], [8, 3, 8, 5], [8, 5, 0, 5], [0, 5, 0, 2.5], [0, 2.5, 0, 0]];
    const r = ok(region(segs, { x: 3, y: 3 }));
    expect(r.outer).toHaveLength(4);
    expect(r.area).toBe(40);
  });

  it('extremos que no llegan a tocarse: cierran dentro de la tolerancia y no fuera de ella', () => {
    const gap = (g: number): Seg[] => [[0, 0, 5, 0], [5, 0, 5, 4], [5, 4, 0, 4], [0, 4, 0, g]];
    expect(ok(region(gap(4e-7), { x: 2, y: 2 }, 1e-6)).area).toBeCloseTo(20, 5);
    expect(region(gap(0.01), { x: 2, y: 2 }, 1e-6)).toEqual({ ok: false, reason: 'open' });
  });

  it('islas: una columna dentro del ambiente es un hueco; dentro de la columna, la región es la columna', () => {
    const segs: Seg[] = [...rect(0, 0, 10, 8), ...rect(4, 3, 4.5, 3.5)];
    const room = ok(region(segs, { x: 1, y: 1 }));
    expect(room.area).toBe(80);
    expect(room.holes).toHaveLength(1);
    expect(polygonSignedArea(room.holes[0])).toBeCloseTo(-0.25, 12);
    expect(room.holes[0]).toHaveLength(4);
    // el rayo hacia la derecha atraviesa la columna antes de llegar al muro
    expect(ok(region(segs, { x: 1, y: 3.25 })).area).toBe(80);
    const col = ok(region(segs, { x: 4.25, y: 3.25 }));
    expect(col.area).toBeCloseTo(0.25, 12);
    expect(col.holes).toEqual([]);
  });

  it('una isla dentro de otra isla no es un hueco de la cara exterior', () => {
    const segs: Seg[] = [...rect(0, 0, 20, 20), ...rect(5, 5, 15, 15), ...rect(8, 8, 10, 10)];
    const outer = ok(region(segs, { x: 2, y: 2 }));
    expect(outer.holes).toHaveLength(1);
    expect(Math.abs(polygonSignedArea(outer.holes[0]))).toBe(100);
    const mid = ok(region(segs, { x: 6, y: 6 }));
    expect(mid.area).toBe(100);
    expect(mid.holes).toHaveLength(1);
    expect(Math.abs(polygonSignedArea(mid.holes[0]))).toBe(4);
  });

  it('antenas: líneas que entran sin cerrar y líneas sueltas dentro no cambian el recinto', () => {
    const segs: Seg[] = [...rect(0, 0, 10, 6), [0, 3, 4, 3], [4, 3, 4, 4.5], [6, 1, 8, 2], [7, 4, 7, 5], [7, 5, 9, 5]];
    const r = ok(region(segs, { x: 5, y: 3 }));
    expect(r.outer).toHaveLength(4);
    expect(r.area).toBe(60);
    expect(r.holes).toEqual([]);
  });

  it('una línea que cruza todo el ambiente lo parte en dos', () => {
    const segs: Seg[] = [...rect(0, 0, 10, 10), [-3, 5, 13, 5]];
    expect(ok(region(segs, { x: 5, y: 2 })).area).toBe(50);
    expect(ok(region(segs, { x: 5, y: 8 })).area).toBe(50);
    const diag: Seg[] = [...rect(0, 0, 10, 10), [-1, -1, 11, 11]];
    expect(ok(region(diag, { x: 8, y: 2 })).area).toBeCloseTo(50, 12);
    expect(ok(region(diag, { x: 8, y: 2 })).outer).toHaveLength(3);
  });

  it('muros dibujados dos veces o solapados a medias', () => {
    const segs: Seg[] = [...rect(0, 0, 6, 4), ...rect(0, 0, 6, 4), [1, 0, 9, 0], [6, -2, 6, 3], [-4, 4, 3, 4]];
    const r = ok(region(segs, { x: 3, y: 2 }));
    expect(r.area).toBe(24);
    expect(r.outer).toHaveLength(4);
  });

  it('formas en L y cóncavas', () => {
    const l: Seg[] = [[0, 0, 6, 0], [6, 0, 6, 2], [6, 2, 2, 2], [2, 2, 2, 5], [2, 5, 0, 5], [0, 5, 0, 0]];
    const r = ok(region(l, { x: 1, y: 4 }));
    expect(r.area).toBe(18);
    expect(r.outer).toHaveLength(6);
    expect(region(l, { x: 4, y: 4 })).toEqual({ ok: false, reason: 'open' });
  });

  it('muro curvo teselado en 64 tramos: área del semicírculo con sus vértices originales', () => {
    const R = 5;
    const segs: Seg[] = [[-R, 0, R, 0]];
    const pts: Pt[] = [];
    for (let i = 0; i <= 64; i++) pts.push({ x: R * Math.cos((Math.PI * i) / 64), y: R * Math.sin((Math.PI * i) / 64) });
    pts[0] = { x: R, y: 0 };
    pts[64] = { x: -R, y: 0 };
    for (let i = 0; i < 64; i++) segs.push([pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y]);
    const r = ok(region(segs, { x: 0.3, y: 2 }));
    expect(r.outer).toHaveLength(65);
    expect(Math.abs(r.area / ((Math.PI * R * R) / 2) - 1)).toBeLessThan(1e-3);
    for (const v of r.outer) expect(pts.some((q) => q.x === v.x && q.y === v.y)).toBe(true);
  });

  it('fuera de todo recinto, sobre un muro y fuera de la lámina', () => {
    const segs = rect(0, 0, 5, 5);
    expect(region(segs, { x: 20, y: 20 })).toEqual({ ok: false, reason: 'open' });
    expect(region(segs, { x: 2, y: 0 })).toEqual({ ok: false, reason: 'on-edge' });
    expect(region(segs, { x: 999, y: 0 })).toEqual({ ok: false, reason: 'open' });
    expect(region([], { x: 1, y: 1 })).toEqual({ ok: false, reason: 'open' });
  });

  it('respeta el filtro de capas ocultas', () => {
    const segs: Seg[] = [...rect(0, 0, 10, 6), [4, 0, 4, 6]];
    const data = pack(segs);
    const all = findRegion(data, { x: 1, y: 1 }, { eps: 1e-6, bounds: BOUNDS });
    const hidden = findRegion(data, { x: 1, y: 1 }, { eps: 1e-6, bounds: BOUNDS, accept: (i) => i !== 4 });
    expect(all.ok && all.area).toBe(24);
    expect(hidden.ok && hidden.area).toBe(60);
  });

  it('rejilla de 60 × 60: cada celda es exactamente su cuadrado', () => {
    const segs: Seg[] = [];
    for (let i = 0; i <= 60; i++) segs.push([i, 0, i, 60], [0, i, 60, i]);
    const data = pack(segs);
    const rand = rng(7);
    for (let k = 0; k < 40; k++) {
      const cx = Math.floor(rand() * 60);
      const cy = Math.floor(rand() * 60);
      const r = findRegion(data, { x: cx + 0.2 + rand() * 0.6, y: cy + 0.2 + rand() * 0.6 }, { eps: 1e-7, bounds: { minX: 0, minY: 0, maxX: 60, maxY: 60 } });
      if (!r.ok) throw new Error(r.reason);
      expect(r.area).toBe(1);
      expect(sortPts(r.outer)).toEqual(sortPts([{ x: cx, y: cy }, { x: cx + 1, y: cy }, { x: cx + 1, y: cy + 1 }, { x: cx, y: cy + 1 }]));
    }
  });

  it('con índice espacial: un ambiente limpio entre 200 000 segmentos cortos se resuelve al instante', () => {
    const rand = rng(11);
    const segs: number[] = [];
    const W = 2000;
    while (segs.length < 4 * 200_000) {
      const x = rand() * W;
      const y = rand() * W;
      // se deja libre la zona del ambiente
      if (x > 880 && x < 1120 && y > 880 && y < 1120) continue;
      segs.push(x, y, x + (rand() - 0.5) * 6, y + (rand() - 0.5) * 6);
    }
    for (const s of rect(900, 900, 1100, 1060)) segs.push(...s);
    const data = Float64Array.from(segs);
    // rejilla sencilla de 50 × 50
    const N = 50;
    const cell = W / N;
    const buckets: number[][] = Array.from({ length: N * N }, () => []);
    const clamp = (v: number) => Math.max(0, Math.min(N - 1, Math.floor(v / cell)));
    for (let i = 0; i < data.length / 4; i++) {
      for (let cx = clamp(Math.min(data[4 * i], data[4 * i + 2])); cx <= clamp(Math.max(data[4 * i], data[4 * i + 2])); cx++) {
        for (let cy = clamp(Math.min(data[4 * i + 1], data[4 * i + 3])); cy <= clamp(Math.max(data[4 * i + 1], data[4 * i + 3])); cy++) buckets[cy * N + cx].push(i);
      }
    }
    const query = (a: number, b: number, c: number, d: number): number[] => {
      const out = new Set<number>();
      for (let cx = clamp(a); cx <= clamp(c); cx++) for (let cy = clamp(b); cy <= clamp(d); cy++) for (const i of buckets[cy * N + cx]) out.add(i);
      return [...out];
    };
    const t0 = performance.now();
    const r = findRegion(data, { x: 1000, y: 1000 }, { eps: 1e-6, bounds: { minX: 0, minY: 0, maxX: W, maxY: W }, query });
    const ms = performance.now() - t0;
    if (!r.ok) throw new Error(r.reason);
    expect(r.area).toBe(200 * 160);
    expect(r.outer).toHaveLength(4);
    expect(ms).toBeLessThan(500);
  });

  it('arreglos aleatorios: el polígono devuelto es simple, con área positiva y contiene al punto', () => {
    const rand = rng(2026);
    let found = 0;
    for (let trial = 0; trial < 60; trial++) {
      const segs: Seg[] = rect(0, 0, 100, 100);
      const n = 30 + Math.floor(rand() * 30);
      for (let i = 0; i < n; i++) segs.push([rand() * 100, rand() * 100, rand() * 100, rand() * 100]);
      const data = pack(segs);
      for (let k = 0; k < 6; k++) {
        const p = { x: 1 + rand() * 98, y: 1 + rand() * 98 };
        const r = findRegion(data, p, { eps: 1e-7, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } });
        if (!r.ok) {
          expect(r.reason).toBe('on-edge');
          continue;
        }
        found++;
        expect(pointInPolygon(p, r.outer)).toBe(true);
        expect(polygonSignedArea(r.outer)).toBeGreaterThan(0);
        for (const h of r.holes) expect(pointInPolygon(p, h)).toBe(false);
        // simple: dos lados no consecutivos no se cruzan
        const m = r.outer.length;
        for (let i = 0; i < m; i++) {
          for (let j = i + 2; j < m; j++) {
            if (i === 0 && j === m - 1) continue;
            const hit = segmentIntersection(r.outer[i], r.outer[(i + 1) % m], r.outer[j], r.outer[(j + 1) % m], -1e-9);
            expect(hit, `prueba ${trial}`).toBeNull();
          }
        }
      }
    }
    expect(found).toBeGreaterThan(200);
  });
});
