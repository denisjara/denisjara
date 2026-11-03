/**
 * Simulación Monte Carlo del resto de temporada de una liga (o fase liga).
 *
 *  - Cada partido pendiente se simula con goles Poisson independientes (λ del modelo para ese cruce).
 *  - Se parte de los puntos, diferencia de goles y goles a favor actuales de la clasificación.
 *  - Desempates: puntos > diferencia de goles > goles a favor > sorteo aleatorio (por iteración).
 *  - PRNG con semilla (mulberry32) → resultados reproducibles.
 *  - Zonas: rangos de puesto 1-based inclusivos; negativos cuentan desde abajo (-3..-1 = tres últimos).
 *
 * Rendimiento: las CDF de Poisson de cada partido se precalculan una vez; muestreo por inversión con búsqueda
 * lineal (λ ~ 1.5 → ~2 comparaciones). 10.000 iteraciones × 200 partidos ≈ 0.2 s.
 */
import type { SeasonSimulation, SeasonSimulationRow, StandingGroup } from '../../src/types/data';
import { mulberry32, poissonPmf, round } from '../../src/lib/models';

export interface SimulationZone {
  label: string;
  from: number;
  to: number;
}

export interface SimulationInput {
  group: StandingGroup;
  remaining: { home: string; away: string; neutral?: boolean }[];
  lambdas: (home: string, away: string) => { lambdaHome: number; lambdaAway: number };
  zones: SimulationZone[];
  iterations: number;
  seed: number;
}

/** Goles máximos por equipo en la CDF (la cola se pliega en el último valor). */
const MAX_GOALS = 12;

function poissonCdfTable(lambda: number): Float64Array {
  const l = Number.isFinite(lambda) && lambda > 0 ? Math.min(lambda, 10) : 0.01;
  const cdf = new Float64Array(MAX_GOALS + 1);
  let s = 0;
  for (let k = 0; k <= MAX_GOALS; k++) {
    s += poissonPmf(k, l);
    cdf[k] = s;
  }
  cdf[MAX_GOALS] = 1;
  return cdf;
}

function sampleFromCdf(cdf: Float64Array, u: number): number {
  let k = 0;
  while (u > cdf[k]) k++;
  return k;
}

/** Convierte una zona (con índices negativos desde abajo) a puestos 1-based [from, to] dentro de 1..n. */
export function resolveZone(zone: { from: number; to: number }, n: number): [number, number] {
  const conv = (x: number) => (x < 0 ? n + x + 1 : x);
  let a = Math.min(n, Math.max(1, conv(zone.from)));
  let b = Math.min(n, Math.max(1, conv(zone.to)));
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

export function simulateSeason(input: SimulationInput): SeasonSimulation {
  const rows = input.group.rows;
  const n = rows.length;
  const iterations = Math.max(1, Math.floor(input.iterations));
  const columns = input.zones.map((z) => z.label);
  const index = new Map(rows.map((r, i) => [r.team.id, i]));

  // partidos válidos (ambos equipos en la tabla) con CDF precalculadas
  const mh: number[] = [];
  const ma: number[] = [];
  const cdfH: Float64Array[] = [];
  const cdfA: Float64Array[] = [];
  for (const m of input.remaining) {
    const h = index.get(m.home);
    const a = index.get(m.away);
    if (h === undefined || a === undefined || h === a) continue;
    const l = input.lambdas(m.home, m.away);
    mh.push(h);
    ma.push(a);
    cdfH.push(poissonCdfTable(l.lambdaHome));
    cdfA.push(poissonCdfTable(l.lambdaAway));
  }
  const M = mh.length;

  const basePts = new Int32Array(n);
  const baseGd = new Int32Array(n);
  const baseGf = new Int32Array(n);
  rows.forEach((r, i) => {
    basePts[i] = r.points;
    baseGd[i] = r.gd;
    baseGf[i] = r.gf;
  });

  const rng = mulberry32(input.seed >>> 0);
  const pts = new Int32Array(n);
  const gd = new Int32Array(n);
  const gf = new Int32Array(n);
  const tie = new Float64Array(n);
  const order = Array.from({ length: n }, (_, i) => i);
  const rankCount = Array.from({ length: n }, () => new Float64Array(n));
  const pointsSum = new Float64Array(n);
  const rankSum = new Float64Array(n);
  const cmp = (x: number, y: number) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x] || tie[x] - tie[y];

  for (let it = 0; it < iterations; it++) {
    pts.set(basePts);
    gd.set(baseGd);
    gf.set(baseGf);
    for (let k = 0; k < M; k++) {
      const h = mh[k];
      const a = ma[k];
      const hg = sampleFromCdf(cdfH[k], rng());
      const ag = sampleFromCdf(cdfA[k], rng());
      gf[h] += hg;
      gf[a] += ag;
      gd[h] += hg - ag;
      gd[a] += ag - hg;
      if (hg > ag) pts[h] += 3;
      else if (hg < ag) pts[a] += 3;
      else {
        pts[h] += 1;
        pts[a] += 1;
      }
    }
    for (let i = 0; i < n; i++) tie[i] = rng();
    order.sort(cmp);
    for (let r = 0; r < n; r++) {
      const t = order[r];
      rankCount[t][r]++;
      rankSum[t] += r + 1;
      pointsSum[t] += pts[t];
    }
  }

  const zones = input.zones.map((z) => resolveZone(z, n));
  const out: SeasonSimulationRow[] = rows.map((r, i) => {
    const dist = Array.from(rankCount[i], (c) => c / iterations);
    const probs: Record<string, number> = {};
    input.zones.forEach((z, k) => {
      const [from, to] = zones[k];
      let s = 0;
      for (let p = from; p <= to; p++) s += dist[p - 1];
      probs[z.label] = round(s, 4);
    });
    return {
      team: r.team,
      currentPoints: r.points,
      expectedPoints: round(pointsSum[i] / iterations, 1),
      expectedRank: round(rankSum[i] / iterations, 2),
      probs,
      positionDist: dist.map((p) => round(p, 4)),
    };
  });
  out.sort((x, y) => x.expectedRank - y.expectedRank || y.expectedPoints - x.expectedPoints);
  return { iterations, group: input.group.name, columns, rows: out, remainingMatches: M };
}
