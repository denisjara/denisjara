import { describe, expect, it } from 'vitest';
import {
  arcFromBulge,
  arcsToBeziers,
  arcToVertices,
  bezierLength,
  closestOnSegment,
  ellipseToVertices,
  flattenPart,
  matApply,
  matInvert,
  matMul,
  partArea,
  partBBox,
  partLength,
  partSignedArea,
  pointInPolygon,
  polygonLabelPoint,
  polygonSignedArea,
  segmentIntersection,
  transformPart,
  type Mat,
  type Part,
} from '../src/core/geometry';

const close = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));

describe('rectas', () => {
  it('rectángulo 4 × 3: perímetro 14 y área 12 exactos', () => {
    const r: Part = { v: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }], closed: true };
    expect(partLength(r)).toBe(14);
    expect(partArea(r)).toBe(12);
  });
  it('polilínea abierta: suma de tramos; el área usa el cierre recto', () => {
    const p: Part = { v: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }] };
    expect(partLength(p)).toBe(7);
    expect(partArea(p)).toBe(6);
  });
  it('forma en L', () => {
    const l: Part = { v: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 5 }, { x: 0, y: 5 }], closed: true };
    expect(partArea(l)).toBe(6 * 2 + 2 * 3);
    expect(partLength(l)).toBe(22);
  });
});

describe('arcos (bulge)', () => {
  it('círculo de radio 2,5 como dos semicírculos', () => {
    const c: Part = { v: [{ x: -2.5, y: 0, b: 1 }, { x: 2.5, y: 0, b: 1 }], closed: true };
    close(partLength(c), 2 * Math.PI * 2.5);
    close(partArea(c), Math.PI * 2.5 * 2.5);
  });
  it('círculo en cuartos con arcToVertices', () => {
    const v = arcToVertices(10, -4, 3, 0.3, 2 * Math.PI);
    v.pop();
    v[v.length - 1].b = Math.tan(Math.PI / 8);
    const c: Part = { v, closed: true };
    close(partLength(c), 2 * Math.PI * 3);
    close(partArea(c), Math.PI * 9);
  });
  it('arco de 60° y su centro', () => {
    const r = 5;
    const a = { x: r, y: 0 };
    const b = { x: r * Math.cos(Math.PI / 3), y: r * Math.sin(Math.PI / 3) };
    const bulge = Math.tan(Math.PI / 3 / 4);
    close(partLength({ v: [{ ...a, b: bulge }, b] }), (r * Math.PI) / 3);
    const arc = arcFromBulge(a, b, bulge)!;
    close(arc.cx, 0, 1e-12);
    close(arc.cy, 0, 1e-12);
    close(arc.r, r);
    // sentido contrario: mismo largo, centro al otro lado
    const arc2 = arcFromBulge(a, b, -bulge)!;
    close(arc2.r, r);
    expect(Math.hypot(arc2.cx, arc2.cy)).toBeGreaterThan(1);
  });
  it('sector circular: área = r²θ/2', () => {
    const r = 4;
    const th = 1.1;
    const sector: Part = { v: [{ x: 0, y: 0 }, { x: r, y: 0, b: Math.tan(th / 4) }, { x: r * Math.cos(th), y: r * Math.sin(th) }], closed: true };
    close(partArea(sector), (r * r * th) / 2);
    close(partLength(sector), 2 * r + r * th);
  });
  it('la teselación converge a la longitud y al área analíticas', () => {
    const c: Part = { v: [{ x: 0, y: 0, b: 0.7 }, { x: 10, y: 0, b: -0.3 }, { x: 10, y: 8 }, { x: 0, y: 8, b: 1.4 }], closed: true };
    const poly = flattenPart(c, 1e-7);
    let len = 0;
    for (let i = 0; i < poly.length; i++) len += Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].y - poly[i].y);
    close(len, partLength(c), 1e-6);
    close(Math.abs(polygonSignedArea(poly)), partArea(c), 1e-6);
  });
});

describe('Bézier', () => {
  it('una Bézier que es una recta mide lo que la recta', () => {
    close(bezierLength(0, 0, 1, 1, 2, 2, 3, 3), Math.hypot(3, 3));
  });
  it('área y longitud de un anillo con curvas frente a su teselación fina', () => {
    const ring: Part = {
      v: [
        { x: 0, y: 0, c: [3, -2, 7, 2] },
        { x: 10, y: 0 },
        { x: 10, y: 6, c: [8, 9, 3, 9] },
        { x: 0, y: 6 },
      ],
      closed: true,
    };
    const poly = flattenPart(ring, 1e-8);
    let len = 0;
    for (let i = 0; i < poly.length; i++) len += Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].y - poly[i].y);
    close(partLength(ring), len, 1e-7);
    close(partSignedArea(ring), polygonSignedArea(poly), 1e-7);
  });
  it('arcsToBeziers conserva longitud y área con error relativo < 1e-6', () => {
    const c: Part = { v: [{ x: -3, y: 0, b: 1 }, { x: 3, y: 0, b: 1 }], closed: true };
    const bz = arcsToBeziers(c);
    expect(bz.v.every((p) => p.c)).toBe(true);
    close(partLength(bz), partLength(c), 1e-6);
    close(partArea(bz), partArea(c), 1e-6);
  });
  it('elipse de semiejes 5 y 3: área πab', () => {
    const v = ellipseToVertices(2, 1, 5, 0, 0, 3, 0, 2 * Math.PI);
    v.pop();
    const e: Part = { v, closed: true };
    close(partArea(e), Math.PI * 15, 1e-6);
    // perímetro por la serie de Ramanujan (≈ 25,527)
    const h = ((5 - 3) / (5 + 3)) ** 2;
    close(partLength(e), Math.PI * 8 * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), 1e-5);
  });
});

describe('transformaciones', () => {
  const part: Part = { v: [{ x: 0, y: 0, b: 0.5 }, { x: 4, y: 0 }, { x: 4, y: 3, c: [3, 5, 1, 5] }, { x: 0, y: 3 }], closed: true };
  it('una semejanza escala longitudes por k y áreas por k²', () => {
    const k = 2.5;
    const ang = 0.7;
    const m: Mat = [k * Math.cos(ang), k * Math.sin(ang), -k * Math.sin(ang), k * Math.cos(ang), 11, -7];
    const t = transformPart(part, m);
    close(partLength(t), partLength(part) * k);
    close(partArea(t), partArea(part) * k * k);
  });
  it('una reflexión conserva longitud y área (invierte el bulge)', () => {
    const t = transformPart(part, [1, 0, 0, -1, 0, 100]);
    close(partLength(t), partLength(part));
    close(partArea(t), partArea(part));
    expect(t.v[0].b).toBe(-0.5);
  });
  it('escala no uniforme: el área se multiplica por sx·sy', () => {
    const t = transformPart(part, [2, 0, 0, 3, 0, 0]);
    close(partArea(t), partArea(part) * 6, 1e-6);
    expect(t.v.some((p) => p.b)).toBe(false);
  });
  it('matMul / matInvert / matApply', () => {
    const a: Mat = [2, 0, 0, 2, 5, 6];
    const b: Mat = [0, 1, -1, 0, 3, 4];
    const ab = matMul(a, b);
    const p = matApply(ab, 1, 2);
    const q = matApply(a, matApply(b, 1, 2).x, matApply(b, 1, 2).y);
    close(p.x, q.x);
    close(p.y, q.y);
    const inv = matInvert(ab)!;
    const back = matApply(inv, p.x, p.y);
    close(back.x, 1);
    close(back.y, 2);
  });
});

describe('utilidades', () => {
  it('intersección y punto más cercano', () => {
    const i = segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 })!;
    close(i.x, 2);
    close(i.y, 2);
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeNull();
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: -1 }, { x: 2, y: 1 })).toBeNull();
    const c = closestOnSegment({ x: 2, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(c).toEqual({ x: 2, y: 0, t: 0.2 });
  });
  it('punto en polígono y punto de rótulo dentro de una U', () => {
    const u = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 8, y: 10 }, { x: 8, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 10 }, { x: 0, y: 10 }];
    expect(pointInPolygon({ x: 5, y: 5 }, u)).toBe(false);
    expect(pointInPolygon({ x: 1, y: 5 }, u)).toBe(true);
    expect(pointInPolygon(polygonLabelPoint(u), u)).toBe(true);
  });
  it('caja envolvente con arcos', () => {
    const c: Part = { v: [{ x: -1, y: 0, b: 1 }, { x: 1, y: 0, b: 1 }], closed: true };
    const b = partBBox(c);
    close(b.minY, -1, 1e-4);
    close(b.maxY, 1, 1e-4);
  });
});
